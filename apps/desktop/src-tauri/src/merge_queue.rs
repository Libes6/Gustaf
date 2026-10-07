//! Early conflict detection and a merge queue for Gustaf-managed git worktrees (`worktree.rs`).
//!
//! * `check_conflicts` (command `conflicts_check`) asks git (`git merge-tree --write-tree`, git >= 2.38) whether a workspace branch would merge
//!   cleanly into its target branch or into other workspace branches. It is read-only: it creates loose objects in
//!   the object database and never touches an index or a working tree.
//! * The merge queue integrates workspace branches into the target branch of the main checkout one item at a time.
//!   `run_next` processes exactly one item and returns the new state, so the caller (UI or agent loop) drives it and
//!   the optional test command goes through the normal command-approval path: the Rust side never executes it
//!   (`needs_test` outcome, then `report_test`). Nothing here pushes, forces or deletes anything.
//!
//! State lives next to the worktree store for the repository (`<store>/<hash>/.merge-queue.json`, atomic writes) and
//! a lock file (`.merge-queue.lock`, stale recovery by dead pid or age) serialises mutations per repository. Both
//! names start with a dot so they can never collide with a task id.
//!
//! Errors are strings of the form `<code>: <message>` (see `MergeQueueErrorCode` in `src/lib/mergeQueue.ts`). The
//! worktree codes (`not_a_git_repo`, `bare_repo`, `no_commits`, `invalid_task_id`, `not_found`, `dirty`,
//! `unsafe_path`, `invalid_root`, `git_error`) apply as in `worktree.rs`; new ones: `git_too_old`, `target_dirty`,
//! `target_not_checked_out`, `already_queued`, `queue_busy`, `invalid_strategy`, `invalid_request`, `invalid_state`,
//! `state_error`.
use crate::git::{blocking, current_branch, repo_command, run_git, tail_chars};
use crate::worktree::{
    err, local_branch_exists, now, open_repo, read_meta, ref_exists, safe_existing_dir, store,
    Meta, Repo,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;

const MIN_GIT: (u32, u32) = (2, 38);
const MERGE_TREE_CAP_BYTES: usize = 1024 * 1024;
const MERGE_TREE_TIMEOUT: Duration = Duration::from_secs(60);
const GIT_OP_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_CONFLICTS: usize = 200;
const MAX_AGAINST: usize = 20;
const MAX_ENQUEUE: usize = 50;
const MAX_HISTORY: usize = 50;
const MAX_ERROR_CHARS: usize = 4000;
const MAX_TEST_COMMAND_CHARS: usize = 4000;
const STALE_LOCK_SECS: u64 = 15 * 60;
const STATE_FILE: &str = ".merge-queue.json";
const LOCK_FILE: &str = ".merge-queue.lock";
const STATE_VERSION: u32 = 1;

/// Serialises lock acquisition (including stale-lock removal) inside this process.
static ACQUIRE: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------------------------------------
// Types

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEntry {
    pub path: String,
    /// `content`, `add_add`, `modify_delete` or `other`.
    pub kind: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictCheck {
    pub clean: bool,
    pub conflicts: Vec<ConflictEntry>,
    /// More conflicts than `MAX_CONFLICTS` (or more output than the cap) were found.
    pub truncated: bool,
    /// The other workspace's task id; `None` for the check against the target branch.
    pub against_task_id: Option<String>,
    /// What the branch was compared with: the target branch name or the other workspace's branch.
    pub against: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictsReport {
    pub task_id: String,
    pub branch: String,
    pub target: String,
    /// True when every check is clean.
    pub clean: bool,
    /// First entry: the target branch; then one per task id in `against`, in order.
    pub checks: Vec<ConflictCheck>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    /// Merge the target into the workspace branch, then merge the branch into the target with a merge commit.
    Merge,
    /// Rebase the workspace branch onto the target, then fast-forward the target.
    FastForward,
    /// Rebase the workspace branch onto the target, then squash it into one commit on the target.
    Squash,
}

impl Strategy {
    pub fn parse(text: &str) -> Result<Self, String> {
        match text {
            "merge" => Ok(Self::Merge),
            "fast_forward" => Ok(Self::FastForward),
            "squash" => Ok(Self::Squash),
            other => Err(err(
                "invalid_strategy",
                format!("'{other}' is not one of merge, fast_forward, squash"),
            )),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Queued,
    Rebasing,
    Testing,
    Merging,
    Merged,
    Failed,
    Skipped,
}

impl Status {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Merged | Self::Failed | Self::Skipped)
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub task_id: String,
    pub branch: String,
    pub status: Status,
    #[serde(default)]
    pub error: Option<String>,
    /// Conflicting files when the item failed on a conflict.
    #[serde(default)]
    pub conflicts: Vec<ConflictEntry>,
    pub strategy: Strategy,
    #[serde(default)]
    pub test_command: Option<String>,
    /// Local branch of the main checkout the item is merged into.
    pub target_branch: String,
    #[serde(default)]
    pub enqueued_at: u64,
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub finished_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueState {
    pub version: u32,
    /// A failure stopped the queue; later items stay queued until `resume` (or `cancel`).
    #[serde(default)]
    pub halted: bool,
    #[serde(default)]
    pub items: Vec<QueueItem>,
    #[serde(default)]
    pub updated_at: u64,
}

impl Default for QueueState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            halted: false,
            items: Vec::new(),
            updated_at: 0,
        }
    }
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Nothing left to do.
    Idle,
    /// A previous item failed; call `resume` or `cancel`.
    Halted,
    /// The item is rebased; run `needs_test.command` in `needs_test.worktree_path`, then `report_test`.
    NeedsTest,
    Merged,
    Failed,
    /// Nothing to merge (the branch is already contained in the target).
    Skipped,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NeedsTest {
    pub task_id: String,
    pub worktree_path: String,
    pub command: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub outcome: Outcome,
    pub task_id: Option<String>,
    pub needs_test: Option<NeedsTest>,
    pub state: QueueState,
}

// ---------------------------------------------------------------------------------------------
// Git plumbing

fn git_in(dir: &Path, args: &[&str]) -> Result<String, String> {
    run_git(dir, args.iter().copied()).map_err(|e| err("git_error", e))
}

struct Ran {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
    truncated: bool,
}

fn read_capped<R: Read>(reader: Option<R>, cap: usize) -> (Vec<u8>, bool) {
    let Some(mut reader) = reader else {
        return (Vec::new(), false);
    };
    let mut buf = Vec::new();
    let _ = (&mut reader).take(cap as u64 + 1).read_to_end(&mut buf);
    let cut = buf.len() > cap;
    buf.truncate(cap);
    // Keep draining so the child never blocks on a full pipe.
    let _ = std::io::copy(&mut reader, &mut std::io::sink());
    (buf, cut)
}

/// Runs git with bounded output and a wall-clock timeout (the child is killed when it is exceeded).
fn run_timed(dir: &Path, args: &[&str], timeout: Duration, cap: usize) -> Result<Ran, String> {
    let mut cmd = repo_command(dir);
    cmd.args(args)
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| err("git_error", format!("git: {e}")))?;
    let out_reader = child.stdout.take();
    let err_reader = child.stderr.take();
    let out_thread = thread::spawn(move || read_capped(out_reader, cap));
    let err_thread = thread::spawn(move || read_capped(err_reader, 64 * 1024));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => return Err(err("git_error", format!("git: {e}"))),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        thread::sleep(Duration::from_millis(5));
    };
    let Some(status) = status else {
        // Do not join the readers: a hung hook may still hold the pipes open.
        return Err(err(
            "git_error",
            format!(
                "git {} timed out after {}s",
                args.first().copied().unwrap_or(""),
                timeout.as_secs()
            ),
        ));
    };
    let (stdout, truncated) = out_thread.join().unwrap_or_default();
    let (stderr, _) = err_thread.join().unwrap_or_default();
    Ok(Ran {
        code: status.code(),
        stdout,
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        truncated,
    })
}

fn ran_error(ran: &Ran) -> String {
    let stderr = ran.stderr.trim();
    let stdout = String::from_utf8_lossy(&ran.stdout);
    let text = if stderr.is_empty() {
        stdout.trim().to_string()
    } else {
        stderr.to_string()
    };
    if text.is_empty() {
        format!("git exited with code {:?}", ran.code)
    } else {
        tail_chars(&text, MAX_ERROR_CHARS)
    }
}

/// `git version 2.50.1 (Apple Git-155)` -> `(2, 50)`.
pub fn parse_git_version(text: &str) -> Option<(u32, u32)> {
    let version = text
        .trim()
        .strip_prefix("git version ")?
        .split_whitespace()
        .next()?;
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

fn check_git_version(text: &str) -> Result<(), String> {
    match parse_git_version(text) {
        Some(v) if v >= MIN_GIT => Ok(()),
        Some((major, minor)) => Err(err("git_too_old", format!("git {major}.{minor} is too old for conflict detection (git {}.{} or newer is needed)", MIN_GIT.0, MIN_GIT.1))),
        None => Err(err("git_too_old", format!("could not read the git version from '{}'", tail_chars(text.trim(), 80)))),
    }
}

fn require_merge_tree(dir: &Path) -> Result<(), String> {
    static OK: OnceLock<()> = OnceLock::new();
    if OK.get().is_some() {
        return Ok(());
    }
    let text = run_git(dir, ["--version"]).map_err(|e| err("git_error", e))?;
    check_git_version(&text)?;
    let _ = OK.set(());
    Ok(())
}

fn safe_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('-') && !name.contains(['\0', '\n', '\r'])
}

/// Conflicted paths from `merge-tree -z` / `ls-files -u -z` output: `<mode> <oid> <stage>\t<path>` records.
/// Segments without a tab (the tree id) are skipped and an empty segment ends the list.
fn parse_conflicts(text: &str) -> (Vec<ConflictEntry>, bool) {
    let mut stages: BTreeMap<String, BTreeSet<u8>> = BTreeMap::new();
    for seg in text.split('\0') {
        if seg.is_empty() {
            break;
        }
        let Some((head, path)) = seg.split_once('\t') else {
            continue;
        };
        let Some(stage) = head.rsplit(' ').next().and_then(|s| s.parse::<u8>().ok()) else {
            continue;
        };
        stages.entry(path.to_string()).or_default().insert(stage);
    }
    let truncated = stages.len() > MAX_CONFLICTS;
    let entries = stages
        .into_iter()
        .take(MAX_CONFLICTS)
        .map(|(path, set)| {
            let kind = match (set.contains(&1), set.contains(&2), set.contains(&3)) {
                (true, true, true) => "content",
                (false, true, true) => "add_add",
                (true, true, false) | (true, false, true) => "modify_delete",
                _ => "other",
            };
            ConflictEntry {
                path,
                kind: kind.into(),
            }
        })
        .collect();
    (entries, truncated)
}

fn is_ancestor(dir: &Path, ancestor: &str, of: &str) -> bool {
    run_git(dir, ["merge-base", "--is-ancestor", ancestor, of]).is_ok()
}

fn branch_ref(branch: &str) -> String {
    format!("refs/heads/{branch}")
}

fn status_count(dir: &Path) -> Result<usize, String> {
    Ok(git_in(dir, &["status", "--porcelain"])?
        .lines()
        .filter(|l| !l.is_empty())
        .count())
}

// ---------------------------------------------------------------------------------------------
// Conflict detection

/// The revision conflicts are checked against, with a label: the recorded base branch, else the branch checked out in
/// the main checkout, else its detached HEAD.
fn target_rev(repo: &Repo, meta: &Meta) -> Result<(String, String), String> {
    if let Some(base) = meta.base_branch.as_deref().filter(|b| safe_name(b)) {
        if local_branch_exists(&repo.top, base) {
            return Ok((branch_ref(base), base.to_string()));
        }
        if ref_exists(&repo.top, base) {
            return Ok((base.to_string(), base.to_string()));
        }
    }
    if let Some(current) = current_branch(&repo.top) {
        return Ok((branch_ref(&current), current));
    }
    if ref_exists(&repo.top, "HEAD") {
        return Ok(("HEAD".into(), "HEAD".into()));
    }
    Err(err("no_commits", "the repository has no commits yet"))
}

fn workspace_branch(repo: &Repo, task_id: &str) -> Result<(Meta, String), String> {
    let meta = read_meta(repo, task_id)?;
    if !safe_name(&meta.branch) || !local_branch_exists(&repo.top, &meta.branch) {
        return Err(err(
            "not_found",
            format!("the branch of task {task_id} no longer exists"),
        ));
    }
    let branch = meta.branch.clone();
    Ok((meta, branch))
}

fn merge_tree(
    dir: &Path,
    ours: &str,
    theirs: &str,
) -> Result<(bool, Vec<ConflictEntry>, bool), String> {
    let ran = run_timed(
        dir,
        &[
            "merge-tree",
            "--write-tree",
            "-z",
            "--no-messages",
            ours,
            theirs,
        ],
        MERGE_TREE_TIMEOUT,
        MERGE_TREE_CAP_BYTES,
    )?;
    let text = String::from_utf8_lossy(&ran.stdout).into_owned();
    match ran.code {
        Some(0) if !ran.truncated => Ok((true, Vec::new(), false)),
        Some(0) | Some(1) => {
            let (conflicts, cut) = parse_conflicts(&text);
            Ok((false, conflicts, cut || ran.truncated))
        }
        _ => Err(err("git_error", ran_error(&ran))),
    }
}

pub fn check_conflicts(
    store: &Path,
    root: &str,
    task_id: &str,
    against: &[String],
) -> Result<ConflictsReport, String> {
    let repo = open_repo(store, root)?;
    if against.len() > MAX_AGAINST {
        return Err(err(
            "invalid_request",
            format!("at most {MAX_AGAINST} workspaces can be compared at once"),
        ));
    }
    let (meta, branch) = workspace_branch(&repo, task_id)?;
    require_merge_tree(&repo.top)?;
    let mine = branch_ref(&branch);
    let (target, label) = target_rev(&repo, &meta)?;
    let mut checks = Vec::new();
    let (clean, conflicts, truncated) = merge_tree(&repo.top, &target, &mine)?;
    checks.push(ConflictCheck {
        clean,
        conflicts,
        truncated,
        against_task_id: None,
        against: label.clone(),
    });
    let mut seen = BTreeSet::new();
    for other_id in against {
        if other_id == task_id {
            return Err(err(
                "invalid_request",
                "a workspace cannot be compared with itself",
            ));
        }
        if !seen.insert(other_id.clone()) {
            continue;
        }
        let (_, other_branch) = workspace_branch(&repo, other_id)?;
        let (clean, conflicts, truncated) =
            merge_tree(&repo.top, &mine, &branch_ref(&other_branch))?;
        checks.push(ConflictCheck {
            clean,
            conflicts,
            truncated,
            against_task_id: Some(other_id.clone()),
            against: other_branch,
        });
    }
    Ok(ConflictsReport {
        task_id: task_id.into(),
        branch,
        target: label,
        clean: checks.iter().all(|c| c.clean),
        checks,
    })
}

// ---------------------------------------------------------------------------------------------
// State, lock

fn state_path(repo: &Repo) -> PathBuf {
    repo.managed.join(STATE_FILE)
}

fn load(repo: &Repo) -> Result<QueueState, String> {
    let text = match fs::read_to_string(state_path(repo)) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(QueueState::default()),
        Err(e) => return Err(err("state_error", format!("merge queue state: {e}"))),
    };
    let state: QueueState = serde_json::from_str(&text)
        .map_err(|e| err("state_error", format!("unreadable merge queue state: {e}")))?;
    if state.version > STATE_VERSION {
        return Err(err(
            "state_error",
            format!(
                "merge queue state version {} is newer than this app understands",
                state.version
            ),
        ));
    }
    Ok(state)
}

