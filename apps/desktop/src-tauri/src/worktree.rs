//! Git worktrees as per-task workspaces: one `git worktree` (own branch) per task under the app data dir,
//! never inside the project folder.
//!
//! Layout: `<app data>/worktrees/<hash of the repo's git common dir>/<task_id>/` is the checkout and
//! `<task_id>.json` beside it holds Gustaf's metadata (not in the repo's `.git`, not inside the checkout, so it
//! never shows up as an untracked file). Every command takes the project root, accepts only validated task ids,
//! and only ever deletes paths that canonicalise to a direct child of the managed directory.
//!
//! Errors are strings of the form `<code>: <message>` (see `WorktreeErrorCode` in `src/lib/worktrees.ts`); codes:
//! `not_a_git_repo`, `bare_repo`, `no_commits`, `invalid_task_id`, `invalid_base`, `task_exists`, `not_found`,
//! `dirty`, `unsafe_path`, `invalid_root`, `git_error`.
use crate::git::{blocking, canonical_root, run_git, run_git_capped};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const MAX_SLUG_CHARS: usize = 40;
const MAX_TASK_ID_CHARS: usize = 64;
const DIFF_CAP_BYTES: usize = 4 * 1024 * 1024;
const MAX_DIFF_FILES: usize = 1_000;
const MAX_UNTRACKED_READ: u64 = 1024 * 1024;
const BRANCH_PREFIX: &str = "gustaf/";

/// Serialises create / remove / prune: they share branch names, the managed directory and git's own locks.
static STORE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn err(code: &str, msg: impl std::fmt::Display) -> String {
    format!("{code}: {msg}")
}

fn git<I, S>(dir: &Path, args: I) -> Result<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    run_git(dir, args).map_err(|e| err("git_error", e))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Meta {
    pub(crate) task_id: String,
    pub(crate) root: String,
    pub(crate) branch: String,
    pub(crate) base_commit: String,
    pub(crate) base_branch: Option<String>,
    created_at: u64,
    provider: Option<String>,
    model: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub task_id: String,
    pub path: String,
    pub branch: String,
    pub base_commit: String,
    pub base_branch: Option<String>,
    pub created_at: u64,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub head_sha: Option<String>,
    pub changed_files: usize,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub dirty: bool,
    pub exists_on_disk: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub removed: bool,
    pub branch_deleted: bool,
    /// Why the branch was left alone (`delete_branch` asked for it): not merged, checked out elsewhere, ...
    pub branch_kept_reason: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PruneResult {
    /// Task ids whose metadata and leftover directory were removed.
    pub removed: Vec<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    /// `added`, `modified`, `deleted` or `untracked`.
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiff {
    pub base: String,
    pub files: Vec<DiffFile>,
    pub truncated: bool,
}

// ---------------------------------------------------------------------------------------------
// Names and paths

pub fn valid_task_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_TASK_ID_CHARS
        && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn check_task_id(id: &str) -> Result<(), String> {
    if valid_task_id(id) { Ok(()) } else { Err(err("invalid_task_id", "a task id is 1-64 letters, digits, '-' or '_'")) }
}

/// Lowercase ascii words joined by `-`, at most `MAX_SLUG_CHARS`; `task` when nothing is left.
pub fn sanitize_slug(slug: &str) -> String {
    let mut out = String::new();
    for c in slug.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.truncate(MAX_SLUG_CHARS);
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "task".into() } else { out }
}

fn fnv(text: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

pub(crate) struct Repo {
    /// Toplevel of the checkout `root` is in.
    pub(crate) top: PathBuf,
    /// `<store>/<hash>`: everything Gustaf manages for this repository.
    pub(crate) managed: PathBuf,
}

pub(crate) fn open_repo(store: &Path, root: &str) -> Result<Repo, String> {
    let base = canonical_root(root).map_err(|e| err("invalid_root", e))?;
    match run_git(&base, ["rev-parse", "--is-bare-repository"]) {
        Err(_) => return Err(err("not_a_git_repo", "the project folder is not inside a git repository")),
        Ok(out) if out.trim() == "true" => return Err(err("bare_repo", "bare repositories have no working tree to branch from")),
        Ok(_) => {}
    }
    let top = PathBuf::from(git(&base, ["rev-parse", "--show-toplevel"])?.trim());
    let common = PathBuf::from(git(&base, ["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim());
    let common = common.canonicalize().unwrap_or(common);
    let top = top.canonicalize().unwrap_or(top);
    fs::create_dir_all(store).map_err(|e| err("git_error", format!("worktree directory: {e}")))?;
    if let Ok(real_store) = store.canonicalize() {
        if real_store.starts_with(&top) {
            return Err(err("unsafe_path", "the worktree directory would be inside the project folder"));
        }
    }
    Ok(Repo { top, managed: store.join(fnv(&common.to_string_lossy())) })
}

fn meta_path(repo: &Repo, id: &str) -> PathBuf {
    repo.managed.join(format!("{id}.json"))
}

fn work_path(repo: &Repo, id: &str) -> PathBuf {
    repo.managed.join(id)
}

fn write_meta(repo: &Repo, meta: &Meta) -> Result<(), String> {
    let path = meta_path(repo, &meta.task_id);
    let tmp = repo.managed.join(format!("{}.json.tmp", meta.task_id));
    let text = serde_json::to_string_pretty(meta).map_err(|e| err("git_error", e))?;
    fs::write(&tmp, text).and_then(|_| fs::rename(&tmp, &path)).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        err("git_error", format!("worktree metadata: {e}"))
    })
}

pub(crate) fn read_meta(repo: &Repo, id: &str) -> Result<Meta, String> {
    check_task_id(id)?;
    let text = fs::read_to_string(meta_path(repo, id)).map_err(|_| err("not_found", format!("no workspace for task {id}")))?;
    let meta: Meta = serde_json::from_str(&text).map_err(|e| err("not_found", format!("unreadable metadata for task {id}: {e}")))?;
    if meta.task_id != id {
        return Err(err("not_found", format!("metadata does not belong to task {id}")));
    }
    Ok(meta)
}

fn all_meta(repo: &Repo) -> Vec<Meta> {
    let Ok(entries) = fs::read_dir(&repo.managed) else { return Vec::new() };
    let mut out: Vec<Meta> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".json")?;
            read_meta(repo, id).ok()
        })
        .collect();
    out.sort_by(|a, b| (a.created_at, &a.task_id).cmp(&(b.created_at, &b.task_id)));
    out
}

