use crate::tools::resolve_in_root;
use serde::Serialize;
use std::{
    collections::hash_map::DefaultHasher,
    collections::{HashMap, HashSet},
    ffi::OsStr,
    fs,
    hash::{Hash, Hasher},
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};

// Multiple mounted chats and refreshes can share a shadow index. Git uses an
// exclusive index.lock, so serialize commands targeting the same project.
static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

/// Shadow repo per project in app data, so checkpoints never touch the user's own git.
fn shadow_dir(app: &AppHandle, root: &str) -> Result<PathBuf, String> {
    let mut h = DefaultHasher::new();
    root.hash(&mut h);
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("shadow").join(format!("{:x}", h.finish()));
    if !dir.join("HEAD").exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        run(Command::new("git").args(["init", "-q", "--bare"]).arg(&dir))?;
        fs::create_dir_all(dir.join("info")).map_err(|e| e.to_string())?;
        fs::write(dir.join("info/exclude"), ".git/\nnode_modules\ntarget/\ndist/\n.DS_Store\n").map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd
        .env("GIT_AUTHOR_NAME", "mcode")
        .env("GIT_AUTHOR_EMAIL", "mcode@local")
        .env("GIT_COMMITTER_NAME", "mcode")
        .env("GIT_COMMITTER_EMAIL", "mcode@local")
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Runs git in `root`; with `shadow` it targets the app's checkpoint repo instead of the project's own `.git`.
#[tauri::command]
pub async fn git(app: AppHandle, root: String, args: Vec<String>, shadow: bool) -> Result<String, String> {
    let key = PathBuf::from(&root).canonicalize().map_err(|e| e.to_string())?;
    let lock = LOCKS.get_or_init(Default::default).lock().map_err(|e| e.to_string())?.entry(key).or_default().clone();
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    let mut cmd = Command::new("git");
    cmd.current_dir(&root);
    if shadow {
        cmd.arg(format!("--git-dir={}", shadow_dir(&app, &root)?.display())).arg(format!("--work-tree={root}"));
    }
    run(cmd.args(&args))
}

// ---------------------------------------------------------------------------
// The project's own repository: status, commit-message context and commits.
//
// Unlike the shadow checkpoint repo above, these commands act on the user's real
// `.git`, so they are deliberately narrow: every git call uses an argument array
// (no shell), user paths are validated to stay inside the project and passed as
// literal pathspecs, hooks and signing are never bypassed, and nothing is ever
// pushed, amended or forced.
// ---------------------------------------------------------------------------

/// Serializes multi-step operations (branch switch + add + commit) per repository.
static REPO_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

const MAX_FILES: usize = 1000;
const MAX_PATHS: usize = 10_000;
const MAX_MESSAGE_CHARS: usize = 20_000;
const MAX_ERROR_CHARS: usize = 4_000;
const MAX_TRACKED_DIFFS: usize = 40;
const MAX_UNTRACKED_DIFFS: usize = 20;
const RECENT_SUBJECTS: usize = 8;
const DEFAULT_DIFF_BYTES: usize = 24_000;
/// Files above this size are diffed as "Binary files differ", so one huge file cannot flood memory.
pub(crate) const BIG_FILE: &str = "core.bigFileThreshold=1m";

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Modified,
    Added,
    Deleted,
    Untracked,
    Conflicted,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    /// Relative to the project root, `/`-separated.
    pub path: String,
    pub kind: Kind,
    /// Some of the change is already in the index.
    pub staged: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// False when the project is not inside a git work tree (or git is not installed).
    pub repo: bool,
    pub toplevel: String,
    /// Project root relative to the repository root (`""` or `sub/dir/`).
    pub prefix: String,
    /// `None` while HEAD is detached.
    pub branch: Option<String>,
    pub detached: bool,
    /// Short id of HEAD; `None` before the first commit.
    pub head: Option<String>,
    pub files: Vec<GitFile>,
    /// Number of changed files under the project root (`files` is capped).
    pub total: usize,
    /// `merge`, `rebase`, `cherry-pick` or `revert` while one is unfinished.
    pub in_progress: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitContext {
    pub files: Vec<String>,
    pub stat: String,
    pub diff: String,
    pub truncated: bool,
    pub recent: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub sha: String,
    pub short: String,
    pub branch: Option<String>,
    pub files: Vec<String>,
    pub created_branch: bool,
}

pub(crate) fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let base = Path::new(root).canonicalize().map_err(|e| format!("project root: {e}"))?;
    if !base.is_dir() {
        return Err(format!("project root is not a directory: {root}"));
    }
    Ok(base)
}

fn repo_lock(key: &Path) -> Arc<Mutex<()>> {
    let mut map = REPO_LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    map.entry(key.to_path_buf()).or_default().clone()
}

pub(crate) fn tail_chars(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let tail: String = text.chars().skip(count - max).collect();
    format!("…\n{tail}")
}

pub(crate) fn repo_command(root: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(root)
        // Read-only calls must not take index.lock behind the user's back; repo-configured
        // fsmonitor hooks are commands and must not run just because we looked at the status.
        .args(["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=off"])
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0");
    for var in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"] {
        cmd.env_remove(var);
    }
    cmd
}

fn run_git_raw<I, S>(root: &Path, args: I) -> Result<Output, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    repo_command(root).args(args).output().map_err(|e| format!("git: {e}"))
}

pub(crate) fn failure_text(out: &Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let parts: Vec<&str> = [stderr.trim(), stdout.trim()].into_iter().filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return format!("git exited with {}", out.status);
    }
    tail_chars(&parts.join("\n"), MAX_ERROR_CHARS)
}

pub(crate) fn run_git<I, S>(root: &Path, args: I) -> Result<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let out = run_git_raw(root, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(failure_text(&out))
    }
}

