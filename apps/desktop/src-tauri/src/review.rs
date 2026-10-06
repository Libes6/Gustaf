use crate::hunks;
use crate::tools::resolve_in_root;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, path::{Component, Path, PathBuf}, process::Command, time::{SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize)]
pub struct Review {
    pub id: String,
    pub root: String,
    pub workspace: String,
    /// Dependency directories (relative to the project) symlinked into the shadow copy. They point at the original
    /// project, are never listed as changes and are never applied or restored by review.
    #[serde(default)]
    pub linked: Vec<String>,
}
#[derive(Serialize)]
pub struct Change { pub path: String, pub binary: bool }

fn store(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("reviews"))
}
fn review_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit() || b == b'-') { return Err("Invalid review id".into()); }
    Ok(store(app)?.join(id))
}
fn files(root: &Path, respect_ignore: bool) -> Result<Vec<PathBuf>, String> {
    let mut walker = ignore::WalkBuilder::new(root);
    walker.hidden(false).git_ignore(respect_ignore).git_exclude(respect_ignore).git_global(false).require_git(false).follow_links(false);
    walker.filter_entry(|e| !matches!(e.file_name().to_str(), Some(".git" | "node_modules" | "target" | "dist" | ".next" | ".DS_Store")));
    let mut paths = Vec::new();
    for item in walker.build() {
        let e = item.map_err(|e| e.to_string())?;
        if e.file_type().is_some_and(|t| t.is_file()) { paths.push(e.path().strip_prefix(root).map_err(|e| e.to_string())?.to_owned()); }
    }
    Ok(paths)
}
fn bytes(root: &Path, rel: &str) -> Result<Option<Vec<u8>>, String> {
    let p = resolve_in_root(root, rel)?;
    match fs::read(p) { Ok(b) => Ok(Some(b)), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None), Err(e) => Err(e.to_string()) }
}
fn put(root: &Path, rel: &str, value: &Option<Vec<u8>>) -> Result<(), String> {
    let p = resolve_in_root(root, rel)?;
    if let Some(data) = value {
        fs::create_dir_all(p.parent().ok_or("Invalid file path")?).map_err(|e| e.to_string())?;
        fs::write(p, data).map_err(|e| e.to_string())?;
    } else if p.exists() { fs::remove_file(p).map_err(|e| e.to_string())?; }
    Ok(())
}

/// Normalizes a user-supplied directory to a project-relative `a/b` form; rejects absolute paths, `..`, `.git` and empty input.
fn clean_link(raw: &str) -> Result<String, String> {
    let mut parts = Vec::new();
    for c in Path::new(raw.trim()).components() {
        match c {
            Component::Normal(p) => parts.push(p.to_str().ok_or("Non-UTF8 directory name")?.to_owned()),
            Component::CurDir => {}
            _ => return Err(format!("Invalid linked directory: {raw}")),
        }
    }
    if parts.is_empty() || parts.iter().any(|p| p == ".git") { return Err(format!("Invalid linked directory: {raw}")); }
    Ok(parts.join("/"))
}
fn under_any(path: &str, dirs: &[String]) -> bool {
    let normalized = if cfg!(windows) { path.replace('\\', "/") } else { path.to_owned() };
    let path = normalized.as_str();
    dirs.iter().any(|d| path == d || path.strip_prefix(d.as_str()).is_some_and(|rest| rest.starts_with('/')))
}
fn read_linked(dir: &Path) -> Vec<String> {
    fs::read(dir.join("review.json")).ok().and_then(|b| serde_json::from_slice::<Review>(&b).ok()).map(|r| r.linked).unwrap_or_default()
}
#[cfg(unix)]
pub(crate) fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> { std::os::unix::fs::symlink(target, link) }
#[cfg(windows)]
pub(crate) fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> { std::os::windows::fs::symlink_dir(target, link) }