fn save(repo: &Repo, state: &mut QueueState) -> Result<(), String> {
    state.version = STATE_VERSION;
    state.updated_at = now();
    // Bound the history: keep every active item and the most recent finished ones.
    let finished = state
        .items
        .iter()
        .filter(|i| i.status.is_terminal())
        .count();
    if finished > MAX_HISTORY {
        let mut drop_n = finished - MAX_HISTORY;
        state.items.retain(|i| {
            if drop_n > 0 && i.status.is_terminal() {
                drop_n -= 1;
                false
            } else {
                true
            }
        });
    }
    fs::create_dir_all(&repo.managed)
        .map_err(|e| err("state_error", format!("merge queue state: {e}")))?;
    let path = state_path(repo);
    let tmp = repo.managed.join(format!("{STATE_FILE}.tmp"));
    let text = serde_json::to_string_pretty(state).map_err(|e| err("state_error", e))?;
    let write = || -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        fs::rename(&tmp, &path)
    };
    write().map_err(|e| {
        let _ = fs::remove_file(&tmp);
        err("state_error", format!("merge queue state: {e}"))
    })
}

struct QueueLock {
    path: PathBuf,
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // SAFETY: signal 0 only checks that the process exists.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> bool {
    true // age is the only staleness signal without a portable liveness check
}

fn lock_is_stale(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let mut lines = text.lines();
    let pid = lines.next().and_then(|l| l.trim().parse::<u32>().ok());
    let since = lines.next().and_then(|l| l.trim().parse::<u64>().ok());
    let (Some(pid), Some(since)) = (pid, since) else {
        // Unreadable content: only stale once the file itself is old (it may just be being written).
        let age = fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        return age > 60;
    };
    now().saturating_sub(since) > STALE_LOCK_SECS || !pid_alive(pid)
}

