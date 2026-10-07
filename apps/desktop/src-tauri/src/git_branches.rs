//! Branch picker backend: list local and remote branches and switch between them.
//!
//! Switching must never lose work. The only commands used are `git switch` (never `--force`, `--discard-changes`
//! or `-C`), `git stash push` and `git stash pop`; a dirty tree is refused with a `dirty:` error unless the caller
//! explicitly asks to stash first (the stash is named, and restored on the new branch when that applies cleanly;
//! a conflicting restore leaves the stash in place). Names are validated with `check-ref-format` and must resolve
//! to an existing ref; every call is an argument array, never a shell.
//!
//! Error strings start with a code: `not_a_repo:`, `dirty: <count>`, `in_progress:`, `unknown_branch:`,
//! `checked_out_elsewhere:`, `invalid_name:`, `git_error:`.
use crate::git::{blocking, canonical_root, current_branch, run_git};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

const MAX_BRANCHES: usize = 500;

static SWITCH_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BranchEntry {
    /// `feature/x` for a local branch, `origin/feature/x` for a remote-tracking one.
    pub name: String,
    pub remote: bool,
    pub current: bool,
    /// Another worktree has this branch checked out, so it cannot be switched to here.
    pub checked_out_at: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    pub repo: bool,
    pub current: Option<String>,
    pub detached: bool,
    pub head: Option<String>,
    pub branches: Vec<BranchEntry>,
    /// More branches exist than were listed.
    pub truncated: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
    pub branch: Option<String>,
    /// The changes were stashed before switching.
    pub stashed: bool,
    /// The stash was applied again on the new branch.
    pub restored: bool,
}

fn code(c: &str, msg: impl std::fmt::Display) -> String {
    format!("{c}: {msg}")
}

fn lock_for(top: &Path) -> Arc<Mutex<()>> {
    let mut map = SWITCH_LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(top.to_path_buf()).or_default().clone()
}

fn toplevel(root: &Path) -> Option<PathBuf> {
    let out = run_git(root, ["rev-parse", "--show-toplevel"]).ok()?;
    let p = PathBuf::from(out.trim());
    p.canonicalize().ok().or(Some(p))
}

/// Branch name -> worktree path, for every worktree except the one at `top`.
fn other_worktrees(root: &Path, top: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(raw) = run_git(root, ["worktree", "list", "--porcelain"]) else {
        return map;
    };
    let mut path: Option<String> = None;
    for line in raw.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            if let Some(p) = &path {
                let same = PathBuf::from(p)
                    .canonicalize()
                    .map(|c| c == top)
                    .unwrap_or(false);
                if !same {
                    map.insert(b.to_string(), p.clone());
                }
            }
        }
    }
    map
}

