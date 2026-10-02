use crate::tools::resolve_in_root;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, path::{Path, PathBuf}, process::Command, time::{SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize)]
pub struct Review { pub id: String, pub root: String, pub workspace: String }
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

fn prepare(parent: &Path, root: &Path, id: String) -> Result<Review, String> {
    let dir = parent.join(&id);
    let baseline = dir.join("baseline");
    let work = dir.join("work");
    fs::create_dir_all(&baseline).map_err(|e| e.to_string())?;
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let result = (|| {
        let list = files(root, true)?;
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
        let review = Review { id, root: root.to_string_lossy().into(), workspace: work.to_string_lossy().into() };
        fs::write(dir.join("review.json"), serde_json::to_vec(&review).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(review)
    })();
    if result.is_err() { let _ = fs::remove_dir_all(dir); }
    result
}

#[tauri::command]
pub async fn review_prepare(app: AppHandle, root: String) -> Result<Review, String> {
    let root = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
    let id = format!("{}-{}", SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos(), std::process::id());
    prepare(&store(&app)?, &root, id)
}

fn changes(dir: &Path) -> Result<Vec<Change>, String> {
    let baseline = dir.join("baseline"); let work = dir.join("work");
    let paths: BTreeSet<_> = files(&baseline, false)?.into_iter().chain(files(&work, false)?).collect();
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

fn decide(dir: &Path, root: &Path, path: &str, accept: bool) -> Result<(), String> {
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
        let r = prepare(&temp.path().join("reviews"), &root, "1".into()).unwrap(); let dir = temp.path().join("reviews/1");
        let work = Path::new(&r.workspace);
        fs::write(work.join("a.txt"), "proposed").unwrap(); fs::remove_file(work.join("b.txt")).unwrap(); fs::write(work.join("new.txt"), "new").unwrap();
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "original"); assert_eq!(changes(&dir).unwrap().len(), 3);
        decide(&dir, &root, "a.txt", true).unwrap(); assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "proposed");
        decide(&dir, &root, "b.txt", false).unwrap(); assert_eq!(fs::read_to_string(work.join("b.txt")).unwrap(), "keep");
        fs::write(root.join("new.txt"), "user edit").unwrap(); assert!(decide(&dir, &root, "new.txt", true).is_err());
        assert_eq!(fs::read_to_string(root.join("new.txt")).unwrap(), "user edit");
        assert!(decide(&dir, &root, "../outside.txt", true).is_err());
    }
    #[test]
    fn review_never_follows_symlinks() {
        let temp = tempfile::tempdir().unwrap(); let root = temp.path().join("project"); fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside"); fs::create_dir(&outside).unwrap(); fs::write(outside.join("secret"), "secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let r = prepare(&temp.path().join("reviews"), &root, "2".into()).unwrap(); assert!(!Path::new(&r.workspace).join("link").exists());
        std::os::unix::fs::symlink(&outside, Path::new(&r.workspace).join("link")).unwrap();
        assert!(decide(&temp.path().join("reviews/2"), &root, "link/secret", true).is_err());
    }
}
