//! One-time move of the data written by builds from before the rename to Gustaf.
//!
//! Those builds used the bundle identifier [`OLD_IDENTIFIER`], so their database, settings, worktrees, Cursor profiles
//! and the rest live in folders named after it (macOS: `~/Library/Application Support/<id>`; Windows: `%APPDATA%\<id>`
//! and `%LOCALAPPDATA%\<id>`; Linux: `~/.local/share/<id>` and `~/.config/<id>`). [`migrate_app_dirs`] runs before Tauri
//! starts (before any window or the database opens) and moves each such folder to the name for [`IDENTIFIER`] when the
//! new one holds nothing yet. A rename is tried first; across file systems the folder is copied and the old one is
//! removed only after the copy completed. Any failure leaves the old folder untouched, and the outcome is logged.
//! Keychain entries are moved lazily by `secrets.rs` (read under the old service, written under the new one).
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The bundle identifier (must match `tauri.conf.json`).
pub const IDENTIFIER: &str = "io.github.libes6.gustaf";
/// The identifier of the builds from before the rename; only read to migrate data.
pub const OLD_IDENTIFIER: &str = "com.maksimkulakov.mcode";

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No old folder.
    NothingToMigrate,
    /// The new folder already holds data; the old one is left alone.
    NewHasData,
    Renamed,
    /// Copied; `old_removed` is false when deleting the old folder afterwards failed (the copy is complete either way).
    Copied {
        old_removed: bool,
    },
    /// Nothing changed in the old folder.
    Failed(String),
}

/// True when `dir` does not exist or holds nothing but Finder's `.DS_Store`.
fn is_empty_dir(dir: &Path) -> io::Result<bool> {
    match fs::read_dir(dir) {
        Ok(entries) => {
            for e in entries {
                if e?.file_name() != ".DS_Store" {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e),
    }
}

/// Copies a tree without following links (symlinks are recreated as symlinks: worktrees and review copies link
/// dependency folders of the projects).
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            copy_link(&src, &dst)?;
        } else if kind.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn copy_link(src: &Path, dst: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(fs::read_link(src)?, dst)
}

#[cfg(windows)]
fn copy_link(src: &Path, dst: &Path) -> io::Result<()> {
    let target = fs::read_link(src)?;
    if fs::metadata(src).map(|m| m.is_dir()).unwrap_or(false) {
        std::os::windows::fs::symlink_dir(target, dst)
    } else {
        std::os::windows::fs::symlink_file(target, dst)
    }
}

/// Moves `old` to `new` unless `new` already holds data. See the module docs.
pub fn migrate_dir(old: &Path, new: &Path) -> Outcome {
    migrate_dir_with(old, new, |a, b| fs::rename(a, b))
}

/// [`migrate_dir`] with the first move attempt injectable (tests force the copy fallback with it).
fn migrate_dir_with(
    old: &Path,
    new: &Path,
    rename: impl Fn(&Path, &Path) -> io::Result<()>,
) -> Outcome {
    match fs::symlink_metadata(old) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Outcome::Failed(format!("{} is not a folder", old.display())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Outcome::NothingToMigrate,
        Err(e) => return Outcome::Failed(e.to_string()),
    }
    match is_empty_dir(new) {
        Ok(false) => return Outcome::NewHasData,
        Err(e) => return Outcome::Failed(format!("cannot read {}: {e}", new.display())),
        Ok(true) => {}
    }
    // An empty new folder (e.g. created by an earlier start) is in the way of the rename.
    if new.exists() {
        if let Err(e) = fs::remove_dir_all(new) {
            return Outcome::Failed(format!("cannot clear the empty {}: {e}", new.display()));
        }
    }
    if let Some(parent) = new.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return Outcome::Failed(e.to_string());
        }
    }
    if rename(old, new).is_ok() {
        return Outcome::Renamed;
    }
    // Rename failed (another volume, permissions): copy into a temporary sibling, then put it in place.
    let partial = new.with_file_name(format!(
        "{}.migrating",
        new.file_name().and_then(|n| n.to_str()).unwrap_or("data")
    ));
    let _ = fs::remove_dir_all(&partial);
    if let Err(e) = copy_tree(old, &partial).and_then(|_| fs::rename(&partial, new)) {
        let _ = fs::remove_dir_all(&partial);
        return Outcome::Failed(format!("copy failed: {e}"));
    }
    Outcome::Copied {
        old_removed: fs::remove_dir_all(old).is_ok(),
    }
}