impl QueueLock {
    fn acquire(repo: &Repo) -> Result<Self, String> {
        fs::create_dir_all(&repo.managed)
            .map_err(|e| err("state_error", format!("merge queue lock: {e}")))?;
        let path = repo.managed.join(LOCK_FILE);
        let _guard = ACQUIRE.lock().unwrap_or_else(|e| e.into_inner());
        for _ in 0..2 {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut file) => {
                    let _ = write!(file, "{}\n{}\n", std::process::id(), now());
                    return Ok(Self { path });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if lock_is_stale(&path) {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    return Err(err(
                        "queue_busy",
                        "another merge queue run is in progress for this repository",
                    ));
                }
                Err(e) => return Err(err("state_error", format!("merge queue lock: {e}"))),
            }
        }
        Err(err(
            "queue_busy",
            "another merge queue run is in progress for this repository",
        ))
    }
}

impl Drop for QueueLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

// ---------------------------------------------------------------------------------------------
// Queue operations

/// The local branch of the main checkout a workspace merges into: its recorded base branch when that is a local
/// branch, otherwise the branch currently checked out in the main checkout.
fn target_branch(repo: &Repo, meta: &Meta) -> Result<String, String> {
    if let Some(base) = meta
        .base_branch
        .as_deref()
        .filter(|b| safe_name(b) && local_branch_exists(&repo.top, b))
    {
        return Ok(base.to_string());
    }
    current_branch(&repo.top).ok_or_else(|| {
        err(
            "target_not_checked_out",
            "the main checkout is not on a branch, so there is no target to merge into",
        )
    })
}

fn workspace_head_branch(dir: &Path) -> Result<String, String> {
    let out = git_in(dir, &["symbolic-ref", "--short", "-q", "HEAD"])
        .map_err(|_| err("git_error", "the workspace HEAD is detached"))?;
    let branch = out.trim().to_string();
    if safe_name(&branch) {
        Ok(branch)
    } else {
        Err(err("git_error", "the workspace HEAD is detached"))
    }
}

fn normalise_command(command: Option<String>) -> Result<Option<String>, String> {
    let Some(command) = command
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
    else {
        return Ok(None);
    };
    if command.chars().count() > MAX_TEST_COMMAND_CHARS || command.contains('\0') {
        return Err(err(
            "invalid_request",
            "the test command is too long or contains a NUL byte",
        ));
    }
    Ok(Some(command))
}

pub fn enqueue(
    store: &Path,
    root: &str,
    task_ids: &[String],
    strategy: Strategy,
    test_command: Option<String>,
) -> Result<QueueState, String> {
    let repo = open_repo(store, root)?;
    if task_ids.is_empty() || task_ids.len() > MAX_ENQUEUE {
        return Err(err(
            "invalid_request",
            format!("enqueue 1-{MAX_ENQUEUE} tasks at a time"),
        ));
    }
    let test_command = normalise_command(test_command)?;
    let _lock = QueueLock::acquire(&repo)?;
    let mut state = load(&repo)?;
    let active: BTreeSet<&str> = state
        .items
        .iter()
        .filter(|i| !i.status.is_terminal())
        .map(|i| i.task_id.as_str())
        .collect();
    let mut seen = BTreeSet::new();
    let mut fresh = Vec::new();
    // Validate everything first: either all tasks are queued or none.
    for id in task_ids {
        let meta = read_meta(&repo, id)?;
        if active.contains(id.as_str()) || !seen.insert(id.clone()) {
            return Err(err(
                "already_queued",
                format!("task {id} is already in the merge queue"),
            ));
        }
        let Some(dir) = safe_existing_dir(&repo, id)? else {
            return Err(err(
                "not_found",
                format!("the workspace directory of task {id} is gone (prune it)"),
            ));
        };
        let branch = workspace_head_branch(&dir)?;
        let changes = status_count(&dir)?;
        if changes > 0 {
            return Err(err(
                "dirty",
                format!("task {id} has {changes} uncommitted change(s); commit them first"),
            ));
        }
        let target = target_branch(&repo, &meta)?;
        fresh.push(QueueItem {
            task_id: id.clone(),
            branch,
            status: Status::Queued,
            error: None,
            conflicts: Vec::new(),
            strategy,
            test_command: test_command.clone(),
            target_branch: target,
            enqueued_at: now(),
            started_at: None,
            finished_at: None,
        });
    }
    if !state.items.iter().any(|i| !i.status.is_terminal()) {
        state.halted = false;
    }
    // A finished entry for the same task is replaced by the new one.
    state
        .items
        .retain(|i| !(i.status.is_terminal() && seen.contains(&i.task_id)));
    state.items.extend(fresh);
    save(&repo, &mut state)?;
    Ok(state)
}

pub fn status(store: &Path, root: &str) -> Result<QueueState, String> {
    let repo = open_repo(store, root)?;
    load(&repo)
}

/// Skips every unfinished item (`skipped`, "cancelled") and clears the halted flag. Refused while a run is active.
pub fn cancel(store: &Path, root: &str) -> Result<QueueState, String> {
    let repo = open_repo(store, root)?;
    let _lock = QueueLock::acquire(&repo)?;
    let mut state = load(&repo)?;
    let stamp = now();
    for item in state.items.iter_mut().filter(|i| !i.status.is_terminal()) {
        item.status = Status::Skipped;
        item.error = Some("cancelled".into());
        item.finished_at = Some(stamp);
    }
    state.halted = false;
    save(&repo, &mut state)?;
    Ok(state)
}

/// Clears the halted flag after a failure so the remaining queued items can run (the failed item stays failed;
/// enqueue it again to retry it).
pub fn resume(store: &Path, root: &str) -> Result<QueueState, String> {
    let repo = open_repo(store, root)?;
    let _lock = QueueLock::acquire(&repo)?;
    let mut state = load(&repo)?;
    state.halted = false;
    save(&repo, &mut state)?;
    Ok(state)
}

fn result(
    outcome: Outcome,
    task_id: Option<&str>,
    needs_test: Option<NeedsTest>,
    state: QueueState,
) -> RunResult {
    RunResult {
        outcome,
        task_id: task_id.map(str::to_string),
        needs_test,
        state,
    }
}

fn mark_failed(state: &mut QueueState, idx: usize, message: String, conflicts: Vec<ConflictEntry>) {
    let item = &mut state.items[idx];
    item.status = Status::Failed;
    item.error = Some(tail_chars(&message, MAX_ERROR_CHARS));
    item.conflicts = conflicts;
    item.finished_at = Some(now());
    state.halted = true;
}

fn mark_skipped(state: &mut QueueState, idx: usize, reason: String) {
    let item = &mut state.items[idx];
    item.status = Status::Skipped;
    item.error = Some(reason);
    item.finished_at = Some(now());
}

/// The main checkout must be on the target branch and clean before anything is merged into it.
fn check_target(repo: &Repo, target: &str) -> Result<(), String> {
    match current_branch(&repo.top) {
        Some(current) if current == target => {}
        Some(current) => return Err(err("target_not_checked_out", format!("the main checkout is on '{current}', not on '{target}'"))),
        None => return Err(err("target_not_checked_out", format!("the main checkout is not on '{target}' (detached HEAD or an operation in progress)"))),
    }
    let changes = status_count(&repo.top)?;
    if changes > 0 {
        return Err(err(
            "target_dirty",
            format!(
                "the main checkout has {changes} uncommitted change(s); commit or stash them first"
            ),
        ));
    }
    Ok(())
}

fn git_dir_of(dir: &Path) -> Option<PathBuf> {
    run_git(dir, ["rev-parse", "--absolute-git-dir"])
        .ok()
        .map(|s| PathBuf::from(s.trim()))
}

/// Aborts an operation a crashed earlier run may have left in a workspace.
fn abort_leftovers(dir: &Path) {
    let Some(git_dir) = git_dir_of(dir) else {
        return;
    };
    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        let _ = run_git(dir, ["rebase", "--abort"]);
    }
    if git_dir.join("MERGE_HEAD").exists() {
        let _ = run_git(dir, ["merge", "--abort"]);
    }
}

struct Integrate {
    message: String,
    conflicts: Vec<ConflictEntry>,
}

/// Brings the workspace branch up to date with the target inside the workspace; on failure the operation is aborted
/// and the workspace is left as it was.
fn integrate(dir: &Path, item: &QueueItem) -> Result<(), Integrate> {
    let target = branch_ref(&item.target_branch);
    let merging = item.strategy == Strategy::Merge;
    let message = format!("Merge {} into {}", item.target_branch, item.branch);
    let ran = if merging {
        run_timed(
            dir,
            &["merge", "--no-edit", "-m", &message, &target],
            GIT_OP_TIMEOUT,
            64 * 1024,
        )
    } else {
        run_timed(dir, &["rebase", &target], GIT_OP_TIMEOUT, 64 * 1024)
    };
    let ran = ran.map_err(|e| Integrate {
        message: e,
        conflicts: Vec::new(),
    })?;
    if ran.code == Some(0) {
        return Ok(());
    }
    let conflicts = run_git(dir, ["ls-files", "-u", "-z"])
        .map(|t| parse_conflicts(&t).0)
        .unwrap_or_default();
    let detail = ran_error(&ran);
    let aborted = if merging {
        run_git(dir, ["merge", "--abort"])
    } else {
        run_git(dir, ["rebase", "--abort"])
    };
    let mut message = if conflicts.is_empty() {
        format!(
            "git_error: {} failed: {detail}",
            if merging { "merge" } else { "rebase" }
        )
    } else {
        format!(
            "conflict: {} conflicting file(s) when {} onto '{}'",
            conflicts.len(),
            if merging { "merging" } else { "rebasing" },
            item.target_branch
        )
    };
    if let Err(e) = aborted {
        message.push_str(&format!(
            "; aborting the {} also failed: {e}",
            if merging { "merge" } else { "rebase" }
        ));
    }
    Err(Integrate { message, conflicts })
}

