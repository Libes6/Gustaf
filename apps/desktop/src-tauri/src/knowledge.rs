//! Knowledge base: named collections of user-picked folders and files, indexed with the same embeddings stack as the
//! project semantic search (`semantic.rs`: provider config, `embed`, cosine). Everything lives in app data:
//! `<app data>/knowledge/<collection id>/{manifest.json,index.json}`; nothing is written to the picked folders.
//! Indexing is opt-in per collection (the first run needs `confirm`), because it sends text to the embeddings endpoint.
use crate::semantic::{cosine, embed, endpoint, excluded, index_lock, split as split_lines, Config};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const INDEX_VERSION: u32 = 1;
const MAX_COLLECTIONS: usize = 50;
const MAX_SOURCES: usize = 50;
const MAX_GLOBS: usize = 40;
const MAX_ISSUES: usize = 200;
const WALK_ENTRY_CAP: usize = 200_000;
const INDEX_READ_CAP: u64 = 600_000_000;
/// Embedding batch size (same as the project index).
const BATCH: usize = 16;
/// A chunk grows to about this many characters before the next paragraph starts a new one.
const CHUNK_TARGET: usize = 1200;
/// A single paragraph or line longer than this is cut.
const CHUNK_MAX: usize = 1800;
const PDF_TIMEOUT: Duration = Duration::from_secs(30);
const PDF_OUTPUT_CAP: u64 = 20_000_000;
const HIT_TEXT_CHARS: usize = 1500;

pub const DEFAULT_INCLUDE: &[&str] = &["**/*.md", "**/*.markdown", "**/*.txt", "**/*.rst", "**/*.pdf"];

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    pub max_files: usize,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_pdf_bytes: u64,
    pub max_chunks: usize,
}
impl Default for Caps {
    fn default() -> Self {
        Caps { max_files: 2000, max_file_bytes: 5_000_000, max_total_bytes: 200_000_000, max_pdf_bytes: 25_000_000, max_chunks: 20_000 }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Source {
    pub path: String,
    /// `"folder"` or `"file"`.
    pub kind: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Issue {
    pub path: String,
    pub reason: String,
}

#[derive(Clone, Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Status {
    /// `"new"` (never indexed), `"ready"`, `"stale"` (sources or options changed since the last index), `"partial"` (cancelled or failed).
    pub state: String,
    pub files: usize,
    pub chunks: usize,
    pub bytes: u64,
    pub indexed_at: Option<u64>,
    pub issues: Vec<Issue>,
    pub warnings: Vec<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub sources: Vec<Source>,
    pub include: Vec<String>,
    pub caps: Caps,
    pub config: Config,
    pub created_at: u64,
    /// Set when the user confirmed that indexing sends text to the embeddings endpoint.
    pub consented_at: Option<u64>,
    pub status: Status,
    /// Runtime only: an index run is in progress.
    #[serde(default)]
    pub indexing: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct KChunk {
    start: usize,
    end: usize,
    heading: Option<String>,
    text: String,
    hash: String,
    vector: Vec<f32>,
}
#[derive(Clone, Serialize, Deserialize)]
struct FileEntry {
    source: String,
    display: String,
    mtime: u64,
    size: u64,
    hash: String,
    chunks: Vec<KChunk>,
}
impl FileEntry {
    fn embedded(&self) -> bool {
        self.chunks.iter().all(|c| !c.vector.is_empty())
    }
}
#[derive(Serialize, Deserialize)]
struct Index {
    version: u32,
    config: Config,
    files: BTreeMap<String, FileEntry>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub files: usize,
    pub chunks: usize,
    pub embedded: usize,
    pub reused: usize,
    pub unchanged_files: usize,
    pub skipped: usize,
    pub cancelled: bool,
    pub issues: Vec<Issue>,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub files: usize,
    pub pdfs: usize,
    pub bytes: u64,
    pub skipped: usize,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    /// `"scan"`, `"embed"`, `"done"`, `"cancelled"` or `"error"`.
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub file: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub collection_id: String,
    pub collection: String,
    /// Citation path: `<folder name>/<relative path>` for folder sources, the file name for single files.
    pub source: String,
    pub path: String,
    pub heading: Option<String>,
    pub start: usize,
    pub end: usize,
    pub score: f32,
    pub text: String,
}

pub type PdfExtractor = fn(&Path) -> Result<Vec<String>, String>;

// ---------------------------------------------------------------------------------------------------------------------
// Small helpers

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
/// Stable 64-bit FNV-1a (unlike `DefaultHasher` it does not change between Rust versions, so cached vectors stay valid).
fn fnv(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}
fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}
fn coll_dir(store: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid collection id".into());
    }
    Ok(store.join(id))
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}
fn mtime_nanos(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0)
}
fn with_lock<T>(path: &Path, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let lock = index_lock(path)?;
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    f()
}