pub fn list_branches(root: &Path) -> Result<BranchList, String> {
    let Some(top) = toplevel(root) else {
        return Ok(BranchList {
            repo: false,
            current: None,
            detached: false,
            head: None,
            branches: vec![],
            truncated: false,
        });
    };
    let current = current_branch(root);
    let head = run_git(root, ["rev-parse", "--short", "--verify", "-q", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let raw = run_git(
        root,
        [
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let elsewhere = other_worktrees(root, &top);
    let mut locals: Vec<BranchEntry> = Vec::new();
    let mut remotes: Vec<String> = Vec::new();
    for r in raw.lines() {
        if let Some(n) = r.strip_prefix("refs/heads/") {
            locals.push(BranchEntry {
                name: n.to_string(),
                remote: false,
                current: current.as_deref() == Some(n),
                checked_out_at: elsewhere.get(n).cloned(),
            });
        } else if let Some(n) = r.strip_prefix("refs/remotes/") {
            if !n.ends_with("/HEAD") && n.contains('/') {
                remotes.push(n.to_string());
            }
        }
    }
    // A remote branch that already has a local branch of the same short name is that local branch.
    let local_names: HashSet<String> = locals.iter().map(|b| b.name.clone()).collect();
    let remote_entries: Vec<BranchEntry> = remotes
        .into_iter()
        .filter(|n| {
            n.split_once('/')
                .map(|(_, short)| !local_names.contains(short))
                .unwrap_or(false)
        })
        .map(|n| BranchEntry {
            name: n,
            remote: true,
            current: false,
            checked_out_at: None,
        })
        .collect();
    let mut branches: Vec<BranchEntry> = locals.into_iter().chain(remote_entries).collect();
    // The current branch first, then by recency (already sorted; the sort is stable).
    branches.sort_by_key(|b| !b.current);
    let truncated = branches.len() > MAX_BRANCHES;
    branches.truncate(MAX_BRANCHES);
    Ok(BranchList {
        repo: true,
        detached: current.is_none(),
        current,
        head,
        branches,
        truncated,
    })
}

fn dirty_count(root: &Path) -> Result<usize, String> {
    let raw = run_git(
        root,
        [
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=normal",
        ],
    )?;
    Ok(raw.split('\0').filter(|e| !e.is_empty()).count())
}

fn in_progress(root: &Path) -> Option<&'static str> {
    let dir = PathBuf::from(
        run_git(root, ["rev-parse", "--absolute-git-dir"])
            .ok()?
            .trim(),
    );
    [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
    ]
    .into_iter()
    .find(|(m, _)| dir.join(m).exists())
    .map(|(_, n)| n)
}

/// Switches to an existing local branch, or creates a tracking branch for a remote one (`origin/x` -> `x`).
/// A dirty tree is refused unless `stash` is set.
pub fn switch_branch(
    root: &Path,
    name: &str,
    remote: bool,
    stash: bool,
) -> Result<SwitchResult, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 200
        || name.starts_with('-')
        || name == "HEAD"
        || name.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(code("invalid_name", name));
    }
    let Some(top) = toplevel(root) else {
        return Err(code("not_a_repo", "this project is not a git repository"));
    };
    if run_git(root, ["check-ref-format", &format!("refs/heads/{name}")]).is_err() {
        return Err(code("invalid_name", name));
    }
    let lock = lock_for(&top);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    let full = if remote {
        format!("refs/remotes/{name}")
    } else {
        format!("refs/heads/{name}")
    };
    if run_git(
        root,
        ["rev-parse", "--verify", "-q", &format!("{full}^{{commit}}")],
    )
    .is_err()
    {
        return Err(code("unknown_branch", name));
    }
    if let Some(op) = in_progress(root) {
        return Err(code(
            "in_progress",
            format!("a {op} is in progress; finish it first"),
        ));
    }
    let current = current_branch(root);
    if !remote && current.as_deref() == Some(name) {
        return Ok(SwitchResult {
            branch: current,
            stashed: false,
            restored: false,
        });
    }
    // For a remote branch the local name is the part after the remote; an existing local branch of that name is reused.
    let target_local = if remote {
        name.split_once('/')
            .map(|(_, s)| s.to_string())
            .unwrap_or_default()
    } else {
        name.to_string()
    };
    if target_local.is_empty() {
        return Err(code("invalid_name", name));
    }
    if let Some(path) = other_worktrees(root, &top).get(&target_local) {
        return Err(code("checked_out_elsewhere", path));
    }
    let local_exists = run_git(
        root,
        [
            "rev-parse",
            "--verify",
            "-q",
            &format!("refs/heads/{target_local}"),
        ],
    )
    .is_ok();

    let dirty = dirty_count(root)?;
    if dirty > 0 && !stash {
        return Err(code("dirty", dirty));
    }
    let mut stashed = false;
    if dirty > 0 {
        let label = format!("gustaf: before switching to {target_local}");
        run_git(root, ["stash", "push", "--include-untracked", "-m", &label])
            .map_err(|e| code("git_error", e))?;
        stashed = true;
    }
    let switched = if remote && !local_exists {
        run_git(root, ["switch", "-q", "--track", name])
    } else {
        run_git(root, ["switch", "-q", &target_local])
    };
    if let Err(e) = switched {
        // Put the work back where it was; if even that fails the stash stays and the message says so.
        if stashed && run_git(root, ["stash", "pop", "-q"]).is_err() {
            return Err(code("git_error", format!("{e}\nYour changes are saved in the latest stash (\"gustaf: before switching to {target_local}\"); run `git stash pop` to restore them.")));
        }
        return Err(code("git_error", e));
    }
    // `stash pop` keeps the stash when applying conflicts, so nothing is lost.
    let restored = stashed && run_git(root, ["stash", "pop", "-q"]).is_ok();
    Ok(SwitchResult {
        branch: current_branch(root),
        stashed,
        restored,
    })
}

/// Local and remote branches of the project's repository (`repo: false` when there is none).
#[tauri::command]
pub async fn git_branches(root: String) -> Result<BranchList, String> {
    blocking(move || list_branches(&canonical_root(&root)?)).await
}

/// Switches branch (never forced). `stash`: stash uncommitted changes first and restore them afterwards.
#[tauri::command]
pub async fn git_switch_branch(
    root: String,
    name: String,
    remote: bool,
    stash: bool,
) -> Result<SwitchResult, String> {
    blocking(move || switch_branch(&canonical_root(&root)?, &name, remote, stash)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};

    fn g(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    struct Fx {
        _tmp: tempfile::TempDir,
        base: PathBuf,
        root: PathBuf,
    }

    /// `canonicalize` returns `\\?\C:\...` on Windows, which `git init --bare` and `git worktree add` reject ("Invalid argument").
    fn plain(p: PathBuf) -> PathBuf {
        match p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
            Some(rest) => PathBuf::from(rest),
            None => p,
        }
    }

    fn fx() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let base = plain(tmp.path().canonicalize().unwrap());
        let root = base.join("repo");
        fs::create_dir_all(&root).unwrap();
        g(&root, &["init", "-q"]);
        g(&root, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        for (k, v) in [
            ("user.name", "T"),
            ("user.email", "t@e.x"),
            ("commit.gpgsign", "false"),
            ("core.hooksPath", "/dev/null"),
        ] {
            g(&root, &["config", k, v]);
        }
        fs::write(root.join("a.txt"), "1\n").unwrap();
        g(&root, &["add", "-A"]);
        g(&root, &["commit", "-qm", "init"]);
        Fx {
            _tmp: tmp,
            base,
            root,
        }
    }

    fn cur(f: &Fx) -> Option<String> {
        current_branch(&f.root)
    }

    fn with_remote(f: &Fx) -> PathBuf {
        let remote = f.base.join("remote.git");
        g(&f.base, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        g(
            &f.root,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        remote
    }

    #[test]
    fn lists_local_and_remote_branches_without_duplicates() {
        let f = fx();
        g(&f.root, &["branch", "feature/x"]);
        with_remote(&f);
        g(
            &f.root,
            &["push", "-q", "origin", "main", "main:only-remote"],
        );
        g(&f.root, &["fetch", "-q", "origin"]);
        let l = list_branches(&f.root).unwrap();
        assert!(l.repo && !l.detached);
        assert_eq!(l.current.as_deref(), Some("main"));
        let names: Vec<(&str, bool)> = l
            .branches
            .iter()
            .map(|b| (b.name.as_str(), b.remote))
            .collect();
        assert_eq!(names[0], ("main", false));
        assert!(names.contains(&("feature/x", false)));
        assert!(names.contains(&("origin/only-remote", true)));
        assert!(
            !names.contains(&("origin/main", true)),
            "origin/main is the local main"
        );
        assert!(!names.iter().any(|(n, _)| n.ends_with("/HEAD")));
    }

    #[test]
    fn not_a_repo_is_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!list_branches(tmp.path()).unwrap().repo);
        assert!(switch_branch(tmp.path(), "main", false, false)
            .unwrap_err()
            .starts_with("not_a_repo:"));
    }

    #[test]
    fn switches_a_clean_tree() {
        let f = fx();
        g(&f.root, &["branch", "other"]);
        let r = switch_branch(&f.root, "other", false, false).unwrap();
        assert_eq!(r.branch.as_deref(), Some("other"));
        assert!(!r.stashed);
        assert_eq!(cur(&f).as_deref(), Some("other"));
    }

    #[test]
    fn refuses_a_dirty_tree_and_keeps_every_change() {
        let f = fx();
        g(&f.root, &["branch", "other"]);
        fs::write(f.root.join("a.txt"), "edited\n").unwrap();
        fs::write(f.root.join("new.txt"), "untracked\n").unwrap();
        let e = switch_branch(&f.root, "other", false, false).unwrap_err();
        assert_eq!(e, "dirty: 2");
        assert_eq!(cur(&f).as_deref(), Some("main"));
        // git on Windows may restore the stashed file with CRLF line endings.
        assert_eq!(
            fs::read_to_string(f.root.join("a.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "edited\n"
        );
        assert!(f.root.join("new.txt").exists());
        assert!(g(&f.root, &["stash", "list"]).is_empty());
    }

    #[test]
    fn stash_option_moves_the_work_along() {
        let f = fx();
        g(&f.root, &["branch", "other"]);
        fs::write(f.root.join("a.txt"), "edited\n").unwrap();
        fs::write(f.root.join("new.txt"), "untracked\n").unwrap();
        let r = switch_branch(&f.root, "other", false, true).unwrap();
        assert!(r.stashed && r.restored);
        assert_eq!(cur(&f).as_deref(), Some("other"));
        assert_eq!(
            fs::read_to_string(f.root.join("a.txt")).unwrap(),
            "edited\n"
        );
        assert!(f.root.join("new.txt").exists());
        assert!(g(&f.root, &["stash", "list"]).is_empty());
    }

    #[test]
    fn a_conflicting_restore_keeps_the_stash() {
        let f = fx();
        g(&f.root, &["checkout", "-q", "-b", "other"]);
        fs::write(f.root.join("a.txt"), "other side\n").unwrap();
        g(&f.root, &["commit", "-qam", "other"]);
        g(&f.root, &["checkout", "-q", "main"]);
        fs::write(f.root.join("a.txt"), "my edit\n").unwrap();
        let r = switch_branch(&f.root, "other", false, true).unwrap();
        assert!(r.stashed && !r.restored);
        assert_eq!(cur(&f).as_deref(), Some("other"));
        assert!(
            g(&f.root, &["stash", "list"]).contains("gustaf: before switching to other"),
            "the work must survive in the stash"
        );
    }

    #[test]
    fn tracks_a_remote_branch_and_reuses_an_existing_local_one() {
        let f = fx();
        with_remote(&f);
        g(&f.root, &["push", "-q", "origin", "main:topic"]);
        g(&f.root, &["fetch", "-q", "origin"]);
        let r = switch_branch(&f.root, "origin/topic", true, false).unwrap();
        assert_eq!(r.branch.as_deref(), Some("topic"));
        assert_eq!(
            g(&f.root, &["rev-parse", "--abbrev-ref", "topic@{upstream}"]).trim(),
            "origin/topic"
        );
        g(&f.root, &["switch", "-q", "main"]);
        assert_eq!(
            switch_branch(&f.root, "origin/topic", true, false)
                .unwrap()
                .branch
                .as_deref(),
            Some("topic")
        );
    }

    #[test]
    fn rejects_bad_unknown_and_option_like_names() {
        let f = fx();
        for bad in ["", "--detach", "-f", "a b", "a..b", "HEAD"] {
            assert!(
                switch_branch(&f.root, bad, false, false)
                    .unwrap_err()
                    .starts_with("invalid_name:"),
                "{bad:?}"
            );
        }
        assert!(switch_branch(&f.root, "nope", false, false)
            .unwrap_err()
            .starts_with("unknown_branch:"));
        assert!(switch_branch(&f.root, "origin/nope", true, false)
            .unwrap_err()
            .starts_with("unknown_branch:"));
        assert_eq!(cur(&f).as_deref(), Some("main"));
    }

    #[test]
    fn refuses_during_a_merge_and_for_a_branch_checked_out_in_a_worktree() {
        let f = fx();
        g(&f.root, &["branch", "other"]);
        let wt = f.base.join("wt");
        g(
            &f.root,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "wtb"],
        );
        let e = switch_branch(&f.root, "wtb", false, false).unwrap_err();
        assert!(e.starts_with("checked_out_elsewhere:"), "{e}");
        let l = list_branches(&f.root).unwrap();
        assert!(l
            .branches
            .iter()
            .find(|b| b.name == "wtb")
            .unwrap()
            .checked_out_at
            .is_some());
        // The worktree itself lists its own branch as current and not elsewhere.
        let lw = list_branches(&wt).unwrap();
        assert_eq!(lw.current.as_deref(), Some("wtb"));
        assert!(lw
            .branches
            .iter()
            .find(|b| b.name == "wtb")
            .unwrap()
            .checked_out_at
            .is_none());
        fs::write(
            f.root.join(".git/MERGE_HEAD"),
            g(&f.root, &["rev-parse", "HEAD"]),
        )
        .unwrap();
        assert!(switch_branch(&f.root, "other", false, false)
            .unwrap_err()
            .starts_with("in_progress:"));
    }
}