/// Merges the (up to date) workspace branch into the checked-out target. Aborts and reports on failure.
/// `Ok(false)` means there was nothing to commit.
fn merge_into_target(repo: &Repo, item: &QueueItem) -> Result<bool, String> {
    let top = &repo.top;
    let branch = branch_ref(&item.branch);
    let text = format!("Merge workspace {} (task {})", item.branch, item.task_id);
    let run = |args: &[&str]| -> Result<(), String> {
        let ran = run_timed(top, args, GIT_OP_TIMEOUT, 64 * 1024)?;
        if ran.code == Some(0) {
            Ok(())
        } else {
            Err(ran_error(&ran))
        }
    };
    let outcome = match item.strategy {
        Strategy::FastForward => run(&["merge", "--ff-only", &branch]).map(|_| true),
        Strategy::Merge => {
            run(&["merge", "--no-ff", "--no-edit", "-m", &text, &branch]).map(|_| true)
        }
        Strategy::Squash => run(&["merge", "--squash", &branch]).and_then(|_| {
            if run_git(top, ["diff", "--cached", "--quiet"]).is_ok() {
                return Ok(false); // no net changes
            }
            run(&[
                "commit",
                "-q",
                "-m",
                &format!("Squash {} (task {})", item.branch, item.task_id),
            ])
            .map(|_| true)
        }),
    };
    match outcome {
        Ok(true) => Ok(true),
        Ok(false) => {
            let _ = run_git(top, ["reset", "--merge"]);
            Ok(false)
        }
        Err(e) => {
            // Never leave the main checkout half merged.
            if run_git(top, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]).is_ok() {
                let _ = run_git(top, ["merge", "--abort"]);
            } else {
                let _ = run_git(top, ["reset", "--merge"]);
            }
            Err(e)
        }
    }
}

/// Processes exactly one queue item. Environment problems with the main checkout (`target_dirty`,
/// `target_not_checked_out`) are returned as errors and leave the item untouched so it can be retried.
pub fn run_next(store: &Path, root: &str) -> Result<RunResult, String> {
    let repo = open_repo(store, root)?;
    let _lock = QueueLock::acquire(&repo)?;
    let mut state = load(&repo)?;
    let Some(idx) = state.items.iter().position(|i| !i.status.is_terminal()) else {
        return Ok(result(Outcome::Idle, None, None, state));
    };
    if state.halted {
        return Ok(result(Outcome::Halted, None, None, state));
    }
    let item = state.items[idx].clone();
    let id = item.task_id.clone();
    if item.status == Status::Testing {
        let needs = needs_test(&repo, &item)?;
        return Ok(result(Outcome::NeedsTest, Some(&id), Some(needs), state));
    }
    check_target(&repo, &item.target_branch)?;
    if let Err(e) = read_meta(&repo, &id) {
        mark_failed(&mut state, idx, e, Vec::new());
        save(&repo, &mut state)?;
        return Ok(result(Outcome::Failed, Some(&id), None, state));
    }
    let dir = match safe_existing_dir(&repo, &id) {
        Ok(Some(dir)) => dir,
        Ok(None) => {
            mark_failed(
                &mut state,
                idx,
                format!("not_found: the workspace directory of task {id} is gone"),
                Vec::new(),
            );
            save(&repo, &mut state)?;
            return Ok(result(Outcome::Failed, Some(&id), None, state));
        }
        Err(e) => {
            mark_failed(&mut state, idx, e, Vec::new());
            save(&repo, &mut state)?;
            return Ok(result(Outcome::Failed, Some(&id), None, state));
        }
    };
    let target_ref = branch_ref(&item.target_branch);
    let branch_ok = local_branch_exists(&repo.top, &item.branch)
        && local_branch_exists(&repo.top, &item.target_branch);
    if !branch_ok {
        mark_failed(
            &mut state,
            idx,
            format!(
                "not_found: branch '{}' or target '{}' no longer exists",
                item.branch, item.target_branch
            ),
            Vec::new(),
        );
        save(&repo, &mut state)?;
        return Ok(result(Outcome::Failed, Some(&id), None, state));
    }
    if is_ancestor(&repo.top, &item.branch, &target_ref) {
        mark_skipped(
            &mut state,
            idx,
            format!("already contained in '{}'", item.target_branch),
        );
        save(&repo, &mut state)?;
        return Ok(result(Outcome::Skipped, Some(&id), None, state));
    }

    // A `merging` item whose branch is still up to date goes straight to the merge; anything else (re)integrates.
    let up_to_date = is_ancestor(&repo.top, &target_ref, &branch_ref(&item.branch));
    if item.status != Status::Merging || !up_to_date {
        abort_leftovers(&dir);
        match workspace_head_branch(&dir).and_then(|b| {
            if b == item.branch {
                Ok(())
            } else {
                Err(err(
                    "git_error",
                    format!("the workspace is on '{b}', expected '{}'", item.branch),
                ))
            }
        }) {
            Ok(()) => {}
            Err(e) => {
                mark_failed(&mut state, idx, e, Vec::new());
                save(&repo, &mut state)?;
                return Ok(result(Outcome::Failed, Some(&id), None, state));
            }
        }
        match status_count(&dir) {
            Ok(0) => {}
            Ok(n) => {
                mark_failed(
                    &mut state,
                    idx,
                    format!("dirty: the workspace has {n} uncommitted change(s)"),
                    Vec::new(),
                );
                save(&repo, &mut state)?;
                return Ok(result(Outcome::Failed, Some(&id), None, state));
            }
            Err(e) => {
                mark_failed(&mut state, idx, e, Vec::new());
                save(&repo, &mut state)?;
                return Ok(result(Outcome::Failed, Some(&id), None, state));
            }
        }
        {
            let it = &mut state.items[idx];
            it.status = Status::Rebasing;
            it.started_at.get_or_insert_with(now);
            it.error = None;
            it.conflicts.clear();
        }
        save(&repo, &mut state)?;
        if !up_to_date {
            if let Err(fail) = integrate(&dir, &item) {
                mark_failed(&mut state, idx, fail.message, fail.conflicts);
                save(&repo, &mut state)?;
                return Ok(result(Outcome::Failed, Some(&id), None, state));
            }
        }
        if item.test_command.is_some() {
            state.items[idx].status = Status::Testing;
            save(&repo, &mut state)?;
            let needs = needs_test(&repo, &state.items[idx])?;
            return Ok(result(Outcome::NeedsTest, Some(&id), Some(needs), state));
        }
    }

    {
        let it = &mut state.items[idx];
        it.status = Status::Merging;
        it.started_at.get_or_insert_with(now);
    }
    save(&repo, &mut state)?;
    match merge_into_target(&repo, &item) {
        Ok(true) => {
            let it = &mut state.items[idx];
            it.status = Status::Merged;
            it.error = None;
            it.finished_at = Some(now());
            save(&repo, &mut state)?;
            Ok(result(Outcome::Merged, Some(&id), None, state))
        }
        Ok(false) => {
            mark_skipped(
                &mut state,
                idx,
                format!("no net changes to merge into '{}'", item.target_branch),
            );
            save(&repo, &mut state)?;
            Ok(result(Outcome::Skipped, Some(&id), None, state))
        }
        Err(e) => {
            mark_failed(
                &mut state,
                idx,
                format!(
                    "git_error: merging into '{}' failed: {e}",
                    item.target_branch
                ),
                Vec::new(),
            );
            save(&repo, &mut state)?;
            Ok(result(Outcome::Failed, Some(&id), None, state))
        }
    }
}

fn needs_test(repo: &Repo, item: &QueueItem) -> Result<NeedsTest, String> {
    let command = item
        .test_command
        .clone()
        .ok_or_else(|| err("invalid_state", "the item has no test command"))?;
    let dir = safe_existing_dir(repo, &item.task_id)?.ok_or_else(|| {
        err(
            "not_found",
            format!("the workspace directory of task {} is gone", item.task_id),
        )
    })?;
    Ok(NeedsTest {
        task_id: item.task_id.clone(),
        worktree_path: dir.to_string_lossy().into_owned(),
        command,
    })
}