fn globs(patterns: &[String]) -> Result<GlobSet, String> {
    if patterns.is_empty() {
        return Err("Add at least one include pattern".into());
    }
    if patterns.len() > MAX_GLOBS {
        return Err(format!("At most {MAX_GLOBS} include patterns"));
    }
    let mut builder = GlobSetBuilder::new();
    for p in patterns {
        let p = p.trim();
        if p.is_empty() || p.len() > 200 {
            return Err("Include patterns must be 1-200 characters".into());
        }
        builder.add(GlobBuilder::new(p).case_insensitive(true).build().map_err(|e| format!("Invalid pattern {p}: {e}"))?);
    }
    builder.build().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------------------------------
// Manifest storage and lifecycle

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join("manifest.json")
}
fn index_path(dir: &Path) -> PathBuf {
    dir.join("index.json")
}
fn read_manifest(dir: &Path) -> Result<Collection, String> {
    let bytes = std::fs::read(manifest_path(dir)).map_err(|_| "Collection not found".to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Collection manifest is damaged: {e}"))
}
fn write_manifest(dir: &Path, c: &Collection) -> Result<(), String> {
    write_private(&manifest_path(dir), &serde_json::to_vec_pretty(c).map_err(|e| e.to_string())?)
}
/// Read-modify-write of the manifest under its own lock, so a status update from an index run cannot lose a rename.
fn update_manifest(dir: &Path, f: impl FnOnce(&mut Collection) -> Result<(), String>) -> Result<Collection, String> {
    with_lock(&dir.join("manifest-lock"), || {
        let mut c = read_manifest(dir)?;
        f(&mut c)?;
        write_manifest(dir, &c)?;
        Ok(c)
    })
}
fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("Collection name must be 1-80 characters".into());
    }
    Ok(name.to_string())
}
fn mark_stale(c: &mut Collection) {
    if c.status.state == "ready" {
        c.status.state = "stale".into();
    }
}

pub fn create(store: &Path, name: &str, config: Config, include: Option<Vec<String>>) -> Result<Collection, String> {
    let name = clean_name(name)?;
    endpoint(&config)?;
    let include = include.filter(|v| !v.is_empty()).unwrap_or_else(|| DEFAULT_INCLUDE.iter().map(|s| s.to_string()).collect());
    globs(&include)?;
    if list(store)?.len() >= MAX_COLLECTIONS {
        return Err(format!("At most {MAX_COLLECTIONS} collections"));
    }
    let c = Collection {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        sources: vec![],
        include: include.into_iter().map(|s| s.trim().to_string()).collect(),
        caps: Caps::default(),
        config,
        created_at: now(),
        consented_at: None,
        status: Status { state: "new".into(), ..Default::default() },
        indexing: false,
    };
    write_manifest(&coll_dir(store, &c.id)?, &c)?;
    Ok(c)
}

pub fn list(store: &Path) -> Result<Vec<Collection>, String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(store) else { return Ok(out) };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if let Ok(c) = read_manifest(&entry.path()) {
            out.push(c);
        }
    }
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

pub fn rename(store: &Path, id: &str, name: &str) -> Result<Collection, String> {
    let name = clean_name(name)?;
    update_manifest(&coll_dir(store, id)?, |c| {
        c.name = name;
        Ok(())
    })
}