/// The checkout directory when it is a real (non-symlink) direct child of the managed dir; `None` when absent.
pub(crate) fn safe_existing_dir(repo: &Repo, id: &str) -> Result<Option<PathBuf>, String> {
    let path = work_path(repo, id);
    let Ok(md) = fs::symlink_metadata(&path) else { return Ok(None) };
    if md.file_type().is_symlink() || !md.is_dir() {
        return Err(err("unsafe_path", format!("{} is not a plain directory", path.display())));
    }
    let real = path.canonicalize().map_err(|e| err("unsafe_path", e))?;
    let parent = repo.managed.canonicalize().map_err(|e| err("unsafe_path", e))?;
    if real.parent() != Some(parent.as_path()) || real.file_name() != Some(std::ffi::OsStr::new(id)) {
        return Err(err("unsafe_path", format!("{} is outside the managed directory", path.display())));
    }
    Ok(Some(path))
}

pub(crate) fn ref_exists(dir: &Path, name: &str) -> bool {
    run_git(dir, ["rev-parse", "--verify", "-q", &format!("{name}^{{commit}}")]).is_ok()
}

pub(crate) fn local_branch_exists(dir: &Path, branch: &str) -> bool {
    run_git(dir, ["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok()
}

fn unique_branch(top: &Path, slug: &str) -> Result<String, String> {
    let stem = sanitize_slug(slug);
    for n in 1..1000 {
        let name = if n == 1 { format!("{BRANCH_PREFIX}{stem}") } else { format!("{BRANCH_PREFIX}{stem}-{n}") };
        if !local_branch_exists(top, &name) {
            return Ok(name);
        }
    }
    Err(err("git_error", "no free branch name"))
}

pub(crate) fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---------------------------------------------------------------------------------------------
// Operations (the commands below only resolve the store and run these off the UI thread)

fn info_for(repo: &Repo, meta: &Meta) -> WorktreeInfo {
    let path = work_path(repo, &meta.task_id);
    let exists = path.is_dir();
    let mut info = WorktreeInfo {
        task_id: meta.task_id.clone(),
        path: path.to_string_lossy().into_owned(),
        branch: meta.branch.clone(),
        base_commit: meta.base_commit.clone(),
        base_branch: meta.base_branch.clone(),
        created_at: meta.created_at,
        provider: meta.provider.clone(),
        model: meta.model.clone(),
        head_sha: None,
        changed_files: 0,
        ahead: None,
        behind: None,
        dirty: false,
        exists_on_disk: exists,
    };
    if !exists {
        return info;
    }
    info.head_sha = run_git(&path, ["rev-parse", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Ok(branch) = run_git(&path, ["symbolic-ref", "--short", "-q", "HEAD"]) {
        if !branch.trim().is_empty() {
            info.branch = branch.trim().to_string();
        }
    }
    if let Ok(status) = run_git(&path, ["status", "--porcelain"]) {
        info.changed_files = status.lines().filter(|l| !l.is_empty()).count();
        info.dirty = info.changed_files > 0;
    }
    let target = meta.base_branch.as_deref().filter(|b| ref_exists(&path, b)).unwrap_or(&meta.base_commit);
    if let Ok(counts) = run_git(&path, ["rev-list", "--left-right", "--count", &format!("{target}...HEAD")]) {
        let mut parts = counts.split_whitespace().map(|n| n.parse::<u32>().ok());
        if let (Some(behind), Some(ahead)) = (parts.next().flatten(), parts.next().flatten()) {
            info.behind = Some(behind);
            info.ahead = Some(ahead);
        }
    }
    info
}

pub fn create(store: &Path, root: &str, base: Option<&str>, slug: &str, task_id: &str, provider: Option<String>, model: Option<String>) -> Result<WorktreeInfo, String> {
    check_task_id(task_id)?;
    let repo = open_repo(store, root)?;
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let base_ref = base.map(str::trim).filter(|b| !b.is_empty()).unwrap_or("HEAD");
    if base_ref.starts_with('-') || base_ref.contains(['\0', '\n']) {
        return Err(err("invalid_base", "not a valid revision"));
    }
    if run_git(&repo.top, ["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
        return Err(err("no_commits", "the repository has no commits yet"));
    }
    let base_commit = run_git(&repo.top, ["rev-parse", "--verify", "-q", &format!("{base_ref}^{{commit}}")])
        .map_err(|_| err("invalid_base", format!("'{base_ref}' is not a commit")))?
        .trim()
        .to_string();
    // The branch the base names (for ahead/behind later); none for a raw sha or a detached HEAD.
    let base_branch = if base_ref == "HEAD" {
        run_git(&repo.top, ["symbolic-ref", "--short", "-q", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    } else if local_branch_exists(&repo.top, base_ref) || run_git(&repo.top, ["show-ref", "--verify", "--quiet", &format!("refs/remotes/{base_ref}")]).is_ok() {
        Some(base_ref.to_string())
    } else {
        None
    };
    let path = work_path(&repo, task_id);
    if fs::symlink_metadata(&path).is_ok() || meta_path(&repo, task_id).exists() {
        return Err(err("task_exists", format!("task {task_id} already has a workspace")));
    }
    fs::create_dir_all(&repo.managed).map_err(|e| err("git_error", e))?;
    let branch = unique_branch(&repo.top, slug)?;
    git(&repo.top, ["worktree".as_ref(), "add".as_ref(), "-q".as_ref(), path.as_os_str(), "-b".as_ref(), branch.as_ref(), base_commit.as_ref()])?;
    let meta = Meta { task_id: task_id.into(), root: repo.top.to_string_lossy().into_owned(), branch, base_commit, base_branch, created_at: now(), provider, model };
    if let Err(e) = write_meta(&repo, &meta) {
        let _ = run_git(&repo.top, ["worktree".as_ref(), "remove".as_ref(), "--force".as_ref(), path.as_os_str()]);
        let _ = run_git(&repo.top, ["branch", "-D", &meta.branch]);
        return Err(e);
    }
    Ok(info_for(&repo, &meta))
}

pub fn list(store: &Path, root: &str) -> Result<Vec<WorktreeInfo>, String> {
    let repo = open_repo(store, root)?;
    Ok(all_meta(&repo).iter().map(|m| info_for(&repo, m)).collect())
}

fn is_merged(top: &Path, meta: &Meta) -> bool {
    let merged_into = |target: &str| run_git(top, ["merge-base", "--is-ancestor", &meta.branch, target]).is_ok();
    merged_into("HEAD") || meta.base_branch.as_deref().is_some_and(|b| ref_exists(top, b) && merged_into(b))
}

pub fn remove(store: &Path, root: &str, task_id: &str, force: bool, delete_branch: bool) -> Result<RemoveResult, String> {
    let repo = open_repo(store, root)?;
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let meta = read_meta(&repo, task_id)?;
    if let Some(dir) = safe_existing_dir(&repo, task_id)? {
        if !force {
            let status = git(&dir, ["status", "--porcelain"])?;
            let n = status.lines().filter(|l| !l.is_empty()).count();
            if n > 0 {
                return Err(err("dirty", format!("{n} uncommitted change(s) in the workspace")));
            }
        }
        let mut args: Vec<&std::ffi::OsStr> = vec!["worktree".as_ref(), "remove".as_ref()];
        if force {
            args.push("--force".as_ref());
        }
        args.push(dir.as_os_str());
        git(&repo.top, args)?;
    }
    let _ = run_git(&repo.top, ["worktree", "prune"]);
    let _ = fs::remove_file(meta_path(&repo, task_id));
    let mut result = RemoveResult { removed: true, branch_deleted: false, branch_kept_reason: None };
    if delete_branch {
        if !meta.branch.starts_with(BRANCH_PREFIX) || !local_branch_exists(&repo.top, &meta.branch) {
            result.branch_kept_reason = Some("branch not found".into());
        } else if !force && !is_merged(&repo.top, &meta) {
            result.branch_kept_reason = Some("branch has commits that are not merged".into());
        } else {
            match run_git(&repo.top, ["branch", "-D", &meta.branch]) {
                Ok(_) => result.branch_deleted = true,
                Err(e) => result.branch_kept_reason = Some(e),
            }
        }
    }
    Ok(result)
}

fn registered_worktrees(top: &Path) -> BTreeSet<PathBuf> {
    let out = run_git(top, ["worktree", "list", "--porcelain"]).unwrap_or_default();
    out.lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .map(|p| {
            let p = PathBuf::from(p);
            p.canonicalize().unwrap_or(p)
        })
        .collect()
}

pub fn prune(store: &Path, root: &str) -> Result<PruneResult, String> {
    let repo = open_repo(store, root)?;
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    git(&repo.top, ["worktree", "prune"])?;
    let registered = registered_worktrees(&repo.top);
    let mut removed = Vec::new();
    for meta in all_meta(&repo) {
        let id = &meta.task_id;
        let keep = match safe_existing_dir(&repo, id) {
            Ok(Some(dir)) => dir.canonicalize().map(|p| registered.contains(&p)).unwrap_or(true),
            Ok(None) => false,
            Err(_) => true, // not a plain managed directory: never touch it
        };
        if keep {
            continue;
        }
        if let Ok(Some(dir)) = safe_existing_dir(&repo, id) {
            if fs::remove_dir_all(&dir).is_err() {
                continue;
            }
        }
        let _ = fs::remove_file(meta_path(&repo, id));
        removed.push(id.clone());
    }
    Ok(PruneResult { removed })
}

fn parse_numstat(text: &str) -> BTreeMap<String, (u32, u32, bool)> {
    let mut out = BTreeMap::new();
    for rec in text.split('\0').filter(|r| !r.is_empty()) {
        let mut parts = rec.splitn(3, '\t');
        let (Some(a), Some(d), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let binary = a == "-" || d == "-";
        out.insert(path.to_string(), (a.parse().unwrap_or(0), d.parse().unwrap_or(0), binary));
    }
    out
}

fn parse_name_status(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut it = text.split('\0').filter(|r| !r.is_empty());
    while let (Some(code), Some(path)) = (it.next(), it.next()) {
        let status = match code.chars().next() {
            Some('A') => "added",
            Some('D') => "deleted",
            _ => "modified",
        };
        out.insert(path.to_string(), status.to_string());
    }
    out
}

pub fn diff(store: &Path, root: &str, task_id: &str) -> Result<WorktreeDiff, String> {
    let repo = open_repo(store, root)?;
    let meta = read_meta(&repo, task_id)?;
    let Some(dir) = safe_existing_dir(&repo, task_id)? else {
        return Err(err("not_found", "the workspace directory is gone (prune it)"));
    };
    let capped = |args: &[&str]| run_git_capped(&dir, args.iter().copied(), DIFF_CAP_BYTES, &[0]).map_err(|e| err("git_error", e));
    // Committed work (base...HEAD) plus staged and unstaged changes: the net difference from the base commit.
    let range = format!("{}...HEAD", meta.base_commit);
    let (committed, cut1) = capped(&["diff", "--numstat", "-z", "--no-renames", &range])?;
    let (committed_status, _) = capped(&["diff", "--name-status", "-z", "--no-renames", &range])?;
    let (tree, cut2) = capped(&["diff", "--numstat", "-z", "--no-renames", &meta.base_commit])?;
    let (tree_status, _) = capped(&["diff", "--name-status", "-z", "--no-renames", &meta.base_commit])?;
    let (untracked, cut3) = capped(&["ls-files", "--others", "--exclude-standard", "-z"])?;
    let mut truncated = cut1 || cut2 || cut3;
    // `base...HEAD` first, then the working tree view (which already includes the committed part) wins.
    let mut stats = parse_numstat(&committed);
    stats.extend(parse_numstat(&tree));
    let mut statuses = parse_name_status(&committed_status);
    statuses.extend(parse_name_status(&tree_status));
    let mut files: Vec<DiffFile> = stats
        .into_iter()
        .map(|(path, (additions, deletions, binary))| DiffFile { status: statuses.get(&path).cloned().unwrap_or_else(|| "modified".into()), path, additions, deletions, binary })
        .collect();
    for path in untracked.split('\0').filter(|p| !p.is_empty()) {
        if files.iter().any(|f| f.path == path) {
            continue;
        }
        let (additions, binary) = count_untracked(&dir.join(path));
        files.push(DiffFile { path: path.to_string(), status: "untracked".into(), additions, deletions: 0, binary });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    if files.len() > MAX_DIFF_FILES {
        files.truncate(MAX_DIFF_FILES);
        truncated = true;
    }
    Ok(WorktreeDiff { base: meta.base_commit, files, truncated })
}

/// Line count of a new file; `(0, true)` for binary or oversized files, `(0, false)` for unreadable or symlinks.
fn count_untracked(path: &Path) -> (u32, bool) {
    let Ok(md) = fs::symlink_metadata(path) else { return (0, false) };
    if !md.is_file() {
        return (0, false);
    }
    if md.len() > MAX_UNTRACKED_READ {
        return (0, true);
    }
    match fs::read(path) {
        Ok(bytes) if bytes.contains(&0) => (0, true),
        Ok(bytes) => (bytes.iter().filter(|b| **b == b'\n').count() as u32 + u32::from(!bytes.is_empty() && !bytes.ends_with(b"\n")), false),
        Err(_) => (0, false),
    }
}

/// Symlinks dependency directories (project-relative, e.g. `node_modules`) of the original project into the task's
/// checkout so its setup and tools find them; same validation as the shadow copy (`review::resolve_links`).
/// Directories missing in the project or already present in the checkout are skipped. Returns what was linked.
pub fn link_dirs(store: &Path, root: &str, task_id: &str, dirs: &[String]) -> Result<Vec<String>, String> {
    check_task_id(task_id)?;
    let repo = open_repo(store, root)?;
    let checkout = safe_existing_dir(&repo, task_id)?.ok_or_else(|| err("not_found", format!("no workspace for task {task_id}")))?;
    let base = canonical_root(root).map_err(|e| err("invalid_root", e))?;
    let top = repo.top.canonicalize().map_err(|e| err("invalid_root", e))?;
    // A project in a subfolder of the repository lives at the same subfolder of the checkout.
    let prefix = base.strip_prefix(&top).map_err(|_| err("invalid_root", "the project is outside its repository"))?.to_path_buf();
    let target_root = checkout.join(prefix);
    let linked = crate::review::resolve_links(&base, dirs).map_err(|e| err("unsafe_path", e))?;
    let mut done = Vec::new();
    for rel in linked {
        let dest = target_root.join(&rel);
        if fs::symlink_metadata(&dest).is_ok() {
            continue;
        }
        let Some(parent) = dest.parent() else { continue };
        fs::create_dir_all(parent).map_err(|e| err("git_error", e))?;
        crate::review::link_dir(&base.join(&rel), &dest).map_err(|e| err("git_error", e))?;
        done.push(rel);
    }
    Ok(done)
}

// ---------------------------------------------------------------------------------------------
// Commands

pub(crate) fn store(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| err("git_error", e))?.join("worktrees"))
}

/// New worktree + branch `gustaf/<slug>` at `base` (default HEAD) for a task.
#[tauri::command]
pub async fn worktree_create(app: AppHandle, root: String, base: Option<String>, slug: String, task_id: String, provider: Option<String>, model: Option<String>) -> Result<WorktreeInfo, String> {
    let store = store(&app)?;
    blocking(move || create(&store, &root, base.as_deref(), &slug, &task_id, provider, model)).await
}

#[tauri::command]
pub async fn worktree_list(app: AppHandle, root: String) -> Result<Vec<WorktreeInfo>, String> {
    let store = store(&app)?;
    blocking(move || list(&store, &root)).await
}

#[tauri::command]
pub async fn worktree_remove(app: AppHandle, root: String, task_id: String, force: bool, delete_branch: bool) -> Result<RemoveResult, String> {
    let store = store(&app)?;
    blocking(move || remove(&store, &root, &task_id, force, delete_branch)).await
}

#[tauri::command]
pub async fn worktree_prune(app: AppHandle, root: String) -> Result<PruneResult, String> {
    let store = store(&app)?;
    blocking(move || prune(&store, &root)).await
}

#[tauri::command]
pub async fn worktree_diff(app: AppHandle, root: String, task_id: String) -> Result<WorktreeDiff, String> {
    let store = store(&app)?;
    blocking(move || diff(&store, &root, &task_id)).await
}

#[tauri::command]
pub async fn worktree_link_dirs(app: AppHandle, root: String, task_id: String, link_dirs: Vec<String>) -> Result<Vec<String>, String> {
    let store = store(&app)?;
    blocking(move || self::link_dirs(&store, &root, &task_id, &link_dirs)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    struct Fx {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        store: PathBuf,
    }

    fn g(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn fx() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let (root, store) = (base.join("repo"), base.join("store"));
        fs::create_dir_all(&root).unwrap();
        g(&root, &["init", "-q", "-b", "main"]);
        for (k, v) in [("user.name", "T"), ("user.email", "t@e.com"), ("commit.gpgsign", "false"), ("core.hooksPath", base.join("nohooks").to_str().unwrap())] {
            g(&root, &["config", k, v]);
        }
        fs::write(root.join("a.txt"), "1\n").unwrap();
        g(&root, &["add", "."]);
        g(&root, &["commit", "-q", "-m", "init"]);
        Fx { _tmp: tmp, root, store }
    }

    fn mk(f: &Fx, slug: &str, id: &str) -> WorktreeInfo {
        create(&f.store, f.root.to_str().unwrap(), None, slug, id, None, None).unwrap()
    }

    fn root(f: &Fx) -> &str {
        f.root.to_str().unwrap()
    }

    fn code(e: &str) -> &str {
        e.split(':').next().unwrap()
    }

    #[test]
    fn slugs_are_sanitised() {
        assert_eq!(sanitize_slug("Fix the Bug!!"), "fix-the-bug");
        assert_eq!(sanitize_slug("  ../../etc/passwd "), "etc-passwd");
        assert_eq!(sanitize_slug("日本語"), "task");
        assert_eq!(sanitize_slug(&"a".repeat(100)).len(), MAX_SLUG_CHARS);
        assert!(!sanitize_slug("x--y-").contains("--"));
    }

    #[test]
    fn task_ids_are_validated() {
        for ok in ["abc", "a-b_c", "T1", "0123"] {
            assert!(valid_task_id(ok), "{ok}");
        }
        for bad in ["", "..", "../x", "a/b", "a\\b", ".hidden", "-x", "a b", "a.b", &"x".repeat(65)] {
            assert!(!valid_task_id(bad), "{bad:?}");
        }
        let f = fx();
        for bad in ["..", "a/b", "../escape"] {
            let e = create(&f.store, root(&f), None, "s", bad, None, None).unwrap_err();
            assert_eq!(code(&e), "invalid_task_id", "{e}");
            assert_eq!(code(&remove(&f.store, root(&f), bad, true, true).unwrap_err()), "invalid_task_id");
            assert_eq!(code(&diff(&f.store, root(&f), bad).unwrap_err()), "invalid_task_id");
        }
        assert!(!f.store.join("..").join("escape").exists());
    }

    #[test]
    fn lifecycle_create_list_diff_remove() {
        let f = fx();
        let head = g(&f.root, &["rev-parse", "HEAD"]).trim().to_string();
        let w = mk(&f, "Add feature", "t1");
        assert_eq!(w.branch, "gustaf/add-feature");
        assert_eq!(w.base_commit, head);
        assert_eq!(w.base_branch.as_deref(), Some("main"));
        let path = PathBuf::from(&w.path);
        assert!(path.join("a.txt").is_file());
        assert!(!path.canonicalize().unwrap().starts_with(&f.root), "never inside the project");
        assert!(!path.join("t1.json").exists());

        let l = list(&f.store, root(&f)).unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!((l[0].changed_files, l[0].dirty, l[0].exists_on_disk, l[0].ahead, l[0].behind), (0, false, true, Some(0), Some(0)));
        assert_eq!(l[0].head_sha.as_deref(), Some(head.as_str()));

        fs::write(path.join("a.txt"), "1\n2\n").unwrap();
        fs::write(path.join("new.txt"), "x\ny\n").unwrap();
        let l = list(&f.store, root(&f)).unwrap();
        assert_eq!((l[0].changed_files, l[0].dirty), (2, true));

        // a committed change plus a working tree change
        g(&path, &["add", "a.txt"]);
        g(&path, &["commit", "-q", "-m", "work"]);
        fs::write(path.join("b.bin"), [0u8, 1, 2]).unwrap();
        g(&path, &["add", "b.bin"]);
        g(&path, &["commit", "-q", "-m", "bin"]);
        fs::write(path.join("a.txt"), "1\n2\n3\n").unwrap();
        let d = diff(&f.store, root(&f), "t1").unwrap();
        assert_eq!(d.base, head);
        let by = |p: &str| d.files.iter().find(|x| x.path == p).unwrap_or_else(|| panic!("{p} in {:?}", d.files)).clone();
        assert_eq!((by("a.txt").status.as_str(), by("a.txt").additions), ("modified", 2));
        assert_eq!((by("new.txt").status.as_str(), by("new.txt").additions), ("untracked", 2));
        assert!(by("b.bin").binary && by("b.bin").status == "added");
        let l = list(&f.store, root(&f)).unwrap();
        assert_eq!((l[0].ahead, l[0].behind), (Some(2), Some(0)));

        let e = remove(&f.store, root(&f), "t1", false, false).unwrap_err();
        assert_eq!(code(&e), "dirty", "{e}");
        assert!(path.exists());
        let r = remove(&f.store, root(&f), "t1", true, false).unwrap();
        assert!(r.removed && !r.branch_deleted);
        assert!(!path.exists());
        assert!(list(&f.store, root(&f)).unwrap().is_empty());
        assert!(local_branch_exists(&f.root, "gustaf/add-feature"), "branch kept without delete_branch");
        assert_eq!(code(&remove(&f.store, root(&f), "t1", true, false).unwrap_err()), "not_found");
    }

    #[test]
    fn colliding_slugs_get_suffixes_and_existing_branches_are_skipped() {
        let f = fx();
        g(&f.root, &["branch", "gustaf/same-3"]);
        let a = mk(&f, "Same", "a");
        let b = mk(&f, "same", "b");
        let c = mk(&f, "SAME!", "c");
        assert_eq!((a.branch.as_str(), b.branch.as_str(), c.branch.as_str()), ("gustaf/same", "gustaf/same-2", "gustaf/same-4"));
        assert_eq!(list(&f.store, root(&f)).unwrap().len(), 3);
        let e = create(&f.store, root(&f), None, "x", "a", None, None).unwrap_err();
        assert_eq!(code(&e), "task_exists");
    }

    #[test]
    fn non_git_and_bare_roots_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let plain = tmp.path().join("plain");
        let bare = tmp.path().join("bare.git");
        fs::create_dir_all(&plain).unwrap();
        fs::create_dir_all(&bare).unwrap();
        g(&bare, &["init", "-q", "--bare"]);
        let store = tmp.path().join("store");
        let e = create(&store, plain.to_str().unwrap(), None, "s", "t", None, None).unwrap_err();
        assert_eq!(code(&e), "not_a_git_repo", "{e}");
        assert_eq!(code(&list(&store, plain.to_str().unwrap()).unwrap_err()), "not_a_git_repo");
        let e = create(&store, bare.to_str().unwrap(), None, "s", "t", None, None).unwrap_err();
        assert_eq!(code(&e), "bare_repo", "{e}");
        let e = create(&store, tmp.path().join("missing").to_str().unwrap(), None, "s", "t", None, None).unwrap_err();
        assert_eq!(code(&e), "invalid_root");
    }

    #[test]
    fn empty_repo_and_bad_base_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("r");
        fs::create_dir_all(&repo).unwrap();
        g(&repo, &["init", "-q", "-b", "main"]);
        let store = tmp.path().join("store");
        assert_eq!(code(&create(&store, repo.to_str().unwrap(), None, "s", "t", None, None).unwrap_err()), "no_commits");
        let f = fx();
        for bad in ["--orphan", "nope", "-x"] {
            let e = create(&f.store, root(&f), Some(bad), "s", "t", None, None).unwrap_err();
            assert_eq!(code(&e), "invalid_base", "{bad}: {e}");
        }
    }

    #[test]
    fn detached_head_and_explicit_base() {
        let f = fx();
        let first = g(&f.root, &["rev-parse", "HEAD"]).trim().to_string();
        fs::write(f.root.join("a.txt"), "2\n").unwrap();
        g(&f.root, &["commit", "-q", "-am", "second"]);
        g(&f.root, &["checkout", "-q", "--detach"]);
        let w = mk(&f, "detached", "d1");
        assert_eq!(w.base_branch, None);
        assert_eq!(w.base_commit, g(&f.root, &["rev-parse", "HEAD"]).trim());
        let w = create(&f.store, root(&f), Some(&first), "old", "d2", None, None).unwrap();
        assert_eq!((w.base_commit.as_str(), w.base_branch), (first.as_str(), None));
        assert_eq!(fs::read_to_string(PathBuf::from(&w.path).join("a.txt")).unwrap(), "1\n");
        let w = create(&f.store, root(&f), Some("main"), "m", "d3", None, Some("gpt".into())).unwrap();
        assert_eq!((w.base_branch.as_deref(), w.model.as_deref()), (Some("main"), Some("gpt")));
    }

    #[test]
    fn branch_is_deleted_only_when_merged_or_forced() {
        let f = fx();
        let w = mk(&f, "feat", "t1");
        let path = PathBuf::from(&w.path);
        fs::write(path.join("n.txt"), "n\n").unwrap();
        g(&path, &["add", "."]);
        g(&path, &["commit", "-q", "-m", "n"]);
        let r = remove(&f.store, root(&f), "t1", false, true).unwrap();
        assert!(r.removed && !r.branch_deleted && r.branch_kept_reason.is_some(), "{r:?}");
        assert!(local_branch_exists(&f.root, "gustaf/feat"));

        let w = mk(&f, "feat", "t2");
        assert_eq!(w.branch, "gustaf/feat-2");
        g(&f.root, &["merge", "-q", "--no-edit", "gustaf/feat"]);
        let r = remove(&f.store, root(&f), "t2", false, true).unwrap();
        assert!(r.branch_deleted, "{r:?}");
        assert!(!local_branch_exists(&f.root, "gustaf/feat-2"));

        let w = mk(&f, "other", "t3");
        let path = PathBuf::from(&w.path);
        fs::write(path.join("o.txt"), "o\n").unwrap();
        g(&path, &["add", "."]);
        g(&path, &["commit", "-q", "-m", "o"]);
        let r = remove(&f.store, root(&f), "t3", true, true).unwrap();
        assert!(r.branch_deleted);
        assert!(!local_branch_exists(&f.root, "gustaf/other"));
    }

    #[test]
    fn prune_cleans_up_after_a_manually_deleted_directory() {
        let f = fx();
        let a = mk(&f, "a", "ta");
        let b = mk(&f, "b", "tb");
        fs::remove_dir_all(&a.path).unwrap();
        let l = list(&f.store, root(&f)).unwrap();
        assert!(!l.iter().find(|w| w.task_id == "ta").unwrap().exists_on_disk);
        let r = prune(&f.store, root(&f)).unwrap();
        assert_eq!(r.removed, vec!["ta".to_string()]);
        let l = list(&f.store, root(&f)).unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].task_id, "tb");
        assert!(PathBuf::from(&b.path).is_dir());
        // a directory whose git entry vanished is removed too
        g(&f.root, &["worktree", "remove", "--force", &b.path]);
        fs::create_dir_all(&b.path).unwrap();
        fs::write(PathBuf::from(&b.path).join("leftover"), "x").unwrap();
        assert_eq!(prune(&f.store, root(&f)).unwrap().removed, vec!["tb".to_string()]);
        assert!(!PathBuf::from(&b.path).exists());
        assert!(prune(&f.store, root(&f)).unwrap().removed.is_empty());
    }

    #[test]
    fn worktrees_of_other_repos_are_not_listed_and_subfolders_resolve() {
        let f = fx();
        mk(&f, "x", "t1");
        let other = f.root.parent().unwrap().join("other");
        fs::create_dir_all(&other).unwrap();
        g(&other, &["init", "-q", "-b", "main"]);
        for (k, v) in [("user.name", "T"), ("user.email", "t@e.com"), ("commit.gpgsign", "false")] {
            g(&other, &["config", k, v]);
        }
        fs::write(other.join("f"), "1").unwrap();
        g(&other, &["add", "."]);
        g(&other, &["commit", "-q", "-m", "i"]);
        assert!(list(&f.store, other.to_str().unwrap()).unwrap().is_empty());
        fs::create_dir_all(f.root.join("sub")).unwrap();
        assert_eq!(list(&f.store, f.root.join("sub").to_str().unwrap()).unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn dependency_directories_are_symlinked_into_the_checkout() {
        let f = fx();
        fs::create_dir_all(f.root.join("node_modules/x")).unwrap();
        fs::create_dir_all(f.root.join("sub/node_modules")).unwrap();
        let w = mk(&f, "deps", "t1");
        let done = link_dirs(&f.store, root(&f), "t1", &["node_modules".into(), "missing".into(), "node_modules/x".into()]).unwrap();
        assert_eq!(done, vec!["node_modules".to_string()], "missing dirs are skipped, nested ones collapse");
        let link = PathBuf::from(&w.path).join("node_modules");
        assert_eq!(fs::read_link(&link).unwrap(), f.root.join("node_modules"));
        // Idempotent, and the original project is untouched.
        assert!(link_dirs(&f.store, root(&f), "t1", &["node_modules".into()]).unwrap().is_empty());
        assert!(f.root.join("node_modules").is_dir() && !fs::symlink_metadata(f.root.join("node_modules")).unwrap().file_type().is_symlink());
        // Unsafe requests are refused; unknown tasks are not_found.
        assert_eq!(code(&link_dirs(&f.store, root(&f), "t1", &["../x".into()]).unwrap_err()), "unsafe_path");
        assert_eq!(code(&link_dirs(&f.store, root(&f), "nope", &[]).unwrap_err()), "not_found");
        // A project in a subfolder links into the same subfolder of the checkout.
        let sub = f.root.join("sub");
        let done = link_dirs(&f.store, sub.to_str().unwrap(), "t1", &["node_modules".into()]).unwrap();
        assert_eq!(done, vec!["node_modules".to_string()]);
        assert!(fs::symlink_metadata(PathBuf::from(&w.path).join("sub/node_modules")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn store_inside_the_project_is_refused() {
        let f = fx();
        let inside = f.root.join(".worktrees");
        let e = create(&inside, root(&f), None, "s", "t", None, None).unwrap_err();
        assert_eq!(code(&e), "unsafe_path", "{e}");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_task_directories_are_never_followed() {
        let f = fx();
        let w = mk(&f, "s", "t1");
        let victim = f.root.parent().unwrap().join("victim");
        fs::create_dir_all(&victim).unwrap();
        fs::write(victim.join("keep"), "x").unwrap();
        fs::remove_dir_all(&w.path).unwrap();
        std::os::unix::fs::symlink(&victim, &w.path).unwrap();
        let e = remove(&f.store, root(&f), "t1", true, false).unwrap_err();
        assert_eq!(code(&e), "unsafe_path", "{e}");
        assert!(prune(&f.store, root(&f)).unwrap().removed.is_empty());
        assert!(victim.join("keep").exists());
    }
}