/// Records the result of the test command the caller ran for a `testing` item. A pass moves the item to `merging`
/// (the next `run_next` merges it); a failure fails the item and halts the queue. Nothing is merged here.
pub fn report_test(
    store: &Path,
    root: &str,
    task_id: &str,
    ok: bool,
    output: &str,
) -> Result<QueueState, String> {
    let repo = open_repo(store, root)?;
    let _lock = QueueLock::acquire(&repo)?;
    let mut state = load(&repo)?;
    let Some(idx) = state
        .items
        .iter()
        .position(|i| i.task_id == task_id && !i.status.is_terminal())
    else {
        return Err(err(
            "not_found",
            format!("task {task_id} is not in the merge queue"),
        ));
    };
    if state.items[idx].status != Status::Testing {
        return Err(err(
            "invalid_state",
            format!("task {task_id} is not waiting for a test result"),
        ));
    }
    if ok {
        state.items[idx].status = Status::Merging;
    } else {
        let output = output.trim();
        let message = if output.is_empty() {
            "tests failed".to_string()
        } else {
            format!(
                "tests failed:\n{}",
                tail_chars(output, MAX_ERROR_CHARS - 20)
            )
        };
        mark_failed(&mut state, idx, message, Vec::new());
    }
    save(&repo, &mut state)?;
    Ok(state)
}

// ---------------------------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn conflicts_check(
    app: AppHandle,
    root: String,
    task_id: String,
    against: Option<Vec<String>>,
) -> Result<ConflictsReport, String> {
    let store = store(&app)?;
    blocking(move || check_conflicts(&store, &root, &task_id, &against.unwrap_or_default())).await
}

#[tauri::command]
pub async fn queue_enqueue(
    app: AppHandle,
    root: String,
    task_ids: Vec<String>,
    strategy: String,
    test_command: Option<String>,
) -> Result<QueueState, String> {
    let store = store(&app)?;
    let strategy = Strategy::parse(&strategy)?;
    blocking(move || enqueue(&store, &root, &task_ids, strategy, test_command)).await
}

#[tauri::command]
pub async fn queue_status(app: AppHandle, root: String) -> Result<QueueState, String> {
    let store = store(&app)?;
    blocking(move || self::status(&store, &root)).await
}

#[tauri::command]
pub async fn queue_cancel(app: AppHandle, root: String) -> Result<QueueState, String> {
    let store = store(&app)?;
    blocking(move || self::cancel(&store, &root)).await
}

#[tauri::command]
pub async fn queue_resume(app: AppHandle, root: String) -> Result<QueueState, String> {
    let store = store(&app)?;
    blocking(move || self::resume(&store, &root)).await
}

#[tauri::command]
pub async fn queue_run_next(app: AppHandle, root: String) -> Result<RunResult, String> {
    let store = store(&app)?;
    blocking(move || self::run_next(&store, &root)).await
}