/// The folder an old build used next to `new` (Tauri puts every app folder at `<platform dir>/<identifier>`).
pub fn old_dir_for(new: &Path) -> Option<PathBuf> {
    (new.file_name()?.to_str()? == IDENTIFIER).then(|| new.with_file_name(OLD_IDENTIFIER))
}

/// Git worktrees under the moved data folder still have their old path recorded in the project's `.git/worktrees/*/gitdir`.
/// `git worktree repair`, run inside each checkout, rewrites that record. Best effort.
fn repair_worktrees(data: &Path) {
    fn walk(dir: &Path, depth: usize) {
        if depth > 3 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let path = e.path();
            if !e.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            if path.join(".git").is_file() {
                let _ = std::process::Command::new("git")
                    .arg("-C")
                    .arg(&path)
                    .args(["worktree", "repair"])
                    .output();
            } else {
                walk(&path, depth + 1);
            }
        }
    }
    walk(&data.join("worktrees"), 0);
}

fn log(data: Option<&Path>, line: &str) {
    eprintln!("gustaf migration: {line}");
    if let Some(dir) = data {
        use std::io::Write;
        if fs::create_dir_all(dir).is_ok() {
            if let Ok(mut f) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("migration.log"))
            {
                let _ = writeln!(f, "{line}");
            }
        }
    }
}

/// The app folders Tauri resolves on desktop (`app_data_dir`, `app_local_data_dir`, `app_config_dir`), deduplicated.
fn app_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for base in [dirs::data_dir(), dirs::data_local_dir(), dirs::config_dir()]
        .into_iter()
        .flatten()
    {
        let dir = base.join(IDENTIFIER);
        if !out.contains(&dir) {
            out.push(dir);
        }
    }
    out
}