pub fn delete(store: &Path, id: &str) -> Result<(), String> {
    let dir = coll_dir(store, id)?;
    with_lock(&dir, || {
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}

/// A user-picked source must exist, must not be a filesystem root, the home folder itself, or our own storage.
fn resolve_source(store: &Path, path: &str) -> Result<Source, String> {
    let real = Path::new(path).canonicalize().map_err(|e| format!("Cannot open {path}: {e}"))?;
    if real.parent().is_none() {
        return Err("Pick a folder or file, not the filesystem root".into());
    }
    if dirs::home_dir().and_then(|h| h.canonicalize().ok()).is_some_and(|h| h == real) {
        return Err("Pick a folder inside your home folder, not the home folder itself".into());
    }
    if store.canonicalize().map(|s| real.starts_with(&s)).unwrap_or(false) {
        return Err("The knowledge base storage cannot be indexed".into());
    }
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    let kind = if meta.is_dir() {
        "folder"
    } else if meta.is_file() {
        "file"
    } else {
        return Err("Only folders and regular files can be added".into());
    };
    if kind == "file" && real.file_name().and_then(|s| s.to_str()).is_some_and(|n| excluded(Path::new(n))) {
        return Err("This file looks like a secret or generated file and is never indexed".into());
    }
    Ok(Source { path: real.to_string_lossy().into_owned(), kind: kind.into() })
}

pub fn add_source(store: &Path, id: &str, path: &str) -> Result<Collection, String> {
    let source = resolve_source(store, path)?;
    update_manifest(&coll_dir(store, id)?, |c| {
        if c.sources.iter().any(|s| s.path == source.path) {
            return Ok(());
        }
        if c.sources.len() >= MAX_SOURCES {
            return Err(format!("At most {MAX_SOURCES} sources per collection"));
        }
        c.sources.push(source);
        mark_stale(c);
        Ok(())
    })
}

pub fn remove_source(store: &Path, id: &str, path: &str) -> Result<Collection, String> {
    let dir = coll_dir(store, id)?;
    let requested = path.to_string();
    let real = Path::new(path).canonicalize().ok().map(|p| p.to_string_lossy().into_owned());
    let removed = update_manifest(&dir, |c| {
        let before = c.sources.len();
        c.sources.retain(|s| s.path != requested && Some(&s.path) != real.as_ref());
        if c.sources.len() == before {
            return Err("Source not found in this collection".into());
        }
        mark_stale(c);
        Ok(())
    })?;
    // Drop the vectors of the removed source right away instead of waiting for the next index run.
    with_lock(&dir, || {
        if let Some(mut index) = read_index(&dir) {
            let keep: HashSet<&String> = removed.sources.iter().map(|s| &s.path).collect();
            let before = index.files.len();
            index.files.retain(|_, f| keep.contains(&f.source));
            if index.files.len() != before {
                save_index(&dir, &index)?;
            }
        }
        Ok(())
    })?;
    update_manifest(&dir, |c| {
        if let Some(index) = read_index(&dir) {
            c.status.files = index.files.len();
            c.status.chunks = index.files.values().map(|f| f.chunks.len()).sum();
        }
        Ok(())
    })
}

pub fn set_include(store: &Path, id: &str, include: Vec<String>) -> Result<Collection, String> {
    globs(&include)?;
    update_manifest(&coll_dir(store, id)?, |c| {
        c.include = include.iter().map(|s| s.trim().to_string()).collect();
        mark_stale(c);
        Ok(())
    })
}

/// A new embeddings provider or model invalidates the vectors and the consent (text goes to a different endpoint).
pub fn set_config(store: &Path, id: &str, config: Config) -> Result<Collection, String> {
    endpoint(&config)?;
    update_manifest(&coll_dir(store, id)?, |c| {
        if c.config != config {
            c.config = config;
            c.consented_at = None;
            c.status.state = if c.status.indexed_at.is_some() { "stale".into() } else { "new".into() };
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// Index file (private JSON vector cache) with a small in-memory cache for searches

fn read_index(dir: &Path) -> Option<Index> {
    let path = index_path(dir);
    if std::fs::metadata(&path).ok()?.len() > INDEX_READ_CAP {
        return None;
    }
    let index: Index = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    (index.version == INDEX_VERSION).then_some(index)
}
fn save_index(dir: &Path, index: &Index) -> Result<(), String> {
    write_private(&index_path(dir), &serde_json::to_vec(index).map_err(|e| e.to_string())?)
}

type CacheEntry = (SystemTime, u64, Arc<Index>);
static INDEX_CACHE: OnceLock<Mutex<HashMap<PathBuf, CacheEntry>>> = OnceLock::new();
fn cached_index(dir: &Path) -> Option<Arc<Index>> {
    let path = index_path(dir);
    let meta = std::fs::metadata(&path).ok()?;
    let stamp = (meta.modified().ok()?, meta.len());
    let cache = INDEX_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((m, l, i)) = cache.lock().ok()?.get(&path) {
        if (*m, *l) == stamp {
            return Some(i.clone());
        }
    }
    let index = Arc::new(read_index(dir)?);
    let mut guard = cache.lock().ok()?;
    if guard.len() >= 3 {
        guard.clear();
    }
    guard.insert(path, (stamp.0, stamp.1, index.clone()));
    Some(index)
}

// ---------------------------------------------------------------------------------------------------------------------
// Discovery: which files a collection covers

struct Found {
    abs: PathBuf,
    source: String,
    display: String,
    size: u64,
    mtime: u64,
    pdf: bool,
}
struct Discovery {
    files: Vec<Found>,
    issues: Vec<Issue>,
    warnings: Vec<String>,
    missing_sources: HashSet<String>,
}

fn is_pdf(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}
fn push_issue(issues: &mut Vec<Issue>, path: impl Into<String>, reason: impl Into<String>) {
    if issues.len() < MAX_ISSUES {
        issues.push(Issue { path: path.into(), reason: reason.into() });
    }
}
fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_000_000.0)
}

fn discover(c: &Collection) -> Result<Discovery, String> {
    let include = globs(&c.include)?;
    let mut d = Discovery { files: vec![], issues: vec![], warnings: vec![], missing_sources: HashSet::new() };
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut total = 0u64;
    'sources: for source in &c.sources {
        let root = match Path::new(&source.path).canonicalize() {
            Ok(r) => r,
            Err(_) => {
                d.missing_sources.insert(source.path.clone());
                push_issue(&mut d.issues, &source.path, "Source not found (kept as indexed earlier)");
                continue;
            }
        };
        let root_name = root.file_name().and_then(|s| s.to_str()).unwrap_or("source").to_string();
        // Candidate list for this source: (absolute path, citation path).
        let mut candidates: Vec<(PathBuf, String)> = vec![];
        if source.kind == "file" {
            if !root.is_file() {
                d.missing_sources.insert(source.path.clone());
                push_issue(&mut d.issues, &source.path, "Source is no longer a file");
                continue;
            }
            candidates.push((root.clone(), root_name.clone()));
        } else {
            if !root.is_dir() {
                d.missing_sources.insert(source.path.clone());
                push_issue(&mut d.issues, &source.path, "Source is no longer a folder");
                continue;
            }
            let base = root.clone();
            let walk = WalkBuilder::new(&root)
                .follow_links(false)
                .require_git(false)
                .sort_by_file_path(|a, b| a.cmp(b))
                .filter_entry(move |e| e.depth() == 0 || e.path().strip_prefix(&base).is_ok_and(|p| !excluded(p)))
                .build();
            for (visited, entry) in walk.enumerate() {
                if visited >= WALK_ENTRY_CAP {
                    d.warnings.push(format!("Folder {root_name} has more than {WALK_ENTRY_CAP} entries; the rest was not scanned"));
                    break;
                }
                let Ok(entry) = entry else { continue };
                let Ok(rel) = entry.path().strip_prefix(&root) else { continue };
                if rel.as_os_str().is_empty() {
                    continue;
                }
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if entry.path_is_symlink() {
                    if include.is_match(&rel_str) {
                        push_issue(&mut d.issues, format!("{root_name}/{rel_str}"), "Symbolic link not followed");
                    }
                    continue;
                }
                if !entry.file_type().is_some_and(|t| t.is_file()) || !include.is_match(&rel_str) {
                    continue;
                }
                // Belt and braces: whatever the walker yielded must still resolve inside the picked folder.
                match entry.path().canonicalize() {
                    Ok(real) if real.starts_with(&root) => candidates.push((real, format!("{root_name}/{rel_str}"))),
                    _ => push_issue(&mut d.issues, format!("{root_name}/{rel_str}"), "Resolves outside the picked folder"),
                }
            }
        }
        for (abs, display) in candidates {
            if !seen.insert(abs.clone()) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&abs) else {
                push_issue(&mut d.issues, &display, "Cannot read file metadata");
                continue;
            };
            let pdf = is_pdf(&abs);
            let cap = if pdf { c.caps.max_pdf_bytes } else { c.caps.max_file_bytes };
            if meta.len() > cap {
                push_issue(&mut d.issues, &display, format!("Larger than {} (limit for {})", mb(cap), if pdf { "PDF files" } else { "a file" }));
                continue;
            }
            if d.files.len() >= c.caps.max_files {
                d.warnings.push(format!("File limit reached ({} files); the remaining files were not indexed", c.caps.max_files));
                break 'sources;
            }
            if total + meta.len() > c.caps.max_total_bytes {
                d.warnings.push(format!("Size limit reached ({}); the remaining files were not indexed", mb(c.caps.max_total_bytes)));
                break 'sources;
            }
            total += meta.len();
            d.files.push(Found { abs, source: source.path.clone(), display, size: meta.len(), mtime: mtime_nanos(&meta), pdf });
        }
    }
    Ok(d)
}

pub fn estimate(store: &Path, id: &str) -> Result<Estimate, String> {
    let c = read_manifest(&coll_dir(store, id)?)?;
    let d = discover(&c)?;
    Ok(Estimate { files: d.files.len(), pdfs: d.files.iter().filter(|f| f.pdf).count(), bytes: d.files.iter().map(|f| f.size).sum(), skipped: d.issues.len(), warnings: d.warnings })
}

// ---------------------------------------------------------------------------------------------------------------------
// Chunking

struct Raw {
    start: usize,
    end: usize,
    heading: Option<String>,
    text: String,
}

/// Greedy paragraph packing. `lines` are (1-based line number, text); paragraphs are separated by blank lines.
fn pack(lines: &[(usize, &str)], heading: &Option<String>, out: &mut Vec<Raw>) {
    // Split into paragraphs of non-blank lines, cutting overlong paragraphs and lines.
    let mut paragraphs: Vec<Vec<(usize, String)>> = vec![];
    let mut current: Vec<(usize, String)> = vec![];
    let mut size = 0usize;
    for (no, line) in lines {
        if line.trim().is_empty() {
            if !current.is_empty() {
                paragraphs.push(std::mem::take(&mut current));
                size = 0;
            }
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        for piece in chars.chunks(CHUNK_MAX) {
            let piece: String = piece.iter().collect();
            if !current.is_empty() && size + piece.chars().count() > CHUNK_MAX {
                paragraphs.push(std::mem::take(&mut current));
                size = 0;
            }
            size += piece.chars().count() + 1;
            current.push((*no, piece));
        }
    }
    if !current.is_empty() {
        paragraphs.push(current);
    }
    let mut group: Vec<&Vec<(usize, String)>> = vec![];
    let mut group_size = 0usize;
    let flush = |group: &mut Vec<&Vec<(usize, String)>>, out: &mut Vec<Raw>| {
        if group.is_empty() {
            return;
        }
        let start = group[0][0].0;
        let last = group.last().unwrap();
        let end = last.last().unwrap().0;
        let mut text = String::new();
        let mut previous: Option<usize> = None;
        for p in group.iter() {
            if previous.is_some() {
                text.push_str("\n\n");
            }
            text.push_str(&p.iter().map(|(_, l)| l.as_str()).collect::<Vec<_>>().join("\n"));
            previous = Some(p.last().unwrap().0);
        }
        out.push(Raw { start, end, heading: heading.clone(), text });
        group.clear();
    };
    for p in &paragraphs {
        let len: usize = p.iter().map(|(_, l)| l.chars().count() + 1).sum();
        if !group.is_empty() && group_size + len > CHUNK_TARGET {
            flush(&mut group, out);
            group_size = 0;
        }
        group_size += len;
        group.push(p);
    }
    flush(&mut group, out);
}

fn heading_of(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let level = trimmed.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &trimmed[level..];
    if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let title = rest.trim().trim_end_matches('#').trim();
    (!title.is_empty()).then(|| (level, title.chars().take(200).collect()))
}

/// Markdown: one section per heading; the heading path (`A > B`) is kept as the citation. Fenced code does not start sections.
fn chunk_markdown(text: &str) -> Vec<Raw> {
    let mut out = vec![];
    let mut stack: Vec<(usize, String)> = vec![];
    let mut section: Vec<(usize, &str)> = vec![];
    let mut path: Option<String> = None;
    let mut fence: Option<String> = None;
    let finish = |section: &mut Vec<(usize, &str)>, path: &Option<String>, out: &mut Vec<Raw>| {
        // A heading with nothing under it is not worth a chunk.
        let body = section.iter().skip(if path.is_some() { 1 } else { 0 }).any(|(_, l)| !l.trim().is_empty());
        if body {
            pack(section, path, out);
        }
        section.clear();
    };
    for (i, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        if let Some(marker) = &fence {
            if trimmed.starts_with(marker.as_str()) {
                fence = None;
            }
        } else if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fence = Some(trimmed[..3].to_string());
        } else if let Some((level, title)) = heading_of(line) {
            finish(&mut section, &path, &mut out);
            while stack.last().is_some_and(|(l, _)| *l >= level) {
                stack.pop();
            }
            stack.push((level, title));
            path = Some(stack.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>().join(" > ").chars().take(300).collect());
        }
        section.push((i + 1, line));
    }
    finish(&mut section, &path, &mut out);
    out
}

fn chunk_plain(text: &str) -> Vec<Raw> {
    let lines: Vec<(usize, &str)> = text.lines().enumerate().map(|(i, l)| (i + 1, l)).collect();
    let mut out = vec![];
    pack(&lines, &None, &mut out);
    out
}

fn chunk_pdf(pages: &[String]) -> Vec<Raw> {
    let mut out = vec![];
    for (i, page) in pages.iter().enumerate() {
        let lines: Vec<(usize, &str)> = page.lines().enumerate().map(|(n, l)| (n + 1, l)).collect();
        pack(&lines, &Some(format!("page {}", i + 1)), &mut out);
    }
    out
}

fn chunk_file(display: &str, text: &str) -> Vec<Raw> {
    let ext = Path::new(display).extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "md" | "markdown" => chunk_markdown(text),
        "txt" | "rst" | "text" => chunk_plain(text),
        // Source code and everything else: fixed line windows like the project index.
        _ => split_lines(display, text).into_iter().map(|c| Raw { start: c.start, end: c.end, heading: None, text: c.text }).collect(),
    }
}

fn embed_input(display: &str, raw: &Raw) -> String {
    match &raw.heading {
        Some(h) => format!("{display} § {h}\n\n{}", raw.text),
        None => format!("{display}\n\n{}", raw.text),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// PDF extraction (offline, pure Rust). The parser panics on some malformed files and the release profile aborts on panic,
// so production extracts in a child process (this same executable, see `pdf_child_main`) with a timeout.

/// Entry point for the extraction child: `<exe> --gustaf-pdf-extract <pdf> <out.json>`. Returns true when it handled the arguments.
pub fn pdf_child_main() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 || args[1] != "--gustaf-pdf-extract" {
        return false;
    }
    let result = match pdf_extract::extract_text_by_pages(&args[2]) {
        Ok(pages) => serde_json::json!({ "pages": pages }),
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    };
    let _ = std::fs::write(&args[3], result.to_string());
    true
}

pub fn extract_pdf_subprocess(path: &Path) -> Result<Vec<String>, String> {
    extract_pdf_with_exe(&std::env::current_exe().map_err(|e| e.to_string())?, path)
}

/// Runs the extraction child `exe` (the app binary) on one PDF.
pub fn extract_pdf_with_exe(exe: &Path, path: &Path) -> Result<Vec<String>, String> {
    let out = std::env::temp_dir().join(format!("gustaf-pdf-{}.json", uuid::Uuid::new_v4()));
    let mut child = std::process::Command::new(exe)
        .arg("--gustaf-pdf-extract")
        .arg(path)
        .arg(&out)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Cannot start PDF extraction: {e}"))?;
    let started = Instant::now();
    let finished = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() > PDF_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let result = (|| {
        let Some(status) = finished else { return Err(format!("PDF extraction timed out after {} s", PDF_TIMEOUT.as_secs())) };
        let mut bytes = Vec::new();
        match std::fs::File::open(&out) {
            Ok(f) => {
                f.take(PDF_OUTPUT_CAP + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            }
            Err(_) => return Err(format!("PDF extraction crashed ({status}); the file is probably malformed")),
        }
        if bytes.len() as u64 > PDF_OUTPUT_CAP {
            return Err("PDF text is larger than 20 MB".into());
        }
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if let Some(e) = value.get("error").and_then(|v| v.as_str()) {
            return Err(e.to_string());
        }
        serde_json::from_value(value.get("pages").cloned().unwrap_or_default()).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_file(&out);
    result
}

// ---------------------------------------------------------------------------------------------------------------------
// Indexing

pub struct Run<'a> {
    pub pdf: PdfExtractor,
    pub progress: &'a (dyn Fn(&Progress) + Sync),
    pub cancel: &'a AtomicBool,
}

fn read_text(path: &Path) -> Result<(String, String), String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let hash = fnv(&bytes);
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Err("Binary file".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "Not UTF-8 text".to_string())?;
    Ok((text.trim_start_matches('\u{feff}').to_string(), hash))
}

pub fn reindex(store: &Path, id: &str, confirm: bool, run: &Run) -> Result<Stats, String> {
    let dir = coll_dir(store, id)?;
    let lock = index_lock(&dir)?;
    let _guard = lock.try_lock().map_err(|_| "This collection is already being indexed".to_string())?;
    let mut c = read_manifest(&dir)?;
    endpoint(&c.config)?;
    if c.consented_at.is_none() {
        if !confirm {
            return Err("Confirm first: indexing sends the text of these files to the embeddings provider".into());
        }
        c = update_manifest(&dir, |c| {
            c.consented_at = Some(now());
            Ok(())
        })?;
    }
    let event = |phase: &str, done: usize, total: usize, file: Option<String>| (run.progress)(&Progress { id: id.to_string(), phase: phase.into(), done, total, file });

    let previous = read_index(&dir).filter(|i| i.config == c.config);
    // Vectors are reused per chunk (same text, same heading and file name), so moved text or renamed files cost nothing extra.
    let mut vectors: HashMap<String, Vec<f32>> = HashMap::new();
    if let Some(p) = &previous {
        for f in p.files.values() {
            for ch in &f.chunks {
                if !ch.vector.is_empty() {
                    vectors.entry(ch.hash.clone()).or_insert_with(|| ch.vector.clone());
                }
            }
        }
    }
    let mut old_files = previous.map(|p| p.files).unwrap_or_default();
    let found = discover(&c)?;
    let mut issues = found.issues;
    let mut warnings = found.warnings;
    let mut files: BTreeMap<String, FileEntry> = BTreeMap::new();
    let mut unchanged = 0usize;
    let mut reused = 0usize;
    let mut chunk_total = 0usize;
    let total_files = found.files.len();
    let mut cancelled = false;

    // Entries of sources that are currently missing (unplugged drive) stay as they were.
    for (key, entry) in old_files.iter() {
        if found.missing_sources.contains(&entry.source) {
            chunk_total += entry.chunks.len();
            files.insert(key.clone(), entry.clone());
        }
    }

    // An unchanged file keeps its entry; the chunk limit still applies to it.
    macro_rules! keep {
        ($key:expr, $entry:expr) => {{
            let entry: FileEntry = $entry;
            if chunk_total + entry.chunks.len() > c.caps.max_chunks {
                warnings.push(format!("Chunk limit reached ({} chunks); the remaining files were not indexed", c.caps.max_chunks));
                break;
            }
            chunk_total += entry.chunks.len();
            unchanged += 1;
            files.insert($key, entry);
            continue;
        }};
    }
    for (n, file) in found.files.iter().enumerate() {
        if run.cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        event("scan", n, total_files, Some(file.display.clone()));
        let key = file.abs.to_string_lossy().into_owned();
        let old = old_files.remove(&key);
        if let Some(o) = &old {
            if o.mtime == file.mtime && o.size == file.size && o.embedded() && o.display == file.display && o.source == file.source {
                keep!(key, o.clone());
            }
        }
        let (raw, hash) = if file.pdf {
            let bytes_hash = match std::fs::read(&file.abs) {
                Ok(b) => fnv(&b),
                Err(e) => {
                    push_issue(&mut issues, &file.display, e.to_string());
                    continue;
                }
            };
            if let Some(o) = &old {
                if o.hash == bytes_hash && o.embedded() {
                    let mut kept = o.clone();
                    kept.mtime = file.mtime;
                    kept.size = file.size;
                    keep!(key, kept);
                }
            }
            match (run.pdf)(&file.abs) {
                Ok(pages) => {
                    let raw = chunk_pdf(&pages);
                    if raw.is_empty() {
                        push_issue(&mut issues, &file.display, "No extractable text (scanned PDF? OCR is not supported)");
                        continue;
                    }
                    (raw, bytes_hash)
                }
                Err(e) => {
                    push_issue(&mut issues, &file.display, format!("PDF extraction failed: {e}"));
                    continue;
                }
            }
        } else {
            match read_text(&file.abs) {
                Ok((text, hash)) => {
                    if let Some(o) = &old {
                        if o.hash == hash && o.embedded() {
                            let mut kept = o.clone();
                            kept.mtime = file.mtime;
                            kept.size = file.size;
                            keep!(key, kept);
                        }
                    }
                    (chunk_file(&file.display, &text), hash)
                }
                Err(e) => {
                    push_issue(&mut issues, &file.display, e);
                    continue;
                }
            }
        };
        if chunk_total + raw.len() > c.caps.max_chunks {
            warnings.push(format!("Chunk limit reached ({} chunks); the remaining files were not indexed", c.caps.max_chunks));
            break;
        }
        chunk_total += raw.len();
        let chunks = raw
            .into_iter()
            .map(|r| {
                let h = fnv(embed_input(&file.display, &r).as_bytes());
                let vector = vectors.get(&h).cloned().unwrap_or_default();
                if !vector.is_empty() {
                    reused += 1;
                }
                KChunk { start: r.start, end: r.end, heading: r.heading, text: r.text, hash: h, vector }
            })
            .collect();
        files.insert(key, FileEntry { source: file.source.clone(), display: file.display.clone(), mtime: file.mtime, size: file.size, hash, chunks });
    }

    if cancelled {
        // Cancelled while scanning: files not reached yet keep their earlier entries instead of being dropped.
        for (k, v) in old_files {
            files.entry(k).or_insert(v);
        }
    }

    // Embed whatever still has no vector, batch by batch; a cancel or an error keeps what was already embedded.
    let pending: Vec<(String, usize)> = files.iter().flat_map(|(k, f)| f.chunks.iter().enumerate().filter(|(_, c)| c.vector.is_empty()).map(move |(i, _)| (k.clone(), i))).collect();
    let mut embedded = 0usize;
    let mut failure: Option<String> = None;
    if !cancelled {
        for batch in pending.chunks(BATCH) {
            event("embed", embedded, pending.len(), None);
            if run.cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            let input: Vec<String> = batch.iter().map(|(k, i)| embed_input(&files[k].display, &Raw { start: 0, end: 0, heading: files[k].chunks[*i].heading.clone(), text: files[k].chunks[*i].text.clone() })).collect();
            match embed(&c.config, &input) {
                Ok(vs) => {
                    for ((k, i), v) in batch.iter().zip(vs) {
                        files.get_mut(k).unwrap().chunks[*i].vector = v;
                    }
                    embedded += batch.len();
                }
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            }
        }
    }
    if failure.is_none() {
        let dims: HashSet<usize> = files.values().flat_map(|f| f.chunks.iter()).filter(|c| !c.vector.is_empty()).map(|c| c.vector.len()).collect();
        if dims.len() > 1 {
            failure = Some("Model embedding dimensions changed; create the collection again with the new model".into());
        }
    }
    let complete = failure.is_none() && !cancelled;
    if failure.as_deref().is_some_and(|e| e.contains("dimensions")) {
        // Do not persist a mixed-dimension index.
    } else {
        save_index(&dir, &Index { version: INDEX_VERSION, config: c.config.clone(), files: files.clone() })?;
    }
    let chunks: usize = files.values().map(|f| f.chunks.iter().filter(|c| !c.vector.is_empty()).count()).sum();
    let bytes: u64 = files.values().map(|f| f.size).sum();
    let stats = Stats { files: files.len(), chunks, embedded, reused, unchanged_files: unchanged, skipped: issues.len(), cancelled, issues: issues.clone(), warnings: warnings.clone() };
    let last_error = failure.clone();
    update_manifest(&dir, |m| {
        m.status = Status {
            state: if complete { "ready".into() } else { "partial".into() },
            files: stats.files,
            chunks,
            bytes,
            indexed_at: Some(now()),
            issues,
            warnings,
            last_error,
        };
        Ok(())
    })?;
    event(if cancelled { "cancelled" } else if failure.is_some() { "error" } else { "done" }, embedded, pending.len(), None);
    match failure {
        Some(e) => Err(e),
        None => Ok(stats),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Search

pub fn search(store: &Path, ids: &[String], query: &str, limit: usize) -> Result<Vec<Hit>, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 4000 {
        return Err("Query requires 1-4000 characters".into());
    }
    if ids.is_empty() || ids.len() > MAX_COLLECTIONS {
        return Err("Choose between 1 and 50 collections".into());
    }
    let mut seen = HashSet::new();
    let mut loaded: Vec<(Collection, Arc<Index>)> = vec![];
    for id in ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        let dir = coll_dir(store, id)?;
        let c = read_manifest(&dir).map_err(|_| format!("Knowledge collection {id} no longer exists"))?;
        if let Some(index) = cached_index(&dir) {
            if index.config == c.config {
                loaded.push((c, index));
            }
        }
    }
    // One query embedding per distinct embeddings configuration.
    let mut queries: HashMap<String, Vec<f32>> = HashMap::new();
    let mut hits: Vec<Hit> = vec![];
    for (c, index) in &loaded {
        let key = serde_json::to_string(&c.config).map_err(|e| e.to_string())?;
        if !queries.contains_key(&key) {
            if !index.files.values().any(|f| f.chunks.iter().any(|ch| !ch.vector.is_empty())) {
                continue;
            }
            let v = embed(&c.config, &[query.to_string()])?.remove(0);
            queries.insert(key.clone(), v);
        }
        let Some(vector) = queries.get(&key) else { continue };
        for (path, f) in &index.files {
            for ch in &f.chunks {
                if ch.vector.is_empty() {
                    continue;
                }
                if ch.vector.len() != vector.len() {
                    return Err(format!("Query dimensions differ from the index of \"{}\"; re-index the collection", c.name));
                }
                hits.push(Hit {
                    collection_id: c.id.clone(),
                    collection: c.name.clone(),
                    source: f.display.clone(),
                    path: path.clone(),
                    heading: ch.heading.clone(),
                    start: ch.start,
                    end: ch.end,
                    score: cosine(vector, &ch.vector),
                    text: ch.text.chars().take(HIT_TEXT_CHARS).collect(),
                });
            }
        }
    }
    hits.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.source.cmp(&b.source)).then_with(|| a.start.cmp(&b.start)));
    hits.truncate(limit.clamp(1, 20));
    Ok(hits)
}

// ---------------------------------------------------------------------------------------------------------------------
// Tauri commands

static RUNNING: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
fn running() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}
fn store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("knowledge"))
}
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn knowledge_list(app: AppHandle) -> Result<Vec<Collection>, String> {
    let store = store_dir(&app)?;
    blocking(move || {
        let mut all = list(&store)?;
        let active = running().lock().map_err(|e| e.to_string())?;
        for c in &mut all {
            c.indexing = active.contains_key(&c.id);
        }
        Ok(all)
    })
    .await
}
#[tauri::command]
pub async fn knowledge_create(app: AppHandle, name: String, config: Config, include: Option<Vec<String>>) -> Result<Collection, String> {
    let store = store_dir(&app)?;
    blocking(move || create(&store, &name, config, include)).await
}
#[tauri::command]
pub async fn knowledge_rename(app: AppHandle, id: String, name: String) -> Result<Collection, String> {
    let store = store_dir(&app)?;
    blocking(move || rename(&store, &id, &name)).await
}
#[tauri::command]
pub async fn knowledge_delete(app: AppHandle, id: String) -> Result<(), String> {
    let store = store_dir(&app)?;
    if let Some(flag) = running().lock().map_err(|e| e.to_string())?.get(&id) {
        flag.store(true, Ordering::SeqCst);
    }
    blocking(move || delete(&store, &id)).await
}
#[tauri::command]
pub async fn knowledge_add_source(app: AppHandle, id: String, path: String) -> Result<Collection, String> {
    let store = store_dir(&app)?;
    blocking(move || add_source(&store, &id, &path)).await
}
#[tauri::command]
pub async fn knowledge_remove_source(app: AppHandle, id: String, path: String) -> Result<Collection, String> {
    let store = store_dir(&app)?;
    blocking(move || remove_source(&store, &id, &path)).await
}
#[tauri::command]
pub async fn knowledge_set_include(app: AppHandle, id: String, include: Vec<String>) -> Result<Collection, String> {
    let store = store_dir(&app)?;
    blocking(move || set_include(&store, &id, include)).await
}
#[tauri::command]
pub async fn knowledge_set_config(app: AppHandle, id: String, config: Config) -> Result<Collection, String> {
    let store = store_dir(&app)?;
    blocking(move || set_config(&store, &id, config)).await
}
#[tauri::command]
pub async fn knowledge_estimate(app: AppHandle, id: String) -> Result<Estimate, String> {
    let store = store_dir(&app)?;
    blocking(move || estimate(&store, &id)).await
}
#[tauri::command]
pub async fn knowledge_reindex(app: AppHandle, id: String, confirm: bool) -> Result<Stats, String> {
    let store = store_dir(&app)?;
    coll_dir(&store, &id)?;
    let flag = Arc::new(AtomicBool::new(false));
    {
        let mut active = running().lock().map_err(|e| e.to_string())?;
        if active.contains_key(&id) {
            return Err("This collection is already being indexed".into());
        }
        active.insert(id.clone(), flag.clone());
    }
    let emitter = app.clone();
    let key = id.clone();
    let result = blocking(move || {
        let progress = move |p: &Progress| {
            let _ = emitter.emit("knowledge-progress", p.clone());
        };
        reindex(&store, &id, confirm, &Run { pdf: extract_pdf_subprocess, progress: &progress, cancel: &flag })
    })
    .await;
    if let Ok(mut active) = running().lock() {
        active.remove(&key);
    }
    result
}
#[tauri::command]
pub fn knowledge_cancel(id: String) -> Result<(), String> {
    if let Some(flag) = running().lock().map_err(|e| e.to_string())?.get(&id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}
#[tauri::command]
pub async fn knowledge_search(app: AppHandle, ids: Vec<String>, query: String, limit: Option<usize>) -> Result<Vec<Hit>, String> {
    let store = store_dir(&app)?;
    blocking(move || search(&store, &ids, &query, limit.unwrap_or(8))).await
}

#[cfg(test)]
mod tests;