#[tauri::command]
pub async fn queue_report_test(
    app: AppHandle,
    root: String,
    task_id: String,
    ok: bool,
    output: Option<String>,
) -> Result<QueueState, String> {
    let store = store(&app)?;
    blocking(move || report_test(&store, &root, &task_id, ok, output.as_deref().unwrap_or("")))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree;
    use std::process::Command;

    struct Fx {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        store: PathBuf,
    }

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

    fn fx() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let (root, store) = (base.join("repo"), base.join("store"));
        fs::create_dir_all(&root).unwrap();
        g(&root, &["init", "-q", "-b", "main"]);
        for (k, v) in [
            ("user.name", "T"),
            ("user.email", "t@e.com"),
            ("commit.gpgsign", "false"),
            ("core.hooksPath", base.join("nohooks").to_str().unwrap()),
        ] {
            g(&root, &["config", k, v]);
        }
        fs::write(root.join("a.txt"), "1\n2\n3\n").unwrap();
        g(&root, &["add", "."]);
        g(&root, &["commit", "-q", "-m", "init"]);
        Fx {
            _tmp: tmp,
            root,
            store,
        }
    }

    fn rs(f: &Fx) -> &str {
        f.root.to_str().unwrap()
    }

    fn mk(f: &Fx, slug: &str, id: &str) -> PathBuf {
        PathBuf::from(
            worktree::create(&f.store, rs(f), None, slug, id, None, None)
                .unwrap()
                .path,
        )
    }

    fn commit_file(dir: &Path, name: &str, content: &str, msg: &str) {
        fs::write(dir.join(name), content).unwrap();
        g(dir, &["add", "."]);
        g(dir, &["commit", "-q", "-m", msg]);
    }

    fn code(e: &str) -> &str {
        e.split(':').next().unwrap()
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn item<'a>(state: &'a QueueState, id: &str) -> &'a QueueItem {
        state
            .items
            .iter()
            .find(|i| i.task_id == id)
            .unwrap_or_else(|| panic!("{id} in {state:?}"))
    }

    fn enq(f: &Fx, list: &[&str], strategy: Strategy, test: Option<&str>) -> QueueState {
        enqueue(
            &f.store,
            rs(f),
            &ids(list),
            strategy,
            test.map(str::to_string),
        )
        .unwrap()
    }

    fn next(f: &Fx) -> RunResult {
        run_next(&f.store, rs(f)).unwrap()
    }

    fn lock_path(f: &Fx) -> PathBuf {
        open_repo(&f.store, rs(f)).unwrap().managed.join(LOCK_FILE)
    }

    #[test]
    fn git_versions_are_parsed_and_old_ones_refused() {
        assert_eq!(
            parse_git_version("git version 2.50.1 (Apple Git-155)\n"),
            Some((2, 50))
        );
        assert_eq!(parse_git_version("git version 2.38.0"), Some((2, 38)));
        assert_eq!(
            parse_git_version("git version 2.43.0.windows.1"),
            Some((2, 43))
        );
        assert_eq!(parse_git_version("something else"), None);
        assert!(check_git_version("git version 2.38.0").is_ok());
        assert!(check_git_version("git version 3.0.1").is_ok());
        for old in ["git version 2.37.9", "git version 1.9.0", "garbage"] {
            let e = check_git_version(old).unwrap_err();
            assert_eq!(code(&e), "git_too_old", "{e}");
        }
    }

    #[test]
    fn conflict_records_are_parsed() {
        let text = "tree\x00100644 aaa 1\ta\x00100644 bbb 2\ta\x00100644 ccc 3\ta\x00100644 ddd 1\td\x00100644 eee 2\td\x00100644 fff 2\tn\x00100644 ggg 3\tn\0\0ignored message\0";
        let (list, cut) = parse_conflicts(text);
        assert!(!cut);
        let kinds: Vec<(&str, &str)> = list
            .iter()
            .map(|c| (c.path.as_str(), c.kind.as_str()))
            .collect();
        assert_eq!(
            kinds,
            vec![("a", "content"), ("d", "modify_delete"), ("n", "add_add")]
        );
    }

    #[test]
    fn clean_merge_tree_is_read_only() {
        let f = fx();
        let w = mk(&f, "feat", "t1");
        commit_file(&w, "b.txt", "b\n", "b");
        commit_file(&f.root, "c.txt", "c\n", "c");
        let snapshot = |dir: &Path| {
            (
                g(dir, &["status", "--porcelain"]),
                g(dir, &["rev-parse", "HEAD"]),
                g(dir, &["ls-files", "-s"]),
                fs::read_dir(dir).unwrap().count(),
            )
        };
        let before = (snapshot(&f.root), snapshot(&w));
        let index_before = fs::read(f.root.join(".git/index")).unwrap();
        let report = check_conflicts(&f.store, rs(&f), "t1", &[]).unwrap();
        assert!(report.clean, "{report:?}");
        assert_eq!(
            (report.target.as_str(), report.branch.as_str()),
            ("main", "gustaf/feat")
        );
        assert_eq!(report.checks.len(), 1);
        assert!(
            report.checks[0].clean
                && report.checks[0].conflicts.is_empty()
                && report.checks[0].against_task_id.is_none()
        );
        assert_eq!(before, (snapshot(&f.root), snapshot(&w)));
        assert_eq!(index_before, fs::read(f.root.join(".git/index")).unwrap());
        assert!(!f.root.join("b.txt").exists() && !w.join("c.txt").exists());
    }

    #[test]
    fn conflicting_edits_are_reported_with_paths_and_kinds() {
        let f = fx();
        fs::write(f.root.join("gone.txt"), "x\n").unwrap();
        g(&f.root, &["add", "."]);
        g(&f.root, &["commit", "-q", "-m", "gone"]);
        let w = mk(&f, "feat", "t1");
        fs::write(w.join("a.txt"), "1\nWS\n3\n").unwrap();
        g(&w, &["rm", "-q", "gone.txt"]);
        commit_file(&w, "both.txt", "ws\n", "ws");
        fs::write(f.root.join("a.txt"), "1\nMAIN\n3\n").unwrap();
        fs::write(f.root.join("gone.txt"), "changed\n").unwrap();
        fs::write(f.root.join("both.txt"), "main\n").unwrap();
        g(&f.root, &["add", "."]);
        g(&f.root, &["commit", "-q", "-m", "main edits"]);
        let report = check_conflicts(&f.store, rs(&f), "t1", &[]).unwrap();
        assert!(!report.clean);
        let got: Vec<(&str, &str)> = report.checks[0]
            .conflicts
            .iter()
            .map(|c| (c.path.as_str(), c.kind.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("a.txt", "content"),
                ("both.txt", "add_add"),
                ("gone.txt", "modify_delete")
            ]
        );
        // Still read-only: nothing is left behind in either checkout.
        assert_eq!(g(&f.root, &["status", "--porcelain"]), "");
        assert_eq!(g(&w, &["status", "--porcelain"]), "");
    }

    #[test]
    fn conflicts_between_two_workspaces_use_against() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        let w2 = mk(&f, "two", "t2");
        let w3 = mk(&f, "three", "t3");
        fs::write(w1.join("a.txt"), "1\nONE\n3\n").unwrap();
        g(&w1, &["commit", "-q", "-am", "one"]);
        fs::write(w2.join("a.txt"), "1\nTWO\n3\n").unwrap();
        g(&w2, &["commit", "-q", "-am", "two"]);
        commit_file(&w3, "other.txt", "o\n", "three");
        let report = check_conflicts(&f.store, rs(&f), "t1", &ids(&["t2", "t3", "t2"])).unwrap();
        assert!(!report.clean);
        assert_eq!(
            report.checks.len(),
            3,
            "duplicates are compared once: {report:?}"
        );
        assert!(report.checks[0].clean, "clean against main");
        let c2 = &report.checks[1];
        assert_eq!(
            (c2.against_task_id.as_deref(), c2.clean),
            (Some("t2"), false)
        );
        assert_eq!(
            c2.conflicts,
            vec![ConflictEntry {
                path: "a.txt".into(),
                kind: "content".into()
            }]
        );
        assert_eq!(
            (
                report.checks[2].against_task_id.as_deref(),
                report.checks[2].clean
            ),
            (Some("t3"), true)
        );
        let e = check_conflicts(&f.store, rs(&f), "t1", &ids(&["t1"])).unwrap_err();
        assert_eq!(code(&e), "invalid_request");
        let e = check_conflicts(&f.store, rs(&f), "t1", &ids(&["nope"])).unwrap_err();
        assert_eq!(code(&e), "not_found");
        let e = check_conflicts(&f.store, rs(&f), "missing", &[]).unwrap_err();
        assert_eq!(code(&e), "not_found");
        let e = check_conflicts(&f.store, rs(&f), "../x", &[]).unwrap_err();
        assert_eq!(code(&e), "invalid_task_id");
    }

    #[test]
    fn queue_of_three_merges_in_order_with_a_rebase_between() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        let w2 = mk(&f, "two", "t2");
        let w3 = mk(&f, "three", "t3");
        commit_file(&w1, "one.txt", "1\n", "one");
        commit_file(&w2, "two.txt", "2\n", "two");
        commit_file(&w3, "three.txt", "3\n", "three");
        let s = enq(&f, &["t1", "t2", "t3"], Strategy::FastForward, None);
        assert!(s.items.iter().all(|i| i.status == Status::Queued
            && i.target_branch == "main"
            && i.started_at.is_none()));
        let old_t2 = g(&w2, &["rev-parse", "HEAD"]);

        let r = next(&f);
        assert_eq!(
            (r.outcome, r.task_id.as_deref()),
            (Outcome::Merged, Some("t1"))
        );
        assert_eq!(
            item(&r.state, "t2").status,
            Status::Queued,
            "one item per call"
        );
        assert!(f.root.join("one.txt").exists() && !f.root.join("two.txt").exists());
        let r = next(&f);
        assert_eq!(
            (r.outcome, r.task_id.as_deref()),
            (Outcome::Merged, Some("t2"))
        );
        // t2 was rebased onto the new main (t1's commit), not merged as-is.
        assert_ne!(g(&w2, &["rev-parse", "HEAD"]), old_t2);
        assert_eq!(
            g(&w2, &["rev-parse", "HEAD^"]).trim(),
            g(&w1, &["rev-parse", "HEAD"]).trim()
        );
        let r = next(&f);
        assert_eq!(
            (r.outcome, r.task_id.as_deref()),
            (Outcome::Merged, Some("t3"))
        );
        assert!(r.state.items.iter().all(|i| i.status == Status::Merged
            && i.started_at.is_some()
            && i.finished_at.is_some()
            && i.error.is_none()));
        assert_eq!(next(&f).outcome, Outcome::Idle);
        let log = g(&f.root, &["log", "--format=%s"]);
        assert_eq!(
            log.lines().collect::<Vec<_>>(),
            vec!["three", "two", "one", "init"],
            "linear history in queue order"
        );
        assert_eq!(g(&f.root, &["status", "--porcelain"]), "");
        assert_eq!(
            g(&f.root, &["rev-parse", "main"]),
            g(&w3, &["rev-parse", "HEAD"])
        );
    }

    #[test]
    fn merge_and_squash_strategies() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        let w2 = mk(&f, "two", "t2");
        commit_file(&w1, "one.txt", "1\n", "one a");
        commit_file(&w1, "one2.txt", "1\n", "one b");
        commit_file(&w2, "two.txt", "2\n", "two");
        commit_file(&f.root, "main.txt", "m\n", "main moves");
        enq(&f, &["t1"], Strategy::Squash, None);
        assert_eq!(next(&f).outcome, Outcome::Merged);
        let log = g(&f.root, &["log", "--format=%s", "-n", "2"]);
        assert!(log.starts_with("Squash gustaf/one (task t1)"), "{log}");
        assert_eq!(
            g(&f.root, &["rev-list", "--count", "main"]).trim(),
            "3",
            "init + main moves + one squash commit"
        );
        assert!(f.root.join("one.txt").exists() && f.root.join("one2.txt").exists());

        enq(&f, &["t2"], Strategy::Merge, None);
        assert_eq!(next(&f).outcome, Outcome::Merged);
        let parents = g(&f.root, &["log", "-1", "--format=%p"]);
        assert_eq!(
            parents.split_whitespace().count(),
            2,
            "a merge commit: {parents}"
        );
        assert!(f.root.join("two.txt").exists());
        assert_eq!(g(&f.root, &["status", "--porcelain"]), "");
    }

    #[test]
    fn first_item_conflict_stops_the_queue() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        let w2 = mk(&f, "two", "t2");
        fs::write(w1.join("a.txt"), "1\nWS\n3\n").unwrap();
        g(&w1, &["commit", "-q", "-am", "ws edit"]);
        commit_file(&w2, "two.txt", "2\n", "two");
        fs::write(f.root.join("a.txt"), "1\nMAIN\n3\n").unwrap();
        g(&f.root, &["commit", "-q", "-am", "main edit"]);
        let main_head = g(&f.root, &["rev-parse", "HEAD"]);
        let w1_head = g(&w1, &["rev-parse", "HEAD"]);
        enq(&f, &["t1", "t2"], Strategy::FastForward, None);

        let r = next(&f);
        assert_eq!(r.outcome, Outcome::Failed);
        let t1 = item(&r.state, "t1");
        assert_eq!(t1.status, Status::Failed);
        assert_eq!(
            t1.conflicts,
            vec![ConflictEntry {
                path: "a.txt".into(),
                kind: "content".into()
            }]
        );
        assert!(
            t1.error.as_deref().unwrap().starts_with("conflict:"),
            "{:?}",
            t1.error
        );
        assert!(r.state.halted);
        assert_eq!(
            item(&r.state, "t2").status,
            Status::Queued,
            "later items stay queued"
        );
        // The workspace and the target are untouched.
        assert_eq!(g(&w1, &["status", "--porcelain"]), "");
        assert_eq!(g(&w1, &["rev-parse", "HEAD"]), w1_head);
        assert!(
            !git_dir_of(&w1).unwrap().join("rebase-merge").exists()
                && !git_dir_of(&w1).unwrap().join("rebase-apply").exists()
        );
        assert_eq!(g(&f.root, &["rev-parse", "HEAD"]), main_head);
        // Stopped: more calls do nothing until resumed.
        let r = next(&f);
        assert_eq!(r.outcome, Outcome::Halted);
        assert_eq!(item(&r.state, "t2").status, Status::Queued);
        resume(&f.store, rs(&f)).unwrap();
        let r = next(&f);
        assert_eq!(
            (r.outcome, r.task_id.as_deref()),
            (Outcome::Merged, Some("t2"))
        );
        // A failed item can be queued again, replacing its entry.
        let s = enq(&f, &["t1"], Strategy::FastForward, None);
        assert_eq!(s.items.iter().filter(|i| i.task_id == "t1").count(), 1);
        assert_eq!(item(&s, "t1").status, Status::Queued);
        assert!(!s.halted);
    }

    #[test]
    fn merge_strategy_conflict_is_aborted_cleanly() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        fs::write(w1.join("a.txt"), "1\nWS\n3\n").unwrap();
        g(&w1, &["commit", "-q", "-am", "ws edit"]);
        fs::write(f.root.join("a.txt"), "1\nMAIN\n3\n").unwrap();
        g(&f.root, &["commit", "-q", "-am", "main edit"]);
        enq(&f, &["t1"], Strategy::Merge, None);
        let r = next(&f);
        assert_eq!(r.outcome, Outcome::Failed);
        assert_eq!(item(&r.state, "t1").conflicts.len(), 1);
        assert_eq!(g(&w1, &["status", "--porcelain"]), "");
        assert!(!git_dir_of(&w1).unwrap().join("MERGE_HEAD").exists());
    }

    #[test]
    fn needs_test_then_failed_report_does_not_merge() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        let w2 = mk(&f, "two", "t2");
        commit_file(&w1, "one.txt", "1\n", "one");
        commit_file(&w2, "two.txt", "2\n", "two");
        let main_head = g(&f.root, &["rev-parse", "HEAD"]);
        enq(
            &f,
            &["t1", "t2"],
            Strategy::FastForward,
            Some("  npm test  "),
        );
        let r = next(&f);
        assert_eq!(r.outcome, Outcome::NeedsTest);
        let needs = r.needs_test.clone().unwrap();
        assert_eq!(
            (needs.task_id.as_str(), needs.command.as_str()),
            ("t1", "npm test")
        );
        assert_eq!(
            PathBuf::from(&needs.worktree_path).canonicalize().unwrap(),
            w1.canonicalize().unwrap()
        );
        assert_eq!(item(&r.state, "t1").status, Status::Testing);
        // Asking again is idempotent and merges nothing.
        let again = next(&f);
        assert_eq!(
            (again.outcome, again.needs_test),
            (Outcome::NeedsTest, r.needs_test)
        );
        assert_eq!(g(&f.root, &["rev-parse", "HEAD"]), main_head);
        // Reporting for an item that is not testing is refused.
        assert_eq!(
            code(&report_test(&f.store, rs(&f), "t2", true, "").unwrap_err()),
            "invalid_state"
        );
        assert_eq!(
            code(&report_test(&f.store, rs(&f), "nope", true, "").unwrap_err()),
            "not_found"
        );

        let s = report_test(&f.store, rs(&f), "t1", false, "1 failing\nFAIL some test").unwrap();
        let t1 = item(&s, "t1");
        assert_eq!(t1.status, Status::Failed);
        assert!(t1.error.as_deref().unwrap().contains("FAIL some test"));
        assert!(s.halted);
        assert_eq!(item(&s, "t2").status, Status::Queued);
        assert_eq!(
            g(&f.root, &["rev-parse", "HEAD"]),
            main_head,
            "nothing merged"
        );
        assert!(!f.root.join("one.txt").exists());
        assert_eq!(next(&f).outcome, Outcome::Halted);
    }

    #[test]
    fn needs_test_then_passing_report_merges_on_the_next_run() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        commit_file(&w1, "one.txt", "1\n", "one");
        enq(&f, &["t1"], Strategy::FastForward, Some("npm test"));
        assert_eq!(next(&f).outcome, Outcome::NeedsTest);
        let s = report_test(&f.store, rs(&f), "t1", true, "ok").unwrap();
        assert_eq!(item(&s, "t1").status, Status::Merging);
        assert!(!f.root.join("one.txt").exists(), "report_test never merges");
        let r = next(&f);
        assert_eq!(r.outcome, Outcome::Merged);
        assert!(f.root.join("one.txt").exists());
    }

    #[test]
    fn target_moving_after_the_test_triggers_another_rebase() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        commit_file(&w1, "one.txt", "1\n", "one");
        enq(&f, &["t1"], Strategy::FastForward, Some("npm test"));
        assert_eq!(next(&f).outcome, Outcome::NeedsTest);
        report_test(&f.store, rs(&f), "t1", true, "").unwrap();
        commit_file(&f.root, "late.txt", "l\n", "late commit on main");
        // The branch is no longer up to date: it is re-integrated and must be tested again.
        let r = next(&f);
        assert_eq!(r.outcome, Outcome::NeedsTest);
        report_test(&f.store, rs(&f), "t1", true, "").unwrap();
        assert_eq!(next(&f).outcome, Outcome::Merged);
        assert_eq!(
            g(&f.root, &["log", "--format=%s", "-n", "2"])
                .lines()
                .collect::<Vec<_>>(),
            vec!["one", "late commit on main"]
        );
    }

    #[test]
    fn dirty_or_wrong_target_is_a_typed_error_and_retryable() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        commit_file(&w1, "one.txt", "1\n", "one");
        enq(&f, &["t1"], Strategy::FastForward, None);
        fs::write(f.root.join("a.txt"), "dirty\n").unwrap();
        let e = run_next(&f.store, rs(&f)).unwrap_err();
        assert_eq!(code(&e), "target_dirty", "{e}");
        assert_eq!(
            item(&status(&f.store, rs(&f)).unwrap(), "t1").status,
            Status::Queued
        );
        g(&f.root, &["checkout", "-q", "--", "a.txt"]);
        g(&f.root, &["checkout", "-q", "-b", "other"]);
        let e = run_next(&f.store, rs(&f)).unwrap_err();
        assert_eq!(code(&e), "target_not_checked_out", "{e}");
        g(&f.root, &["checkout", "-q", "--detach"]);
        assert_eq!(
            code(&run_next(&f.store, rs(&f)).unwrap_err()),
            "target_not_checked_out"
        );
        assert!(!f.root.join("one.txt").exists());
        g(&f.root, &["checkout", "-q", "main"]);
        assert_eq!(next(&f).outcome, Outcome::Merged);
        assert!(f.root.join("one.txt").exists());
        // A dirty target between the test and the merge keeps the item mergeable.
        let w2 = mk(&f, "two", "t2");
        commit_file(&w2, "two.txt", "2\n", "two");
        enq(&f, &["t2"], Strategy::FastForward, Some("npm test"));
        assert_eq!(next(&f).outcome, Outcome::NeedsTest);
        report_test(&f.store, rs(&f), "t2", true, "").unwrap();
        fs::write(f.root.join("a.txt"), "dirty again\n").unwrap();
        assert_eq!(
            code(&run_next(&f.store, rs(&f)).unwrap_err()),
            "target_dirty"
        );
        assert_eq!(
            item(&status(&f.store, rs(&f)).unwrap(), "t2").status,
            Status::Merging
        );
        g(&f.root, &["checkout", "-q", "--", "a.txt"]);
        assert_eq!(next(&f).outcome, Outcome::Merged);
    }

    #[test]
    fn enqueue_validates_everything_before_queueing_anything() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        let w2 = mk(&f, "two", "t2");
        commit_file(&w1, "one.txt", "1\n", "one");
        let e = enqueue(
            &f.store,
            rs(&f),
            &ids(&["t1", "nope"]),
            Strategy::Merge,
            None,
        )
        .unwrap_err();
        assert_eq!(code(&e), "not_found", "{e}");
        assert!(
            status(&f.store, rs(&f)).unwrap().items.is_empty(),
            "all or nothing"
        );
        fs::write(w2.join("scratch.txt"), "wip").unwrap();
        let e = enqueue(&f.store, rs(&f), &ids(&["t1", "t2"]), Strategy::Merge, None).unwrap_err();
        assert_eq!(code(&e), "dirty", "{e}");
        assert!(status(&f.store, rs(&f)).unwrap().items.is_empty());
        assert_eq!(
            code(&enqueue(&f.store, rs(&f), &[], Strategy::Merge, None).unwrap_err()),
            "invalid_request"
        );
        assert_eq!(
            code(&enqueue(&f.store, rs(&f), &ids(&["../x"]), Strategy::Merge, None).unwrap_err()),
            "invalid_task_id"
        );
        assert_eq!(
            code(
                &enqueue(&f.store, rs(&f), &ids(&["t1", "t1"]), Strategy::Merge, None).unwrap_err()
            ),
            "already_queued"
        );
        assert_eq!(
            code(&Strategy::parse("rebase").unwrap_err()),
            "invalid_strategy"
        );
        assert_eq!(
            code(
                &enqueue(
                    &f.store,
                    rs(&f),
                    &ids(&["t1"]),
                    Strategy::Merge,
                    Some("a\0b".into())
                )
                .unwrap_err()
            ),
            "invalid_request"
        );
        let s = enq(&f, &["t1"], Strategy::Merge, Some("   "));
        assert_eq!(
            item(&s, "t1").test_command,
            None,
            "a blank command means no test"
        );
        let e = enqueue(&f.store, rs(&f), &ids(&["t1"]), Strategy::Merge, None).unwrap_err();
        assert_eq!(code(&e), "already_queued", "{e}");
        // The branch of a missing workspace directory cannot be queued.
        fs::remove_dir_all(&w2).unwrap();
        assert_eq!(
            code(&enqueue(&f.store, rs(&f), &ids(&["t2"]), Strategy::Merge, None).unwrap_err()),
            "not_found"
        );
    }

    #[test]
    fn workspace_that_became_dirty_fails_its_item() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        commit_file(&w1, "one.txt", "1\n", "one");
        commit_file(&f.root, "m.txt", "m\n", "main moves");
        enq(&f, &["t1"], Strategy::FastForward, None);
        fs::write(w1.join("wip.txt"), "wip").unwrap();
        let r = next(&f);
        assert_eq!(r.outcome, Outcome::Failed);
        assert!(item(&r.state, "t1")
            .error
            .as_deref()
            .unwrap()
            .starts_with("dirty:"));
    }

    #[test]
    fn branch_already_in_the_target_is_skipped() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        commit_file(&w1, "one.txt", "1\n", "one");
        g(&f.root, &["merge", "-q", "--ff-only", "gustaf/one"]);
        enq(&f, &["t1"], Strategy::FastForward, None);
        let r = next(&f);
        assert_eq!(r.outcome, Outcome::Skipped);
        assert!(!r.state.halted);
        assert_eq!(item(&r.state, "t1").status, Status::Skipped);
    }

    #[test]
    fn cancel_skips_unfinished_items_and_clears_the_halt() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        let w2 = mk(&f, "two", "t2");
        let w3 = mk(&f, "three", "t3");
        commit_file(&w1, "one.txt", "1\n", "one");
        commit_file(&w2, "two.txt", "2\n", "two");
        commit_file(&w3, "three.txt", "3\n", "three");
        enq(
            &f,
            &["t1", "t2", "t3"],
            Strategy::FastForward,
            Some("npm test"),
        );
        assert_eq!(next(&f).outcome, Outcome::NeedsTest);
        let s = cancel(&f.store, rs(&f)).unwrap();
        assert!(s.items.iter().all(|i| i.status == Status::Skipped
            && i.error.as_deref() == Some("cancelled")
            && i.finished_at.is_some()));
        assert_eq!(next(&f).outcome, Outcome::Idle);
        assert!(!f.root.join("one.txt").exists());
        // Merged items keep their status when the rest is cancelled.
        enq(&f, &["t1"], Strategy::FastForward, None);
        assert_eq!(next(&f).outcome, Outcome::Merged);
        enq(&f, &["t2"], Strategy::FastForward, None);
        let s = cancel(&f.store, rs(&f)).unwrap();
        assert_eq!(item(&s, "t1").status, Status::Merged);
        assert_eq!(item(&s, "t2").status, Status::Skipped);
        assert!(
            cancel(&f.store, rs(&f)).is_ok(),
            "cancelling an empty queue is fine"
        );
    }

    #[test]
    fn a_live_lock_blocks_and_stale_locks_are_recovered() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        commit_file(&w1, "one.txt", "1\n", "one");
        enq(&f, &["t1"], Strategy::FastForward, None);
        let lock = lock_path(&f);
        // Held by this live process, fresh: concurrent runs are refused.
        fs::write(&lock, format!("{}\n{}\n", std::process::id(), now())).unwrap();
        for e in [
            run_next(&f.store, rs(&f)).unwrap_err(),
            cancel(&f.store, rs(&f)).unwrap_err(),
            report_test(&f.store, rs(&f), "t1", true, "").unwrap_err(),
            enqueue(&f.store, rs(&f), &ids(&["t1"]), Strategy::Merge, None).unwrap_err(),
        ] {
            assert_eq!(code(&e), "queue_busy", "{e}");
        }
        assert!(lock.exists(), "a live lock is left alone");
        assert!(
            status(&f.store, rs(&f)).is_ok(),
            "status never needs the lock"
        );
        // Old lock (even with a live pid): stale.
        fs::write(
            &lock,
            format!("{}\n{}\n", std::process::id(), now() - STALE_LOCK_SECS - 5),
        )
        .unwrap();
        assert_eq!(next(&f).outcome, Outcome::Merged);
        assert!(!lock.exists(), "the lock is released after a run");
    }

    #[cfg(unix)]
    #[test]
    fn a_lock_of_a_dead_process_is_recovered() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        commit_file(&w1, "one.txt", "1\n", "one");
        enq(&f, &["t1"], Strategy::FastForward, None);
        let mut child = Command::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let dead = child.id();
        child.wait().unwrap();
        assert!(!pid_alive(dead));
        assert!(pid_alive(std::process::id()));
        fs::write(lock_path(&f), format!("{dead}\n{}\n", now())).unwrap();
        assert_eq!(next(&f).outcome, Outcome::Merged);
        // Garbage content in a young lock file is respected: it may still be being written.
        fs::write(lock_path(&f), "x").unwrap();
        assert_eq!(code(&run_next(&f.store, rs(&f)).unwrap_err()), "queue_busy");
    }

    #[test]
    fn state_survives_a_restart_and_corruption_is_reported() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        let w2 = mk(&f, "two", "t2");
        commit_file(&w1, "one.txt", "1\n", "one");
        commit_file(&w2, "two.txt", "2\n", "two");
        enq(&f, &["t1", "t2"], Strategy::Squash, Some("cargo test"));
        let before = next(&f).state;
        assert_eq!(item(&before, "t1").status, Status::Testing);
        // "Restart": nothing is cached in memory, everything is read back from disk.
        let after = status(&f.store, rs(&f)).unwrap();
        assert_eq!(before.items, after.items);
        let repo = open_repo(&f.store, rs(&f)).unwrap();
        let on_disk: QueueState =
            serde_json::from_str(&fs::read_to_string(state_path(&repo)).unwrap()).unwrap();
        assert_eq!(on_disk, after);
        assert!(
            !repo.managed.join(format!("{STATE_FILE}.tmp")).exists(),
            "atomic write leaves no temp file"
        );
        assert!(!repo.managed.join(LOCK_FILE).exists());
        let r = next(&f);
        assert_eq!(
            r.outcome,
            Outcome::NeedsTest,
            "resumes the item that was waiting for its test"
        );
        report_test(&f.store, rs(&f), "t1", true, "").unwrap();
        assert_eq!(next(&f).outcome, Outcome::Merged);
        let r = next(&f);
        assert_eq!(
            (r.outcome, r.task_id.as_deref()),
            (Outcome::NeedsTest, Some("t2"))
        );
        // The queue files never look like workspaces.
        assert_eq!(worktree::list(&f.store, rs(&f)).unwrap().len(), 2);
        fs::write(state_path(&repo), "{ not json").unwrap();
        assert_eq!(code(&status(&f.store, rs(&f)).unwrap_err()), "state_error");
        assert_eq!(
            code(&run_next(&f.store, rs(&f)).unwrap_err()),
            "state_error"
        );
    }

    #[test]
    fn an_item_left_rebasing_by_a_crash_is_picked_up_again() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        commit_file(&w1, "one.txt", "1\n", "one");
        commit_file(&f.root, "m.txt", "m\n", "main moves");
        enq(&f, &["t1"], Strategy::FastForward, None);
        // Simulate a crash after the item was marked `rebasing`: the next run picks it up from the start.
        let repo = open_repo(&f.store, rs(&f)).unwrap();
        let mut state = load(&repo).unwrap();
        state.items[0].status = Status::Rebasing;
        save(&repo, &mut state).unwrap();
        let r = next(&f);
        assert_eq!(r.outcome, Outcome::Merged);
        assert!(f.root.join("one.txt").exists() && f.root.join("m.txt").exists());
    }

    #[test]
    fn history_is_bounded() {
        let f = fx();
        let repo = open_repo(&f.store, rs(&f)).unwrap();
        let mut state = QueueState::default();
        for n in 0..(MAX_HISTORY + 10) {
            state.items.push(QueueItem {
                task_id: format!("t{n}"),
                branch: format!("gustaf/t{n}"),
                status: Status::Merged,
                error: None,
                conflicts: Vec::new(),
                strategy: Strategy::Merge,
                test_command: None,
                target_branch: "main".into(),
                enqueued_at: 0,
                started_at: None,
                finished_at: None,
            });
        }
        save(&repo, &mut state).unwrap();
        let loaded = load(&repo).unwrap();
        assert_eq!(loaded.items.len(), MAX_HISTORY);
        assert_eq!(
            loaded.items.first().unwrap().task_id,
            "t10",
            "the oldest finished items are dropped"
        );
    }

    #[test]
    fn serialised_shapes_match_the_typescript_wrapper() {
        let f = fx();
        let w1 = mk(&f, "one", "t1");
        commit_file(&w1, "one.txt", "1\n", "one");
        let s = enq(&f, &["t1"], Strategy::FastForward, Some("npm test"));
        let json = serde_json::to_value(&s).unwrap();
        let item = &json["items"][0];
        assert_eq!(item["status"], "queued");
        assert_eq!(item["strategy"], "fast_forward");
        assert_eq!(item["taskId"], "t1");
        assert_eq!(item["testCommand"], "npm test");
        assert_eq!(item["targetBranch"], "main");
        assert!(item["startedAt"].is_null() && item["error"].is_null());
        assert_eq!(json["halted"], false);
        let r = serde_json::to_value(next(&f)).unwrap();
        assert_eq!(r["outcome"], "needs_test");
        assert_eq!(r["needsTest"]["command"], "npm test");
        assert!(r["needsTest"]["worktreePath"].is_string());
        let c =
            serde_json::to_value(check_conflicts(&f.store, rs(&f), "t1", &[]).unwrap()).unwrap();
        assert_eq!(c["checks"][0]["againstTaskId"], serde_json::Value::Null);
        assert_eq!(c["clean"], true);
    }
}