/// Runs once per start, before Tauri; cheap when there is nothing to move.
pub fn migrate_app_dirs() {
    let data = dirs::data_dir().map(|d| d.join(IDENTIFIER));
    for new in app_dirs() {
        let Some(old) = old_dir_for(&new) else {
            continue;
        };
        let outcome = migrate_dir(&old, &new);
        match &outcome {
            Outcome::NothingToMigrate => continue,
            Outcome::NewHasData => continue,
            _ => {}
        }
        log(
            data.as_deref(),
            &format!("{} -> {}: {outcome:?}", old.display(), new.display()),
        );
        if matches!(outcome, Outcome::Renamed | Outcome::Copied { .. })
            && data.as_deref() == Some(new.as_path())
        {
            repair_worktrees(&new);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, text: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn identifier_matches_the_tauri_config() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], IDENTIFIER);
        assert_ne!(IDENTIFIER, OLD_IDENTIFIER);
    }

    #[test]
    fn old_dir_sits_next_to_the_new_one() {
        let new = Path::new("/base/support").join(IDENTIFIER);
        assert_eq!(
            old_dir_for(&new),
            Some(Path::new("/base/support").join(OLD_IDENTIFIER))
        );
        assert_eq!(old_dir_for(Path::new("/base/other")), None);
    }

    #[test]
    fn moves_the_old_folder_when_the_new_one_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join(OLD_IDENTIFIER), tmp.path().join(IDENTIFIER));
        write(&old.join("app.db"), "db");
        write(&old.join("worktrees/a/b/file"), "x");
        assert_eq!(migrate_dir(&old, &new), Outcome::Renamed);
        assert!(!old.exists());
        assert_eq!(fs::read_to_string(new.join("app.db")).unwrap(), "db");
        assert_eq!(
            fs::read_to_string(new.join("worktrees/a/b/file")).unwrap(),
            "x"
        );
        // A second start finds nothing to do.
        assert_eq!(migrate_dir(&old, &new), Outcome::NothingToMigrate);
    }

    #[test]
    fn an_empty_new_folder_does_not_block_the_move() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join(OLD_IDENTIFIER), tmp.path().join(IDENTIFIER));
        write(&old.join("app.db"), "db");
        fs::create_dir_all(&new).unwrap();
        write(&new.join(".DS_Store"), "");
        assert_eq!(migrate_dir(&old, &new), Outcome::Renamed);
        assert_eq!(fs::read_to_string(new.join("app.db")).unwrap(), "db");
    }

    #[test]
    fn never_touches_either_folder_when_the_new_one_has_data() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join(OLD_IDENTIFIER), tmp.path().join(IDENTIFIER));
        write(&old.join("app.db"), "old");
        write(&new.join("app.db"), "new");
        assert_eq!(migrate_dir(&old, &new), Outcome::NewHasData);
        assert_eq!(fs::read_to_string(old.join("app.db")).unwrap(), "old");
        assert_eq!(fs::read_to_string(new.join("app.db")).unwrap(), "new");
    }

    #[test]
    fn nothing_to_do_without_an_old_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join(OLD_IDENTIFIER), tmp.path().join(IDENTIFIER));
        assert_eq!(migrate_dir(&old, &new), Outcome::NothingToMigrate);
        assert!(!new.exists());
    }

    #[test]
    fn a_file_in_place_of_the_old_folder_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join(OLD_IDENTIFIER), tmp.path().join(IDENTIFIER));
        write(&old, "not a folder");
        assert!(matches!(migrate_dir(&old, &new), Outcome::Failed(_)));
        assert!(old.is_file());
    }

    #[cfg(unix)]
    #[test]
    fn copy_keeps_links_as_links() {
        let tmp = tempfile::tempdir().unwrap();
        let (from, to) = (tmp.path().join("from"), tmp.path().join("to"));
        write(&from.join("dir/file"), "x");
        std::os::unix::fs::symlink("/nonexistent/target", from.join("dir/link")).unwrap();
        copy_tree(&from, &to).unwrap();
        assert_eq!(fs::read_to_string(to.join("dir/file")).unwrap(), "x");
        assert_eq!(
            fs::read_link(to.join("dir/link")).unwrap(),
            Path::new("/nonexistent/target")
        );
        assert!(from.join("dir/file").exists());
    }

    #[test]
    fn falls_back_to_a_copy_when_rename_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join(OLD_IDENTIFIER), tmp.path().join(IDENTIFIER));
        write(&old.join("app.db"), "db");
        write(&old.join("knowledge/k/index"), "i");
        let refuse = |_: &Path, _: &Path| Err(io::Error::other("cross-device"));
        assert_eq!(
            migrate_dir_with(&old, &new, refuse),
            Outcome::Copied { old_removed: true }
        );
        assert!(!old.exists());
        assert_eq!(fs::read_to_string(new.join("app.db")).unwrap(), "db");
        assert_eq!(
            fs::read_to_string(new.join("knowledge/k/index")).unwrap(),
            "i"
        );
        assert!(!tmp.path().join(format!("{IDENTIFIER}.migrating")).exists());
    }

    #[test]
    fn a_failed_move_leaves_the_old_folder_intact() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join(OLD_IDENTIFIER);
        write(&old.join("app.db"), "db");
        // The parent of the new folder cannot be created: a file is in the way.
        write(&tmp.path().join("blocked"), "");
        let new = tmp.path().join("blocked").join(IDENTIFIER);
        assert!(matches!(migrate_dir(&old, &new), Outcome::Failed(_)));
        assert_eq!(fs::read_to_string(old.join("app.db")).unwrap(), "db");
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_copy_removes_the_partial_copy_and_keeps_the_old_folder() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let (old, new) = (tmp.path().join(OLD_IDENTIFIER), tmp.path().join(IDENTIFIER));
        write(&old.join("a"), "a");
        write(&old.join("secret/b"), "b");
        fs::set_permissions(old.join("secret"), fs::Permissions::from_mode(0o000)).unwrap();
        let readable = fs::read_dir(old.join("secret")).is_ok(); // root ignores permissions
        let refuse = |_: &Path, _: &Path| Err(io::Error::other("cross-device"));
        let outcome = migrate_dir_with(&old, &new, refuse);
        fs::set_permissions(old.join("secret"), fs::Permissions::from_mode(0o755)).unwrap();
        if !readable {
            assert!(matches!(outcome, Outcome::Failed(_)), "{outcome:?}");
            assert!(!new.exists());
            assert!(!tmp.path().join(format!("{IDENTIFIER}.migrating")).exists());
            assert_eq!(fs::read_to_string(old.join("secret/b")).unwrap(), "b");
            assert_eq!(fs::read_to_string(old.join("a")).unwrap(), "a");
        }
    }
}