/// Runs git and keeps at most `cap` bytes of its output: when there is more, git is killed and the flag is
/// set. Succeeds when git exits with one of `ok_codes` (or was cut off), otherwise returns its error text.
pub(crate) fn run_git_capped<I, S>(root: &Path, args: I, cap: usize, ok_codes: &[i32]) -> Result<(String, bool), String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut child = repo_command(root).args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("git: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("git: no output pipe")?;
    let mut buf = Vec::new();
    let read = stdout.by_ref().take(cap as u64 + 1).read_to_end(&mut buf);
    let cut = buf.len() > cap;
    if cut {
        let _ = child.kill();
        buf.truncate(cap);
    }
    drop(stdout);
    let out = child.wait_with_output().map_err(|e| format!("git: {e}"))?;
    read.map_err(|e| format!("git: {e}"))?;
    if !cut && !out.status.code().is_some_and(|c| ok_codes.contains(&c)) {
        return Err(failure_text(&out));
    }
    Ok((String::from_utf8_lossy(&buf).into_owned(), cut))
}

struct RepoInfo {
    toplevel: String,
    prefix: String,
    git_dir: PathBuf,
}

fn repo_info(root: &Path) -> Option<RepoInfo> {
    let out = run_git(root, ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--show-prefix", "--absolute-git-dir"]).ok()?;
    let mut lines = out.split('\n');
    if lines.next()? != "true" {
        return None;
    }
    let toplevel = lines.next()?.to_string();
    let prefix = lines.next()?.to_string();
    let git_dir = PathBuf::from(lines.next()?);
    Some(RepoInfo { toplevel, prefix, git_dir })
}

pub(crate) fn current_branch(root: &Path) -> Option<String> {
    run_git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn head_short(root: &Path) -> Option<String> {
    run_git(root, ["rev-parse", "--short", "--verify", "-q", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn unfinished_operation(git_dir: &Path) -> Option<&'static str> {
    [("MERGE_HEAD", "merge"), ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert"), ("rebase-merge", "rebase"), ("rebase-apply", "rebase")]
        .into_iter()
        .find(|(marker, _)| git_dir.join(marker).exists())
        .map(|(_, name)| name)
}

fn classify(x: u8, y: u8) -> Kind {
    if x == b'U' || y == b'U' || (x == b'A' && y == b'A') || (x == b'D' && y == b'D') {
        Kind::Conflicted
    } else if x == b'?' {
        Kind::Untracked
    } else if x == b'D' || y == b'D' {
        Kind::Deleted
    } else if x == b'A' || y == b'A' {
        Kind::Added
    } else {
        Kind::Modified
    }
}

/// Parses `status --porcelain=v1 -z --no-renames` output, keeping entries under `prefix` (project root).
fn parse_porcelain(raw: &str, prefix: &str, cap: usize) -> (Vec<GitFile>, usize) {
    let mut files = Vec::new();
    let mut total = 0;
    for entry in raw.split('\0') {
        let (Some(xy), Some(path)) = (entry.get(..2), entry.get(3..)) else { continue };
        if entry.as_bytes()[2] != b' ' {
            continue;
        }
        let Some(path) = path.strip_prefix(prefix) else { continue };
        if path.is_empty() {
            continue;
        }
        total += 1;
        if files.len() < cap {
            let (x, y) = (xy.as_bytes()[0], xy.as_bytes()[1]);
            files.push(GitFile { path: path.to_string(), kind: classify(x, y), staged: x != b' ' && x != b'?' });
        }
    }
    (files, total)
}

fn not_a_repo() -> GitStatus {
    GitStatus { repo: false, toplevel: String::new(), prefix: String::new(), branch: None, detached: false, head: None, files: Vec::new(), total: 0, in_progress: None }
}

/// Branch, HEAD and the changed files under `root` (at most `MAX_FILES` listed; `total` counts them all).
/// A non-repository is `repo: false`, not an error.
pub fn status(root: &Path) -> Result<GitStatus, String> {
    status_capped(root, MAX_FILES)
}

/// Like `status`, listing up to `cap` files. Commit paths are checked against the full list (`usize::MAX`),
/// so a file beyond the display cap can still be committed.
fn status_capped(root: &Path, cap: usize) -> Result<GitStatus, String> {
    let Some(info) = repo_info(root) else { return Ok(not_a_repo()) };
    let raw = run_git(root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", "."])?;
    let (files, total) = parse_porcelain(&raw, &info.prefix, cap);
    let branch = current_branch(root);
    Ok(GitStatus {
        repo: true,
        detached: branch.is_none(),
        branch,
        head: head_short(root),
        files,
        total,
        in_progress: unfinished_operation(&info.git_dir).map(String::from),
        toplevel: info.toplevel,
        prefix: info.prefix,
    })
}

/// Validates user-supplied paths: relative, inside the project (no `..`, no symlink escapes), never
/// inside `.git`. Returns them normalized (`/`-separated, no `./`, no duplicates).
fn validate_paths(root: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("No files selected".into());
    }
    if paths.len() > MAX_PATHS {
        return Err(format!("Too many files (limit {MAX_PATHS})"));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in paths {
        if raw.is_empty() || raw.contains('\0') {
            return Err(format!("Invalid file path: {raw:?}"));
        }
        let path = Path::new(raw);
        if path.is_absolute() {
            return Err(format!("Path must be relative to the project: {raw}"));
        }
        let mut parts = Vec::new();
        for (i, comp) in path.components().enumerate() {
            match comp {
                Component::CurDir if i == 0 => {}
                Component::Normal(n) if n.eq_ignore_ascii_case(".git") => return Err(format!("Refusing to touch .git: {raw}")),
                Component::Normal(n) => parts.push(n.to_str().ok_or_else(|| format!("Non-UTF8 file path: {raw}"))?.to_string()),
                _ => return Err(format!("path escapes project: {raw}")),
            }
        }
        if parts.is_empty() {
            return Err(format!("Invalid file path: {raw:?}"));
        }
        let normalized = parts.join("/");
        resolve_in_root(root, &normalized)?;
        if seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    }
    Ok(out)
}

/// Literal pathspec: no globbing, no pathspec magic, whatever the file is called.
fn literal(path: &str) -> String {
    format!(":(literal){path}")
}

fn literals(paths: &[String]) -> Vec<String> {
    paths.iter().map(|p| literal(p)).collect()
}

fn cut_at_line(text: &str, max: usize) -> String {
    let mut cut = max.min(text.len());
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let head = &text[..cut];
    let end = head.rfind('\n').map(|i| i + 1).filter(|&i| i > 0).unwrap_or(cut);
    let mut out = head[..end].to_string();
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Fits `sections` into `max` bytes with max-min fairness, so one huge file (a lockfile) cannot
/// crowd out the others. Returns the text and whether anything was cut.
fn budget_sections(sections: &[String], max: usize) -> (String, bool) {
    let total: usize = sections.iter().map(String::len).sum();
    if total <= max {
        return (sections.concat(), false);
    }
    let mut order: Vec<usize> = (0..sections.len()).collect();
    order.sort_by_key(|&i| sections[i].len());
    let (mut remaining, mut left) = (max, sections.len());
    let mut allowance = vec![0usize; sections.len()];
    for i in order {
        allowance[i] = sections[i].len().min(remaining / left);
        remaining -= allowance[i];
        left -= 1;
    }
    let mut out = String::new();
    for (i, section) in sections.iter().enumerate() {
        if section.len() <= allowance[i] {
            out.push_str(section);
        } else {
            out.push_str(&cut_at_line(section, allowance[i]));
            out.push_str("[... diff truncated ...]\n");
        }
    }
    (out, true)
}

/// Bounded, hook-free summary of the selected changes, for generating a commit message.
pub fn commit_context(root: &Path, paths: &[String], max_bytes: usize) -> Result<CommitContext, String> {
    let wanted = validate_paths(root, paths)?;
    let st = status_capped(root, usize::MAX)?;
    if !st.repo {
        return Err("This project is not a git repository".into());
    }
    let selected: Vec<&GitFile> = st.files.iter().filter(|f| f.kind != Kind::Conflicted && wanted.contains(&f.path)).collect();
    if selected.is_empty() {
        return Err("No changes in the selected files".into());
    }
    let max = max_bytes.clamp(2_000, 200_000);
    let tracked: Vec<String> = selected.iter().filter(|f| f.kind != Kind::Untracked).map(|f| f.path.clone()).collect();
    let untracked: Vec<String> = selected.iter().filter(|f| f.kind == Kind::Untracked).map(|f| f.path.clone()).collect();

    let mut stat = String::new();
    let mut sections = Vec::new();
    let mut truncated = tracked.len() > MAX_TRACKED_DIFFS || untracked.len() > MAX_UNTRACKED_DIFFS;
    if !tracked.is_empty() {
        // textconv and external diff drivers are commands configured by the repository; never run them.
        let base = if st.head.is_some() { "HEAD".to_string() } else { run_git(root, ["hash-object", "-t", "tree", "--stdin"])?.trim().to_string() };
        let diff_cmd = |extra: &[&str], paths: &[String]| -> Vec<String> {
            let head = ["-c", BIG_FILE, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
            head.iter().chain(extra).map(|s| s.to_string()).chain([base.clone(), "--".to_string()]).chain(literals(paths)).collect()
        };
        stat.push_str(&run_git(root, diff_cmd(&["--stat=100,60,40"], &tracked))?);
        // One bounded call per file: a huge diff of one file (a lockfile) is cut at `max` bytes while the
        // others still arrive, and git's output never has to fit in memory in full.
        for path in tracked.iter().take(MAX_TRACKED_DIFFS) {
            let (text, cut) = run_git_capped(root, diff_cmd(&["--unified=2"], std::slice::from_ref(path)), max, &[0])?;
            truncated |= cut;
            sections.push(text);
        }
    }
    for path in &untracked {
        stat.push_str(&format!(" {path} | new file\n"));
    }
    for path in untracked.iter().take(MAX_UNTRACKED_DIFFS) {
        let args = ["-c", BIG_FILE, "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=2", "--", "/dev/null", path.as_str()];
        // --no-index exits 1 when the files differ, which is the normal case here.
        let (text, cut) = run_git_capped(root, args, max, &[0, 1])?;
        truncated |= cut;
        sections.push(text);
    }
    let (diff, cut) = budget_sections(&sections, max);
    truncated |= cut;
    let recent = if st.head.is_some() {
        run_git(root, ["log", "-n", &RECENT_SUBJECTS.to_string(), "--format=%s", "--no-color", "--no-show-signature"])
            .map(|out| out.lines().map(|l| l.chars().take(200).collect::<String>()).filter(|l| !l.trim().is_empty()).collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok(CommitContext { files: selected.iter().map(|f| f.path.clone()).collect(), stat, diff, truncated, recent })
}

fn validate_branch_name(root: &Path, name: &str) -> Result<(), String> {
    let invalid = || format!("Invalid branch name: {name}");
    if name.is_empty() || name.len() > 200 || name.starts_with('-') || name == "HEAD" || name == "@" || name.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(invalid());
    }
    run_git(root, ["check-ref-format", &format!("refs/heads/{name}")]).map_err(|_| invalid())?;
    if run_git(root, ["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")]).is_ok() {
        return Err(format!("Branch already exists: {name}"));
    }
    Ok(())
}

/// Arguments of the commit itself. Pure so the safety properties can be tested: the paths are
/// literal pathspecs after `--`, `--only` leaves anything else in the index out of the commit, and
/// there is intentionally no `--no-verify`, `--no-gpg-sign`, `--amend` or `--allow-empty`.
fn commit_args(message: &str, paths: &[String]) -> Vec<String> {
    let mut args: Vec<String> = ["commit", "-q", "--only", "-m"].iter().map(|s| s.to_string()).collect();
    args.push(message.to_string());
    args.push("--".to_string());
    args.extend(literals(paths));
    args
}

enum Origin {
    Branch(String),
    Detached(String),
    Unborn(String),
}

/// Puts HEAD back where it was after a failed commit on a freshly created branch.
fn undo_branch(root: &Path, origin: &Origin, created: &str, created_at: Option<&str>) {
    match origin {
        Origin::Branch(b) => drop(run_git(root, ["checkout", "-q", b.as_str(), "--"])),
        Origin::Detached(sha) => drop(run_git(root, ["checkout", "-q", "--detach", sha.as_str()])),
        Origin::Unborn(b) => drop(run_git(root, ["symbolic-ref", "HEAD", &format!("refs/heads/{b}")])),
    }
    // Only drop the branch if it still points where we created it, i.e. nothing was committed on it.
    let tip = run_git(root, ["rev-parse", "--verify", "-q", &format!("refs/heads/{created}")]).ok().map(|s| s.trim().to_string());
    if tip.is_some() && tip.as_deref() == created_at {
        let _ = run_git(root, ["branch", "-D", created]);
    }
}

fn with_paths(head: &[&str], paths: &[String]) -> Vec<String> {
    head.iter().map(|s| s.to_string()).chain(literals(paths)).collect()
}

/// Commits exactly `paths` (never the rest of the index or working tree), optionally on a new branch.
pub fn commit(root: &Path, message: &str, paths: &[String], new_branch: Option<&str>) -> Result<CommitResult, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message is empty".into());
    }
    if message.contains('\0') || message.chars().count() > MAX_MESSAGE_CHARS {
        return Err("Invalid commit message".into());
    }
    let wanted = validate_paths(root, paths)?;
    let new_branch = new_branch.map(str::trim).filter(|b| !b.is_empty());

    let Some(info) = repo_info(root) else { return Err("This project is not a git repository".into()) };
    let lock = repo_lock(Path::new(&info.toplevel));
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    let st = status_capped(root, usize::MAX)?;
    if let Some(op) = &st.in_progress {
        return Err(format!("A {op} is in progress. Finish it before committing."));
    }
    let selected: Vec<&GitFile> = st.files.iter().filter(|f| wanted.contains(&f.path)).collect();
    if let Some(f) = selected.iter().find(|f| f.kind == Kind::Conflicted) {
        return Err(format!("{} has unresolved conflicts", f.path));
    }
    if selected.is_empty() {
        return Err("No changes to commit in the selected files".into());
    }
    let files: Vec<String> = selected.iter().map(|f| f.path.clone()).collect();
    let newly_staged: Vec<String> = selected.iter().filter(|f| !f.staged).map(|f| f.path.clone()).collect();

    let mut created: Option<(Origin, String, Option<String>)> = None;
    if let Some(name) = new_branch {
        validate_branch_name(root, name)?;
        let origin = match (&st.branch, &st.head) {
            (Some(b), Some(_)) => Origin::Branch(b.clone()),
            (Some(b), None) => Origin::Unborn(b.clone()),
            (None, _) => Origin::Detached(run_git(root, ["rev-parse", "--verify", "HEAD"])?.trim().to_string()),
        };
        run_git(root, ["checkout", "-q", "-b", name])?;
        let at = run_git(root, ["rev-parse", "--verify", "-q", "HEAD"]).ok().map(|s| s.trim().to_string());
        created = Some((origin, name.to_string(), at));
    }

    let result = run_git(root, with_paths(&["add", "--"], &files)).and_then(|_| run_git(root, commit_args(message, &files)));
    if let Err(e) = result {
        if !newly_staged.is_empty() {
            let _ = run_git(root, with_paths(&["reset", "-q", "--"], &newly_staged));
        }
        if let Some((origin, name, at)) = &created {
            undo_branch(root, origin, name, at.as_deref());
        }
        return Err(e);
    }
    let sha = run_git(root, ["rev-parse", "--verify", "HEAD"])?.trim().to_string();
    let short = run_git(root, ["rev-parse", "--short", "HEAD"])?.trim().to_string();
    Ok(CommitResult { sha, short, branch: current_branch(root), files, created_branch: created.is_some() })
}

pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

/// Branch, HEAD and changed files of the project's repository (`repo: false` when there is none).
#[tauri::command]
pub async fn git_status(root: String) -> Result<GitStatus, String> {
    blocking(move || status(&canonical_root(&root)?)).await
}

/// Bounded diff, stat and recent subjects of the given changed files, to generate a commit message from.
#[tauri::command]
pub async fn git_commit_context(root: String, paths: Vec<String>, max_bytes: Option<usize>) -> Result<CommitContext, String> {
    blocking(move || commit_context(&canonical_root(&root)?, &paths, max_bytes.unwrap_or(DEFAULT_DIFF_BYTES))).await
}

/// Commits only `paths`, optionally on a new branch created from the current HEAD. Hooks run; no push.
#[tauri::command]
pub async fn git_commit(root: String, message: String, paths: Vec<String>, new_branch: Option<String>) -> Result<CommitResult, String> {
    blocking(move || commit(&canonical_root(&root)?, &message, &paths, new_branch.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _tmp: tempfile::TempDir,
        base: PathBuf,
        root: PathBuf,
        hooks: PathBuf,
    }

    fn git_ok(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn git_succeeds(dir: &Path, args: &[&str]) -> bool {
        Command::new("git").current_dir(dir).args(args).output().unwrap().status.success()
    }

    /// A throwaway repository on `main`, isolated from the developer's global hooks and signing config.
    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let (root, hooks) = (base.join("repo"), base.join("hooks"));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&hooks).unwrap();
        git_ok(&root, &["init", "-q"]);
        git_ok(&root, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        for (key, value) in [("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false"), ("core.hooksPath", hooks.to_str().unwrap())] {
            git_ok(&root, &["config", key, value]);
        }
        Fixture { _tmp: tmp, base, root, hooks }
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| i.to_string()).collect()
    }

    fn init_commit(root: &Path, files: &[&str]) {
        for f in files {
            write(root, f, "1\n");
        }
        git_ok(root, &["add", "-A"]);
        git_ok(root, &["commit", "-qm", "init"]);
    }

    fn head_files(root: &Path) -> Vec<String> {
        let mut files: Vec<String> = git_ok(root, &["show", "--name-only", "--format=", "HEAD"]).lines().map(String::from).collect();
        files.sort();
        files
    }

    #[cfg(unix)]
    fn install_hook(f: &Fixture, name: &str, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        let path = f.hooks.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn status_of_a_plain_directory_is_not_a_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let st = status(&tmp.path().canonicalize().unwrap()).unwrap();
        assert!(!st.repo && st.files.is_empty() && st.branch.is_none());
    }

    #[test]
    fn status_reports_branch_head_and_changes() {
        let f = fixture();
        let r = &f.root;
        write(r, "a.txt", "1\n");
        write(r, "dir/b.txt", "1\n");
        let st = status(r).unwrap();
        assert!(st.repo && !st.detached && st.head.is_none() && st.in_progress.is_none());
        assert_eq!(st.branch.as_deref(), Some("main"));
        // Untracked directories are expanded to their files.
        assert_eq!(st.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a.txt", "dir/b.txt"]);
        assert!(st.files.iter().all(|f| f.kind == Kind::Untracked && !f.staged));

        git_ok(r, &["add", "-A"]);
        git_ok(r, &["commit", "-qm", "init"]);
        write(r, "a.txt", "2\n");
        fs::remove_file(r.join("dir/b.txt")).unwrap();
        write(r, "c.txt", "new\n");
        git_ok(r, &["add", "c.txt"]);
        let st = status(r).unwrap();
        assert!(st.head.is_some());
        assert_eq!(
            st.files,
            vec![
                GitFile { path: "a.txt".into(), kind: Kind::Modified, staged: false },
                GitFile { path: "c.txt".into(), kind: Kind::Added, staged: true },
                GitFile { path: "dir/b.txt".into(), kind: Kind::Deleted, staged: false },
            ]
        );
        git_ok(r, &["checkout", "-q", "--detach"]);
        let st = status(r).unwrap();
        assert!(st.detached && st.branch.is_none());
    }

    #[test]
    fn classifies_porcelain_codes_and_applies_the_project_prefix() {
        assert_eq!(classify(b'U', b'U'), Kind::Conflicted);
        assert_eq!(classify(b'A', b'A'), Kind::Conflicted);
        assert_eq!(classify(b'D', b'D'), Kind::Conflicted);
        assert_eq!(classify(b'?', b'?'), Kind::Untracked);
        assert_eq!(classify(b' ', b'D'), Kind::Deleted);
        assert_eq!(classify(b'A', b' '), Kind::Added);
        assert_eq!(classify(b'M', b'M'), Kind::Modified);
        let (files, total) = parse_porcelain(" M app/a.txt\0?? app/dir/b.txt\0A  other/c.txt\0MM app/with space.txt\0", "app/", 100);
        assert_eq!(total, 3);
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a.txt", "dir/b.txt", "with space.txt"]);
        assert_eq!(files[2], GitFile { path: "with space.txt".into(), kind: Kind::Modified, staged: true });
        assert!(parse_porcelain("", "", 100).0.is_empty());
        assert!(parse_porcelain("garbage", "", 100).0.is_empty());
        let (capped, total) = parse_porcelain(" M a\0 M b\0 M c\0", "", 2);
        assert_eq!((capped.len(), total), (2, 3), "the list is capped, the total is not");
    }

    #[test]
    fn commits_only_the_selected_files() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["a.txt", "b.txt"]);
        write(r, "a.txt", "2\n");
        write(r, "b.txt", "2\n");
        write(r, "new.txt", "n\n");
        write(r, "other_new.txt", "o\n");
        git_ok(r, &["add", "b.txt"]); // staged by the user, must stay out of our commit
        let res = commit(r, "  Update a, add new  \n", &s(&["a.txt", "./new.txt", "a.txt"]), None).unwrap();
        assert_eq!(res.files, ["a.txt", "new.txt"]);
        assert!(!res.created_branch);
        assert_eq!(res.branch.as_deref(), Some("main"));
        assert_eq!(head_files(r), ["a.txt", "new.txt"]);
        assert_eq!(git_ok(r, &["log", "-1", "--format=%s"]).trim(), "Update a, add new");
        assert_eq!(git_ok(r, &["rev-parse", "HEAD"]).trim(), res.sha);
        assert_eq!(
            status(r).unwrap().files,
            vec![
                GitFile { path: "b.txt".into(), kind: Kind::Modified, staged: true },
                GitFile { path: "other_new.txt".into(), kind: Kind::Untracked, staged: false },
            ]
        );
    }

    #[test]
    fn commits_a_deletion() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["a.txt", "b.txt"]);
        fs::remove_file(r.join("a.txt")).unwrap();
        commit(r, "Remove a", &s(&["a.txt"]), None).unwrap();
        assert_eq!(git_ok(r, &["show", "--name-status", "--format=", "HEAD"]).trim(), "D\ta.txt");
        assert!(status(r).unwrap().files.is_empty());
    }

    #[test]
    fn commits_on_an_unborn_branch() {
        let f = fixture();
        let r = &f.root;
        write(r, "a.txt", "1\n");
        write(r, "b.txt", "1\n");
        let res = commit(r, "Initial", &s(&["a.txt"]), None).unwrap();
        assert_eq!(head_files(r), ["a.txt"]);
        assert_eq!(res.branch.as_deref(), Some("main"));
        assert_eq!(status(r).unwrap().files, vec![GitFile { path: "b.txt".into(), kind: Kind::Untracked, staged: false }]);
    }

    #[test]
    fn creates_a_branch_from_head_and_commits_there() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["a.txt"]);
        let before = git_ok(r, &["rev-parse", "main"]).trim().to_string();
        write(r, "a.txt", "2\n");
        let res = commit(r, "Change a", &s(&["a.txt"]), Some(" feature/x ")).unwrap();
        assert!(res.created_branch);
        assert_eq!(res.branch.as_deref(), Some("feature/x"));
        assert_eq!(git_ok(r, &["rev-parse", "main"]).trim(), before, "the original branch must not move");
        assert_eq!(git_ok(r, &["rev-parse", "feature/x"]).trim(), res.sha);
        assert_eq!(git_ok(r, &["rev-parse", "HEAD~1"]).trim(), before);
    }

    #[test]
    fn creates_a_branch_from_a_detached_head_and_on_an_unborn_branch() {
        let f = fixture();
        let r = &f.root;
        write(r, "a.txt", "1\n");
        let res = commit(r, "Initial", &s(&["a.txt"]), Some("start")).unwrap();
        assert_eq!(res.branch.as_deref(), Some("start"));
        git_ok(r, &["checkout", "-q", "--detach"]);
        write(r, "a.txt", "2\n");
        let res = commit(r, "Rescue", &s(&["a.txt"]), Some("rescue")).unwrap();
        assert_eq!(res.branch.as_deref(), Some("rescue"));
        assert_eq!(status(r).unwrap().branch.as_deref(), Some("rescue"));
    }

    #[test]
    fn rejects_invalid_or_existing_branch_names_without_touching_anything() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["a.txt"]);
        git_ok(r, &["branch", "taken"]);
        write(r, "a.txt", "2\n");
        let before = git_ok(r, &["rev-parse", "HEAD"]);
        for bad in ["a b", "-x", "--detach", "a..b", "a~1", "a^", "a:b", "x.lock", "/x", "x/", "a//b", "@{u}", "@", "HEAD", "main", "taken", "bad\nname", "a*b", "a[b", "a\\b", "-"] {
            let err = commit(r, "msg", &s(&["a.txt"]), Some(bad)).unwrap_err();
            assert!(err.contains("branch") || err.contains("Branch"), "{bad:?}: {err}");
        }
        assert_eq!(git_ok(r, &["rev-parse", "HEAD"]), before);
        assert_eq!(status(r).unwrap().branch.as_deref(), Some("main"));
        assert_eq!(status(r).unwrap().files.len(), 1);
    }

    #[test]
    fn rejects_empty_or_oversized_messages() {
        let f = fixture();
        let r = &f.root;
        write(r, "a.txt", "1\n");
        for bad in ["", "   \n\t", "has\0nul"] {
            assert!(commit(r, bad, &s(&["a.txt"]), None).is_err(), "{bad:?}");
        }
        assert!(commit(r, &"x".repeat(MAX_MESSAGE_CHARS + 1), &s(&["a.txt"]), None).is_err());
        assert!(status(r).unwrap().head.is_none());
    }

    #[test]
    fn rejects_paths_outside_the_project() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["a.txt"]);
        for bad in ["../x", "/etc/passwd", "a/../../x", "sub/../../x", ".git/config", ".GIT/hooks/pre-commit", "sub/.git/x", "", ".", "./", "nul\0byte"] {
            assert!(validate_paths(r, &s(&[bad])).is_err(), "{bad:?} must be rejected");
        }
        assert!(validate_paths(r, &[]).is_err());
        assert_eq!(validate_paths(r, &s(&["./a//b.txt", "a/b.txt", "new/dir/file"])).unwrap(), ["a/b.txt", "new/dir/file"]);
        assert!(commit(r, "msg", &s(&["../x"]), None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_paths_that_escape_through_a_symlink() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["a.txt"]);
        let outside = f.base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(&outside, r.join("link")).unwrap();
        let before = git_ok(r, &["rev-parse", "HEAD"]);
        let err = commit(r, "msg", &s(&["link/secret.txt"]), None).unwrap_err();
        assert!(err.contains("escapes"), "{err}");
        assert!(commit_context(r, &s(&["link/secret.txt"]), 5000).is_err());
        assert_eq!(git_ok(r, &["rev-parse", "HEAD"]), before);
    }

    #[test]
    fn paths_are_literal_never_globs() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["a.txt"]);
        write(r, "x.txt", "x\n");
        write(r, "y.txt", "y\n");
        let before = git_ok(r, &["rev-parse", "HEAD"]);
        let err = commit(r, "msg", &s(&["*.txt"]), None).unwrap_err();
        assert!(err.contains("No changes"), "{err}");
        assert_eq!(git_ok(r, &["rev-parse", "HEAD"]), before);
        assert_eq!(status(r).unwrap().files.len(), 2);

        write(r, "we[1].txt", "w\n");
        write(r, "we1.txt", "w\n");
        commit(r, "Add literal", &s(&["we[1].txt"]), None).unwrap();
        assert_eq!(head_files(r), ["we[1].txt"]);
    }

    #[test]
    fn a_project_inside_a_larger_repository_only_sees_and_commits_its_own_files() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["app/a.txt", "other/b.txt"]);
        write(r, "app/a.txt", "2\n");
        write(r, "app/sub/new.txt", "n\n");
        write(r, "other/b.txt", "2\n");
        let app = r.join("app");
        let st = status(&app).unwrap();
        assert_eq!(st.prefix, "app/");
        assert_eq!(st.total, 2);
        assert_eq!(st.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a.txt", "sub/new.txt"]);
        assert!(commit(&app, "msg", &s(&["../other/b.txt"]), None).is_err());
        commit(&app, "Change app", &s(&["a.txt", "sub/new.txt"]), None).unwrap();
        assert_eq!(head_files(r), ["app/a.txt", "app/sub/new.txt"]);
        assert_eq!(status(r).unwrap().files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["other/b.txt"]);
    }

    #[test]
    fn refuses_to_commit_while_a_merge_is_unfinished_or_files_conflict() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["a.txt"]);
        write(r, "a.txt", "2\n");
        let head = git_ok(r, &["rev-parse", "HEAD"]);
        fs::write(r.join(".git/MERGE_HEAD"), &head).unwrap();
        assert_eq!(status(r).unwrap().in_progress.as_deref(), Some("merge"));
        let err = commit(r, "msg", &s(&["a.txt"]), None).unwrap_err();
        assert!(err.contains("merge"), "{err}");
        assert_eq!(git_ok(r, &["rev-parse", "HEAD"]), head);
    }

    #[test]
    fn refuses_conflicted_files() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["a.txt"]);
        git_ok(r, &["checkout", "-q", "-b", "side"]);
        write(r, "a.txt", "side\n");
        git_ok(r, &["commit", "-qam", "side"]);
        git_ok(r, &["checkout", "-q", "main"]);
        write(r, "a.txt", "main\n");
        git_ok(r, &["commit", "-qam", "main"]);
        assert!(!git_succeeds(r, &["merge", "side"]));
        // A real merge is in progress; drop the marker so only the conflict check is exercised.
        let st = status(r).unwrap();
        assert_eq!(st.files[0].kind, Kind::Conflicted);
        fs::remove_file(r.join(".git/MERGE_HEAD")).unwrap();
        let err = commit(r, "msg", &s(&["a.txt"]), None).unwrap_err();
        assert!(err.contains("conflict"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn hooks_run_and_a_failing_hook_rolls_back_branch_and_index() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["a.txt", "b.txt"]);
        write(r, "a.txt", "2\n");
        write(r, "b.txt", "2\n");
        write(r, "new.txt", "n\n");
        git_ok(r, &["add", "b.txt"]);
        let before = git_ok(r, &["rev-parse", "HEAD"]);
        install_hook(&f, "pre-commit", "echo 'lint failed: fix it' >&2\nexit 1");
        let err = commit(r, "msg", &s(&["a.txt", "new.txt"]), Some("feature/y")).unwrap_err();
        assert!(err.contains("lint failed"), "hook output must reach the caller: {err}");
        assert_eq!(git_ok(r, &["rev-parse", "HEAD"]), before);
        let st = status(r).unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert!(!git_succeeds(r, &["rev-parse", "--verify", "-q", "refs/heads/feature/y"]), "the new branch must be removed again");
        assert_eq!(
            st.files,
            vec![
                GitFile { path: "a.txt".into(), kind: Kind::Modified, staged: false },
                GitFile { path: "b.txt".into(), kind: Kind::Modified, staged: true },
                GitFile { path: "new.txt".into(), kind: Kind::Untracked, staged: false },
            ]
        );

        // A passing hook runs on the way through.
        let marker = f.base.join("hook-ran");
        install_hook(&f, "pre-commit", &format!("touch '{}'", marker.display()));
        commit(r, "ok", &s(&["a.txt"]), None).unwrap();
        assert!(marker.exists(), "pre-commit hook must run");
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_hook_on_an_unborn_branch_restores_the_branch() {
        let f = fixture();
        let r = &f.root;
        write(r, "a.txt", "1\n");
        install_hook(&f, "pre-commit", "exit 1");
        assert!(commit(r, "msg", &s(&["a.txt"]), Some("feature/z")).is_err());
        let st = status(r).unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert!(st.head.is_none());
        assert_eq!(st.files, vec![GitFile { path: "a.txt".into(), kind: Kind::Untracked, staged: false }]);
    }

    #[test]
    fn commit_args_never_bypass_hooks_signing_or_rewrite_history() {
        let args = commit_args("-n --no-verify", &s(&["a b.txt", "--amend", "-n"]));
        assert_eq!(&args[..4], ["commit", "-q", "--only", "-m"]);
        assert_eq!(args[4], "-n --no-verify", "the message is the value of -m, never a flag");
        assert_eq!(args[5], "--");
        assert_eq!(&args[6..], [":(literal)a b.txt", ":(literal)--amend", ":(literal)-n"]);
        for bad in ["--no-verify", "-n", "--no-gpg-sign", "--amend", "--allow-empty", "--force", "-f"] {
            assert!(!args[..4].iter().any(|a| a == bad), "{bad}");
        }
    }

    #[test]
    fn production_code_never_pushes_forces_or_bypasses_hooks() {
        let source = include_str!("git.rs");
        let production = source.split("#[cfg(test)]").next().unwrap();
        for forbidden in ["\"push\"", "\"--force\"", "\"--force-with-lease\"", "\"--no-verify\"", "\"--no-gpg-sign\"", "\"--amend\"", "\"reset\", \"--hard\""] {
            assert!(!production.contains(forbidden), "git.rs must not contain {forbidden}");
        }
    }

    #[test]
    fn commit_context_covers_tracked_untracked_and_recent_subjects() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["a.txt", "b.txt"]);
        write(r, "b.txt", "2\n");
        git_ok(r, &["commit", "-qam", "Second subject"]);
        write(r, "a.txt", "changed line\n");
        write(r, "n.txt", "hello new file\n");
        write(r, "b.txt", "untouched by selection\n");
        fs::write(r.join("bin.dat"), [0u8, 159, 146, 150, 0]).unwrap();
        let ctx = commit_context(r, &s(&["a.txt", "n.txt", "bin.dat"]), 24_000).unwrap();
        assert_eq!(ctx.files, ["a.txt", "bin.dat", "n.txt"]);
        assert!(ctx.diff.contains("+changed line") && ctx.diff.contains("-1"), "{}", ctx.diff);
        assert!(ctx.diff.contains("+hello new file"), "{}", ctx.diff);
        assert!(ctx.diff.contains("Binary files"), "{}", ctx.diff);
        assert!(!ctx.diff.contains("untouched by selection"));
        assert!(ctx.stat.contains("a.txt") && ctx.stat.contains("n.txt | new file"), "{}", ctx.stat);
        assert!(!ctx.truncated);
        assert_eq!(ctx.recent, ["Second subject", "init"]);
    }

    #[test]
    fn commit_context_works_before_the_first_commit() {
        let f = fixture();
        let r = &f.root;
        write(r, "a.txt", "staged new\n");
        write(r, "b.txt", "untracked new\n");
        git_ok(r, &["add", "a.txt"]);
        let ctx = commit_context(r, &s(&["a.txt", "b.txt"]), 24_000).unwrap();
        assert!(ctx.diff.contains("+staged new") && ctx.diff.contains("+untracked new"), "{}", ctx.diff);
        assert!(ctx.recent.is_empty());
    }

    #[test]
    fn commit_context_is_bounded_and_fair() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["big.lock", "small.txt"]);
        let big: String = (0..5000).map(|i| format!("line {i}\n")).collect();
        write(r, "big.lock", &big);
        write(r, "small.txt", "tiny change\n");
        let ctx = commit_context(r, &s(&["big.lock", "small.txt"]), 3_000).unwrap();
        assert!(ctx.truncated);
        assert!(ctx.diff.len() < 3_300, "{} bytes", ctx.diff.len());
        assert!(ctx.diff.contains("+tiny change"), "the small file must survive the big one");
        assert!(ctx.diff.contains("[... diff truncated ...]"));
        assert!(commit_context(r, &s(&["small.txt"]), 3_000).is_ok());
        assert!(commit_context(r, &s(&["nothing.txt"]), 3_000).is_err());
    }

    #[test]
    fn huge_diffs_are_cut_per_file_and_never_crowd_out_the_rest() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["a.txt", "small.txt"]);
        // Force text diffs: newer Git treats files above core.bigFileThreshold as binary.
        write(r, ".gitattributes", "*.txt diff\n");
        write(r, "a.txt", &"changed line\n".repeat(400_000)); // ~5 MB tracked diff
        write(r, "small.txt", "tiny change\n");
        write(r, "huge.txt", &"0123456789abcdef\n".repeat(400_000)); // ~6 MB untracked
        write(r, "new_small.txt", "tiny new file\n");
        let started = std::time::Instant::now();
        let ctx = commit_context(r, &s(&["a.txt", "small.txt", "huge.txt", "new_small.txt"]), 24_000).unwrap();
        assert!(ctx.truncated);
        assert!(ctx.diff.len() <= 24_000 + 200, "{} bytes", ctx.diff.len());
        assert!(ctx.diff.contains("+tiny change") && ctx.diff.contains("+tiny new file"), "small files must survive");
        assert!(ctx.diff.matches("[... diff truncated ...]").count() >= 1);
        assert!(started.elapsed().as_secs() < 20);
    }

    #[test]
    fn run_git_capped_stops_at_the_cap_and_reports_errors() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["a.txt"]);
        let (text, cut) = run_git_capped(r, ["log", "--format=%H"], 1_000_000, &[0]).unwrap();
        assert!(!cut && (text.trim().len() == 40 || text.trim().len() == 64));
        let (text, cut) = run_git_capped(r, ["log", "--format=%H"], 10, &[0]).unwrap();
        assert!(cut && text.len() == 10);
        assert!(run_git_capped(r, ["rev-parse", "--verify", "nonexistent-ref"], 100, &[0]).is_err());
        let (_, cut) = run_git_capped(r, ["rev-parse", "--verify", "-q", "nonexistent-ref"], 100, &[0, 1]).unwrap();
        assert!(!cut);
    }

    #[test]
    fn files_beyond_the_display_cap_can_still_be_committed() {
        let f = fixture();
        let r = &f.root;
        init_commit(r, &["a.txt"]);
        for i in 0..MAX_FILES + 5 {
            write(r, &format!("many/f{i:05}.txt"), "x\n");
        }
        let st = status(r).unwrap();
        assert_eq!((st.files.len(), st.total), (MAX_FILES, MAX_FILES + 5));
        let last = format!("many/f{:05}.txt", MAX_FILES + 4);
        assert!(!st.files.iter().any(|f| f.path == last));
        commit(r, "Add the last one", &[last.clone()], None).unwrap();
        assert_eq!(head_files(r), [last]);
    }

    #[test]
    fn budget_sections_is_max_min_fair_and_char_safe() {
        let small = "diff --git a/s b/s\n+s\n".to_string();
        let huge = format!("diff --git a/h b/h\n{}", "+héllo wörld\n".repeat(500));
        let (text, cut) = budget_sections(&[small.clone(), huge.clone()], 400);
        assert!(cut && text.starts_with(&small) && text.len() < 480 && text.contains("[... diff truncated ...]"));
        let (all, cut) = budget_sections(&[small.clone(), huge.clone()], 1_000_000);
        assert!(!cut && all == format!("{small}{huge}"));
        let (multibyte, _) = budget_sections(&["é".repeat(300)], 101);
        assert!(multibyte.len() <= 130);
    }
}