/// Validates the requested directories: each must be a real directory (not a symlink) inside the project. Missing ones are skipped,
/// nested duplicates collapse into their parent, anything unsafe is an error.
pub(crate) fn resolve_links(root: &Path, requested: &[String]) -> Result<Vec<String>, String> {
    let mut cleaned = Vec::new();
    for raw in requested {
        let rel = clean_link(raw)?;
        let abs = resolve_in_root(root, &rel)?;
        match fs::symlink_metadata(root.join(&rel)) {
            Ok(m) if m.is_dir() && abs == root.canonicalize().map_err(|e| e.to_string())?.join(&rel) => cleaned.push(rel),
            Ok(m) if m.is_dir() => return Err(format!("Linked directory must not be a symlink: {rel}")),
            Ok(_) => return Err(format!("Linked path is not a directory: {rel}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    cleaned.sort_by_key(|d| d.len());
    let mut out: Vec<String> = Vec::new();
    for d in cleaned { if !under_any(&d, &out) { out.push(d); } }
    Ok(out)
}

fn prepare(parent: &Path, root: &Path, id: String, link_dirs: &[String]) -> Result<Review, String> {
    let dir = parent.join(&id);
    let baseline = dir.join("baseline");
    let work = dir.join("work");
    fs::create_dir_all(&baseline).map_err(|e| e.to_string())?;
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let result = (|| {
        let linked = resolve_links(root, link_dirs)?;
        let list: Vec<PathBuf> = files(root, true)?.into_iter().filter(|p| !p.to_str().is_some_and(|p| under_any(p, &linked))).collect();
        if list.len() > 50_000 { return Err("Project is too large for review (50,000 files)".into()); }
        let mut total = 0u64;
        for rel in list {
            let source = resolve_in_root(root, rel.to_str().ok_or("Non-UTF8 filename")?)?;
            total += fs::metadata(&source).map_err(|e| e.to_string())?.len();
            if total > 500_000_000 { return Err("Project is too large for review (500 MB)".into()); }
            for dest in [baseline.join(&rel), work.join(&rel)] {
                fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
                fs::copy(&source, &dest).map_err(|e| e.to_string())?;
            }
        }
        for rel in &linked {
            let target = root.join(rel);
            let dest = work.join(rel);
            fs::create_dir_all(dest.parent().ok_or("Invalid linked directory")?).map_err(|e| e.to_string())?;
            link_dir(&target, &dest).map_err(|e| e.to_string())?;
        }
        let review = Review { id, root: root.to_string_lossy().into(), workspace: work.to_string_lossy().into(), linked };
        fs::write(dir.join("review.json"), serde_json::to_vec(&review).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(review)
    })();
    if result.is_err() { let _ = fs::remove_dir_all(dir); }
    result
}

#[tauri::command]
pub async fn review_prepare(app: AppHandle, root: String, link_dirs: Option<Vec<String>>) -> Result<Review, String> {
    let root = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let id = format!("{}-{}", SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos(), std::process::id());
    prepare(&store(&app)?, &root, id, &link_dirs.unwrap_or_default())
}

/// Runs a user-configured setup or test command with the shadow copy as working directory (never the original project).
/// Approval is decided by the caller; this only bounds the timeout.
#[tauri::command]
pub async fn review_run(app: AppHandle, id: String, command: String, timeout_ms: Option<u64>) -> Result<crate::tools::CmdResult, String> {
    let work = review_dir(&app, &id)?.join("work");
    if !work.is_dir() { return Err("Review workspace not found".into()); }
    crate::tools::run_command(work.to_string_lossy().into_owned(), command, Some(timeout_ms.unwrap_or(300_000).min(900_000)), None).await
}

fn changes(dir: &Path) -> Result<Vec<Change>, String> {
    let baseline = dir.join("baseline"); let work = dir.join("work");
    let linked = read_linked(dir);
    let paths: BTreeSet<_> = files(&baseline, false)?.into_iter().chain(files(&work, false)?).filter(|p| !p.to_str().is_some_and(|p| under_any(p, &linked))).collect();
    let mut changes = Vec::new();
    for p in paths {
        let path = p.to_str().ok_or("Non-UTF8 filename")?;
        let old = bytes(&baseline, path)?; let new = bytes(&work, path)?;
        if old == new { continue; }
        let old_text = old.as_ref().and_then(|b| std::str::from_utf8(b).ok());
        let new_text = new.as_ref().and_then(|b| std::str::from_utf8(b).ok());
        changes.push(Change { path: path.into(), binary: old.as_ref().is_some_and(|b| b.contains(&0)) || new.as_ref().is_some_and(|b| b.contains(&0)) || (old.is_some() && old_text.is_none()) || (new.is_some() && new_text.is_none()) });
    }
    Ok(changes)
}

#[tauri::command]
pub async fn review_list(app: AppHandle, root: String) -> Result<Vec<(Review, Vec<Change>)>, String> {
    let root = Path::new(&root).canonicalize().map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    let parent = store(&app)?;
    if !parent.exists() { return Ok(Vec::new()); }
    let mut result = Vec::new();
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let dir = entry.map_err(|e| e.to_string())?.path();
        if !dir.join("review.json").exists() { continue; }
        let review: Review = serde_json::from_slice(&fs::read(dir.join("review.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if review.root == root { let list = changes(&dir)?; if !list.is_empty() { result.push((review, list)); } }
    }
    result.sort_by(|a, b| b.0.id.cmp(&a.0.id));
    Ok(result)
}

#[tauri::command]
pub async fn review_diff(app: AppHandle, id: String, path: String) -> Result<String, String> {
    let dir = review_dir(&app, &id)?;
    let old = resolve_in_root(&dir.join("baseline"), &path)?; let new = resolve_in_root(&dir.join("work"), &path)?;
    let out = Command::new("git").args(["diff", "--no-index", "--no-ext-diff", "--no-color", "--"]).arg(if old.exists() { old.as_path() } else { Path::new("/dev/null") }).arg(if new.exists() { new.as_path() } else { Path::new("/dev/null") }).output().map_err(|e| e.to_string())?;
    if !matches!(out.status.code(), Some(0 | 1)) { return Err(String::from_utf8_lossy(&out.stderr).into_owned()); }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn reject_linked(dir: &Path, path: &str) -> Result<(), String> {
    let normalized = Path::new(path).components().filter_map(|c| match c { Component::Normal(p) => p.to_str(), _ => None }).collect::<Vec<_>>().join("/");
    if under_any(&normalized, &read_linked(dir)) { return Err(format!("{path} is inside a linked dependency directory and is never applied.")); }
    Ok(())
}

fn decide(dir: &Path, root: &Path, path: &str, accept: bool) -> Result<(), String> {
    reject_linked(dir, path)?;
    let baseline = dir.join("baseline"); let work = dir.join("work");
    let old = bytes(&baseline, path)?; let new = bytes(&work, path)?;
    if accept {
        if bytes(root, path)? != old { return Err(format!("Conflict: {path} changed in the project. Nothing was applied.")); }
        put(root, path, &new)?;
        // Preserve executable flags when copying an existing/new file.
        if new.is_some() { fs::set_permissions(resolve_in_root(root, path)?, fs::metadata(resolve_in_root(&work, path)?).map_err(|e| e.to_string())?.permissions()).map_err(|e| e.to_string())?; }
        put(&baseline, path, &new)?;
    } else { put(&work, path, &old)?; }
    Ok(())
}

#[tauri::command]
pub async fn review_decide(app: AppHandle, id: String, path: String, accept: bool) -> Result<(), String> {
    let dir = review_dir(&app, &id)?;
    let review: Review = serde_json::from_slice(&fs::read(dir.join("review.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    decide(&dir, Path::new(&review.root), &path, accept)?;
    if changes(&dir)?.is_empty() { fs::remove_dir_all(&dir).map_err(|e| e.to_string())?; }
    Ok(())
}

/// Baseline and proposed text of a file when hunk-level decisions make sense: both exist and are text.
fn text_pair(dir: &Path, path: &str) -> Result<Option<(String, String)>, String> {
    reject_linked(dir, path)?;
    let (Some(old), Some(new)) = (bytes(&dir.join("baseline"), path)?, bytes(&dir.join("work"), path)?) else { return Ok(None) };
    if old.contains(&0) || new.contains(&0) { return Ok(None); }
    match (String::from_utf8(old), String::from_utf8(new)) { (Ok(o), Ok(n)) => Ok(Some((o, n))), _ => Ok(None) }
}

fn hunks_of(dir: &Path, path: &str) -> Result<Vec<hunks::Hunk>, String> {
    Ok(text_pair(dir, path)?.map(|(o, n)| hunks::plan(&o, &n).hunks).unwrap_or_default())
}

/// Applies (`accept`) or reverts the chosen hunks. Accepting writes only those hunks to the project after the usual baseline
/// check and advances the baseline by the same text, so the remaining hunks stay pending. Rejecting only edits the shadow copy.
fn decide_hunks(dir: &Path, root: &Path, path: &str, ids: &[String], accept: bool) -> Result<(), String> {
    if ids.is_empty() { return Err("No hunks selected".into()); }
    let (old, new) = text_pair(dir, path)?.ok_or("Hunks are only available for text files that exist in both versions")?;
    let plan = hunks::plan(&old, &new);
    let selected = plan.select(ids)?;
    let baseline = dir.join("baseline"); let work = dir.join("work");
    if accept {
        if bytes(root, path)?.as_deref() != Some(old.as_bytes()) { return Err(format!("Conflict: {path} changed in the project. Nothing was applied.")); }
        let content = Some(plan.apply(&selected).into_bytes());
        put(root, path, &content)?;
        fs::set_permissions(resolve_in_root(root, path)?, fs::metadata(resolve_in_root(&work, path)?).map_err(|e| e.to_string())?.permissions()).map_err(|e| e.to_string())?;
        put(&baseline, path, &content)?;
    } else {
        let keep: Vec<bool> = selected.iter().map(|s| !s).collect();
        put(&work, path, &Some(plan.apply(&keep).into_bytes()))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn review_hunks(app: AppHandle, id: String, path: String) -> Result<Vec<hunks::Hunk>, String> {
    hunks_of(&review_dir(&app, &id)?, &path)
}

#[tauri::command]
pub async fn review_decide_hunks(app: AppHandle, id: String, path: String, hunk_ids: Vec<String>, accept: bool) -> Result<(), String> {
    let dir = review_dir(&app, &id)?;
    let review: Review = serde_json::from_slice(&fs::read(dir.join("review.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    decide_hunks(&dir, Path::new(&review.root), &path, &hunk_ids, accept)?;
    if changes(&dir)?.is_empty() { fs::remove_dir_all(&dir).map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
pub async fn review_finish(app: AppHandle, id: String) -> Result<(), String> {
    let dir = review_dir(&app, &id)?;
    if dir.exists() && changes(&dir)?.is_empty() { fs::remove_dir_all(&dir).map_err(|e| e.to_string())?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn review_isolated_accept_reject_and_conflict() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().join("project"); fs::create_dir(&root).unwrap();
        fs::write(root.join("a.txt"), "original").unwrap(); fs::write(root.join("b.txt"), "keep").unwrap();
        let r = prepare(&temp.path().join("reviews"), &root, "1".into(), &[]).unwrap(); let dir = temp.path().join("reviews/1");
        let work = Path::new(&r.workspace);
        fs::write(work.join("a.txt"), "proposed").unwrap(); fs::remove_file(work.join("b.txt")).unwrap(); fs::write(work.join("new.txt"), "new").unwrap();
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "original"); assert_eq!(changes(&dir).unwrap().len(), 3);
        decide(&dir, &root, "a.txt", true).unwrap(); assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "proposed");
        decide(&dir, &root, "b.txt", false).unwrap(); assert_eq!(fs::read_to_string(work.join("b.txt")).unwrap(), "keep");
        fs::write(root.join("new.txt"), "user edit").unwrap(); assert!(decide(&dir, &root, "new.txt", true).is_err());
        assert_eq!(fs::read_to_string(root.join("new.txt")).unwrap(), "user edit");
        assert!(decide(&dir, &root, "../outside.txt", true).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn review_never_follows_symlinks() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().join("project"); fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside"); fs::create_dir(&outside).unwrap(); fs::write(outside.join("secret"), "secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let r = prepare(&temp.path().join("reviews"), &root, "2".into(), &[]).unwrap(); assert!(!Path::new(&r.workspace).join("link").exists());
        std::os::unix::fs::symlink(&outside, Path::new(&r.workspace).join("link")).unwrap();
        assert!(decide(&temp.path().join("reviews/2"), &root, "link/secret", true).is_err());
    }
    #[test]
    fn linked_dirs_are_symlinked_and_never_changed_or_applied() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().join("project"); fs::create_dir(&root).unwrap();
        fs::create_dir_all(root.join("node_modules/dep")).unwrap(); fs::write(root.join("node_modules/dep/index.js"), "dep").unwrap();
        fs::create_dir_all(root.join("packages/a/node_modules")).unwrap(); fs::write(root.join("packages/a/node_modules/x.js"), "x").unwrap();
        fs::create_dir_all(root.join("vendor/lib")).unwrap(); fs::write(root.join("vendor/lib/v.txt"), "v1").unwrap();
        fs::write(root.join("a.txt"), "original").unwrap();
        let link = ["node_modules".to_string(), "./packages/a/node_modules/".to_string(), "vendor".to_string(), "vendor/lib".to_string(), "missing".to_string()];
        let r = prepare(&temp.path().join("reviews"), &root, "3".into(), &link).unwrap(); let dir = temp.path().join("reviews/3");
        let work = Path::new(&r.workspace);
        // Nested duplicates collapse, missing dirs are skipped, paths are normalized.
        assert_eq!(r.linked, vec!["vendor", "node_modules", "packages/a/node_modules"]);
        for l in &r.linked {
            assert!(fs::symlink_metadata(work.join(l)).unwrap().file_type().is_symlink(), "{l}");
            assert_eq!(fs::canonicalize(work.join(l)).unwrap(), fs::canonicalize(root.join(l)).unwrap());
            assert!(!dir.join("baseline").join(l).exists(), "{l} must not be in the baseline");
        }
        assert_eq!(fs::read_to_string(work.join("node_modules/dep/index.js")).unwrap(), "dep");
        assert!(changes(&dir).unwrap().is_empty());
        assert_eq!(read_linked(&dir), r.linked);
        // A file the agent drops into a linked dir (through the link) is not a change and cannot be accepted or rejected.
        fs::write(work.join("vendor/lib/v.txt"), "tampered").unwrap(); fs::write(work.join("node_modules/new.js"), "new").unwrap();
        fs::write(work.join("a.txt"), "proposed").unwrap();
        let list = changes(&dir).unwrap(); assert_eq!(list.len(), 1); assert_eq!(list[0].path, "a.txt");
        for p in ["vendor/lib/v.txt", "node_modules/new.js", "./node_modules/dep/index.js", "node_modules/../node_modules/new.js", "packages/a/node_modules/x.js"] {
            assert!(decide(&dir, &root, p, true).is_err(), "{p} accept");
            assert!(decide(&dir, &root, p, false).is_err(), "{p} reject");
        }
        decide(&dir, &root, "a.txt", true).unwrap(); assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "proposed");
        // Removing the review (finish/accept-all) removes the links, never the original directories.
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(fs::read_to_string(root.join("node_modules/dep/index.js")).unwrap(), "dep");
        assert_eq!(fs::read_to_string(root.join("packages/a/node_modules/x.js")).unwrap(), "x");
    }
    #[cfg(unix)]
    #[test]
    fn unsafe_link_requests_are_rejected() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().join("project"); fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside"); fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
        fs::write(root.join("file.txt"), "f").unwrap(); fs::create_dir(root.join(".git")).unwrap();
        for bad in ["../outside", "/etc", "", ".", ".git", "a/../../outside", "escape", "file.txt"] {
            assert!(prepare(&temp.path().join("reviews"), &root, "4".into(), &[bad.to_string()]).is_err(), "{bad:?}");
            assert!(!temp.path().join("reviews/4").exists(), "failed prepare leaves nothing behind");
        }
    }
    #[test]
    fn old_review_json_without_linked_still_loads() {
        let r: Review = serde_json::from_str(r#"{"id":"1","root":"/p","workspace":"/w"}"#).unwrap();
        assert!(r.linked.is_empty());
    }
    #[test]
    fn partial_accept_applies_only_selected_hunks() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().join("project"); fs::create_dir(&root).unwrap();
        let old: String = (1..=30).map(|i| format!("line {i}\n")).collect();
        fs::write(root.join("f.txt"), &old).unwrap();
        let r = prepare(&temp.path().join("reviews"), &root, "5".into(), &[]).unwrap(); let dir = temp.path().join("reviews/5");
        let work = Path::new(&r.workspace);
        let new = old.replace("line 3\n", "THREE\n").replace("line 25\n", "TWENTY-FIVE\n");
        fs::write(work.join("f.txt"), &new).unwrap();
        let hs = hunks_of(&dir, "f.txt").unwrap(); assert_eq!(hs.len(), 2);
        // Stale ids and empty selection are refused without touching anything.
        assert!(decide_hunks(&dir, &root, "f.txt", &["stale".into()], true).is_err());
        assert!(decide_hunks(&dir, &root, "f.txt", &[], true).is_err());
        assert_eq!(fs::read_to_string(root.join("f.txt")).unwrap(), old);
        // Conflict check: the project changed since the baseline.
        fs::write(root.join("f.txt"), "user edit").unwrap();
        assert!(decide_hunks(&dir, &root, "f.txt", &[hs[0].id.clone()], true).is_err());
        assert_eq!(fs::read_to_string(root.join("f.txt")).unwrap(), "user edit");
        fs::write(root.join("f.txt"), &old).unwrap();
        // Accept the second hunk: only it reaches the project, the first stays pending, the shadow copy is untouched.
        decide_hunks(&dir, &root, "f.txt", &[hs[1].id.clone()], true).unwrap();
        assert_eq!(fs::read_to_string(root.join("f.txt")).unwrap(), old.replace("line 25\n", "TWENTY-FIVE\n"));
        assert_eq!(fs::read_to_string(work.join("f.txt")).unwrap(), new);
        let left = hunks_of(&dir, "f.txt").unwrap(); assert_eq!(left.len(), 1); assert!(left[0].lines.iter().any(|l| l.text == "THREE"));
        assert_eq!(changes(&dir).unwrap().len(), 1);
        // Reject the remaining hunk: the shadow copy now equals the project and the change is gone.
        decide_hunks(&dir, &root, "f.txt", &[left[0].id.clone()], false).unwrap();
        assert_eq!(fs::read_to_string(work.join("f.txt")).unwrap(), old.replace("line 25\n", "TWENTY-FIVE\n"));
        assert!(changes(&dir).unwrap().is_empty());
    }
    #[test]
    fn hunk_decisions_skip_linked_and_non_text_files() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().join("project"); fs::create_dir_all(root.join("vendor")).unwrap();
        fs::write(root.join("vendor/x.txt"), "x").unwrap(); fs::write(root.join("bin"), [0u8, 1, 2]).unwrap(); fs::write(root.join("t.txt"), "a\n").unwrap();
        let r = prepare(&temp.path().join("reviews"), &root, "6".into(), &["vendor".into()]).unwrap(); let dir = temp.path().join("reviews/6");
        let work = Path::new(&r.workspace);
        assert!(hunks_of(&dir, "vendor/x.txt").is_err());
        assert!(decide_hunks(&dir, &root, "vendor/x.txt", &["h".into()], true).is_err());
        fs::write(work.join("bin"), [0u8, 9]).unwrap(); fs::write(work.join("t.txt"), "b\n").unwrap(); fs::write(work.join("new.txt"), "n\n").unwrap();
        assert!(hunks_of(&dir, "bin").unwrap().is_empty());
        assert!(hunks_of(&dir, "new.txt").unwrap().is_empty());
        assert_eq!(hunks_of(&dir, "t.txt").unwrap().len(), 1);
        assert!(decide_hunks(&dir, &root, "new.txt", &["h".into()], true).is_err());
    }
}
