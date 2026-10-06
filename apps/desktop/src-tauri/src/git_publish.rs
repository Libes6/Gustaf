//! Publishing a commit: push the current branch and open a pull request with `gh`.
//!
//! Every call is an explicit user action from the commit dialog. All commands are argument arrays (never a
//! shell), prompts are disabled (a missing credential fails with a message instead of hanging), output and run
//! time are bounded, only the current branch is pushed to an existing, validated remote, and force is never
//! used or accepted. Protected branches (`main`, `master`, `develop`, ...) need an explicit confirmation.
use crate::git::{blocking, canonical_root, current_branch, repo_command, run_git, run_git_capped, tail_chars, CommitContext, BIG_FILE};
use serde::Serialize;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const MAX_OUTPUT_CHARS: usize = 4_000;
const PUSH_TIMEOUT: Duration = Duration::from_secs(120);
const GH_AUTH_TIMEOUT: Duration = Duration::from_secs(8);
const GH_PR_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_REMOTES: usize = 20;
const MAX_REMOTE_BRANCHES: usize = 300;
const MAX_TITLE_CHARS: usize = 256;
const MAX_BODY_CHARS: usize = 20_000;
const PROTECTED: [&str; 5] = ["main", "master", "develop", "trunk", "production"];

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    /// With any `user:password@` part removed.
    pub url: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PublishInfo {
    pub repo: bool,
    pub branch: Option<String>,
    pub has_commits: bool,
    pub remotes: Vec<Remote>,
    /// `origin/main` style name of the upstream, when one is configured.
    pub upstream: Option<String>,
    /// Commits ahead of / behind the upstream (`None` without an upstream).
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    /// Remote-tracking branches as `origin/main` (no `*/HEAD`), capped.
    pub remote_branches: Vec<String>,
    /// Branch the first remote's HEAD points to (`main`), when known.
    pub default_base: Option<String>,
    pub protected: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub remote: String,
    pub branch: String,
    pub output: String,
    pub info: PublishInfo,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub installed: bool,
    pub authenticated: bool,
    /// Bounded output of `gh auth status` (or why it could not run).
    pub detail: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrResult {
    pub url: String,
}

pub fn is_protected(branch: &str) -> bool {
    PROTECTED.contains(&branch)
}

/// A remote name is usable when it is a plain git remote name that cannot be read as a flag or refspec.
pub fn valid_remote_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
        && !name.contains("..")
}

fn strip_credentials(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else { return url.to_string() };
    let (scheme, rest) = url.split_at(scheme_end + 3);
    let host_end = rest.find('/').unwrap_or(rest.len());
    match rest[..host_end].rfind('@') {
        Some(at) => format!("{scheme}{}", &rest[at + 1..]),
        None => url.to_string(),
    }
}

// ---------------------------------------------------------------------------------------------
// Bounded process runner

struct Bounded {
    success: bool,
    timed_out: bool,
    text: String,
}

fn drain<R: Read + Send + 'static>(mut reader: R, cap: usize) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let (mut keep, mut chunk) = (Vec::new(), [0u8; 4096]);
        while let Ok(n) = reader.read(&mut chunk) {
            if n == 0 {
                break;
            }
            keep.extend_from_slice(&chunk[..n]);
            // Keep the tail: the last lines of a failing command are the useful ones.
            if keep.len() > cap * 2 {
                keep.drain(..keep.len() - cap);
            }
        }
        keep
    })
}

/// Runs `cmd` with no stdin, piped and bounded output, killed after `timeout`.
fn run_bounded(mut cmd: Command, timeout: Duration) -> Result<Bounded, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let out = drain(child.stdout.take().ok_or("no output pipe")?, MAX_OUTPUT_CHARS * 4);
    let err = drain(child.stderr.take().ok_or("no output pipe")?, MAX_OUTPUT_CHARS * 4);
    let started = Instant::now();
    let (mut success, mut timed_out) = (false, false);
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                success = status.success();
                break;
            }
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                break;
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    // After a kill a grandchild (ssh) may still hold the pipes: do not wait for it forever.
    let join = |h: std::thread::JoinHandle<Vec<u8>>| -> String {
        let deadline = Instant::now() + Duration::from_millis(if timed_out { 300 } else { 5_000 });
        while !h.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        if h.is_finished() { String::from_utf8_lossy(&h.join().unwrap_or_default()).into_owned() } else { String::new() }
    };
    let (stderr, stdout) = (join(err), join(out));
    let parts: Vec<&str> = [stderr.trim(), stdout.trim()].into_iter().filter(|s| !s.is_empty()).collect();
    Ok(Bounded { success, timed_out, text: tail_chars(&parts.join("\n"), MAX_OUTPUT_CHARS) })
}

// ---------------------------------------------------------------------------------------------
// Info

pub fn publish_info(root: &Path) -> Result<PublishInfo, String> {
    let inside = run_git(root, ["rev-parse", "--is-inside-work-tree"]).map(|s| s.trim() == "true").unwrap_or(false);
    if !inside {
        return Ok(PublishInfo { repo: false, branch: None, has_commits: false, remotes: vec![], upstream: None, ahead: None, behind: None, remote_branches: vec![], default_base: None, protected: false });
    }
    let branch = current_branch(root);
    let has_commits = run_git(root, ["rev-parse", "--verify", "-q", "HEAD"]).is_ok();
    let names = run_git(root, ["remote"]).unwrap_or_default();
    let mut remotes = Vec::new();
    for name in names.lines().map(str::trim).filter(|n| valid_remote_name(n)).take(MAX_REMOTES) {
        if let Ok(url) = run_git(root, ["remote", "get-url", "--", name]) {
            remotes.push(Remote { name: name.to_string(), url: strip_credentials(url.trim()) });
        }
    }
    let upstream = branch.as_ref().and_then(|_| run_git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).ok()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let (mut ahead, mut behind) = (None, None);
    if upstream.is_some() && has_commits {
        if let Ok(out) = run_git(root, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]) {
            let mut it = out.split_whitespace().filter_map(|n| n.parse::<u32>().ok());
            behind = it.next();
            ahead = it.next();
        }
    }
    let remote_branches: Vec<String> = run_git(root, ["branch", "-r", "--format=%(refname:short)"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.ends_with("/HEAD") && l.contains('/'))
        .take(MAX_REMOTE_BRANCHES)
        .map(String::from)
        .collect();
    let default_base = remotes.first().and_then(|r| {
        let out = run_git(root, ["symbolic-ref", "-q", &format!("refs/remotes/{}/HEAD", r.name)]).ok()?;
        out.trim().strip_prefix(&format!("refs/remotes/{}/", r.name)).map(String::from)
    });
    let protected = branch.as_deref().is_some_and(is_protected);
    Ok(PublishInfo { repo: true, branch, has_commits, remotes, upstream, ahead, behind, remote_branches, default_base, protected })
}

// ---------------------------------------------------------------------------------------------
// Push

fn push_hint(text: &str) -> &'static str {
    let low = text.to_lowercase();
    if low.contains("terminal prompts disabled") || low.contains("could not read username") || low.contains("could not read password") || low.contains("authentication failed") || low.contains("permission denied (publickey") {
        "\nGustaf cannot ask for credentials. Set up a credential helper or an SSH key, or run the push once in a terminal."
    } else if low.contains("non-fast-forward") || low.contains("fetch first") || low.contains("[rejected]") {
        "\nThe remote has commits you do not have. Pull or rebase in a terminal first; Gustaf never force-pushes."
    } else {
        ""
    }
}

pub fn push(root: &Path, remote: &str, branch: &str, set_upstream: bool, confirm_protected: bool) -> Result<PushResult, String> {
    if remote.starts_with('+') || branch.starts_with('+') || remote.contains("force") {
        return Err("Force pushes are not supported.".into());
    }
    if !valid_remote_name(remote) {
        return Err(format!("Invalid remote name: {remote:?}"));
    }
    let info = publish_info(root)?;
    if !info.repo {
        return Err("Not a git repository.".into());
    }
    if !info.remotes.iter().any(|r| r.name == remote) {
        return Err(format!("No remote named {remote:?} in this repository."));
    }
    let Some(current) = info.branch.clone() else { return Err("HEAD is detached: create a branch before pushing.".into()) };
    if current != branch {
        return Err(format!("Only the current branch can be pushed (current: {current}, requested: {branch})."));
    }
    if !info.has_commits {
        return Err("There are no commits to push yet.".into());
    }
    if is_protected(&current) && !confirm_protected {
        return Err(format!("{current} is a protected branch: confirm the push to it explicitly, or create a new branch first."));
    }
    let refspec = format!("refs/heads/{current}:refs/heads/{current}");
    let mut cmd = repo_command(root);
    cmd.arg("push");
    if set_upstream {
        cmd.arg("--set-upstream");
    }
    cmd.args(["--", remote, &refspec]).env("GCM_INTERACTIVE", "never").env_remove("SSH_ASKPASS").env_remove("GIT_ASKPASS");
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    let out = run_bounded(cmd, PUSH_TIMEOUT).map_err(|e| format!("git: {e}"))?;
    if out.timed_out {
        return Err(format!("git push timed out after {}s.\n{}", PUSH_TIMEOUT.as_secs(), out.text).trim().to_string());
    }
    if !out.success {
        return Err(format!("{}{}", out.text, push_hint(&out.text)));
    }
    Ok(PushResult { remote: remote.to_string(), branch: current, output: out.text, info: publish_info(root)? })
}

// ---------------------------------------------------------------------------------------------
// gh

/// `gh` from PATH plus the usual install directories (a GUI app on macOS has a minimal PATH).
pub(crate) fn find_gh() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/home/linuxbrew/.linuxbrew/bin"] {
        dirs.push(PathBuf::from(extra));
    }
    dirs.into_iter().map(|d| d.join("gh")).find(|p| p.is_file())
}

pub(crate) fn gh_command(gh: &Path, root: &Path) -> Command {
    let mut cmd = Command::new(gh);
    cmd.current_dir(root).env("GH_PROMPT_DISABLED", "1").env("GH_NO_UPDATE_NOTIFIER", "1").env("NO_COLOR", "1").env("GIT_TERMINAL_PROMPT", "0");
    cmd
}

const INSTALL_HINT: &str = "GitHub CLI (gh) is not installed. Install it from https://cli.github.com, run `gh auth login`, then try again.";

pub fn gh_auth_status(gh: Option<&Path>, root: &Path, timeout: Duration) -> GhStatus {
    let Some(gh) = gh else { return GhStatus { installed: false, authenticated: false, detail: INSTALL_HINT.into() } };
    let mut cmd = gh_command(gh, root);
    cmd.args(["auth", "status"]);
    match run_bounded(cmd, timeout) {
        Ok(out) if out.timed_out => GhStatus { installed: true, authenticated: false, detail: "gh auth status timed out.".into() },
        Ok(out) => GhStatus { installed: true, authenticated: out.success, detail: out.text },
        Err(e) => GhStatus { installed: false, authenticated: false, detail: format!("{INSTALL_HINT}\n({e})") },
    }
}

fn valid_ref_name(root: &Path, name: &str) -> bool {
    !name.is_empty() && name.len() <= 200 && !name.starts_with('-') && !name.starts_with('+') && run_git(root, ["check-ref-format", &format!("refs/heads/{name}")]).is_ok()
}

/// The pull request URL found in `gh pr create` output: the last line that is an `https://` URL.
pub fn pr_url(output: &str) -> Option<String> {
    output.lines().rev().map(str::trim).find(|l| l.starts_with("https://") && !l.contains(char::is_whitespace)).map(String::from)
}

pub fn create_pr(gh: Option<&Path>, root: &Path, title: &str, body: &str, base: &str, draft: bool) -> Result<PrResult, String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS || title.contains('\n') {
        return Err("The pull request title must be one line of 1-256 characters.".into());
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err("The pull request description is too long.".into());
    }
    let info = publish_info(root)?;
    let Some(head) = info.branch.clone() else { return Err("HEAD is detached: create a branch first.".into()) };
    let base = base.trim();
    if !valid_ref_name(root, base) {
        return Err(format!("Invalid base branch: {base:?}"));
    }
    if base == head {
        return Err("The base branch must differ from the current branch: create a branch for the pull request first.".into());
    }
    let manual = format!("gh pr create --base {base} --head {head}{}", if draft { " --draft" } else { "" });
    let Some(gh) = gh else { return Err(format!("{INSTALL_HINT}\nOr run: {manual}")) };
    let auth = gh_auth_status(Some(gh), root, GH_AUTH_TIMEOUT);
    if !auth.authenticated {
        return Err(format!("GitHub CLI is not signed in. Run `gh auth login` in a terminal, then try again.\nOr run: {manual}\n{}", auth.detail).trim().to_string());
    }
    let mut cmd = gh_command(gh, root);
    // `=` forms so a value that starts with a dash can never be read as a flag.
    cmd.args(["pr", "create", &format!("--title={title}"), &format!("--body={body}"), &format!("--base={base}"), &format!("--head={head}")]);
    if draft {
        cmd.arg("--draft");
    }
    let out = run_bounded(cmd, GH_PR_TIMEOUT).map_err(|e| format!("gh: {e}"))?;
    if out.timed_out {
        return Err("gh pr create timed out.".into());
    }
    if !out.success {
        let hint = if out.text.to_lowercase().contains("push") || out.text.to_lowercase().contains("not found on") { "\nPush the branch first." } else { "" };
        return Err(format!("{}{hint}\nOr run: {manual}", out.text));
    }
    let url = pr_url(&out.text).ok_or_else(|| format!("gh did not print a pull request URL:\n{}", out.text))?;
    Ok(PrResult { url })
}

// ---------------------------------------------------------------------------------------------
// New branch (the protected-branch guard offers this before a push)

/// Creates `name` at HEAD and switches to it. The commit stays on the branch it was made on too; nothing is
/// moved, reset or pushed, and uncommitted changes come along.
pub fn create_branch(root: &Path, name: &str) -> Result<String, String> {
    let name = name.trim();
    if !valid_ref_name(root, name) || is_protected(name) {
        return Err(format!("Invalid branch name: {name:?}"));
    }
    if run_git(root, ["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")]).is_ok() {
        return Err(format!("A branch named {name:?} already exists."));
    }
    run_git(root, ["switch", "-q", "-c", name])?;
    Ok(name.to_string())
}

// ---------------------------------------------------------------------------------------------
// Pull request context

/// What the branch adds over `base_ref` (a remote-tracking branch such as `origin/main`): changed files, diffstat,
/// a bounded diff and the subjects of the new commits. Input for the pull request description.
pub fn pr_context(root: &Path, base_ref: &str, max_bytes: usize) -> Result<CommitContext, String> {
    let known = publish_info(root)?;
    if !known.repo {
        return Err("Not a git repository.".into());
    }
    if !known.remote_branches.iter().any(|b| b == base_ref) {
        return Err(format!("Unknown base branch: {base_ref:?}"));
    }
    let full = format!("refs/remotes/{base_ref}");
    let max = max_bytes.clamp(2_000, 200_000);
    let range = format!("{full}...HEAD");
    // textconv and external diff drivers are repository-configured commands; never run them.
    let diff = |extra: &[&str]| -> Vec<String> {
        ["-c", BIG_FILE, "diff", "--no-color", "--no-ext-diff", "--no-textconv"].iter().chain(extra).map(|s| s.to_string()).chain([range.clone(), "--".to_string()]).collect()
    };
    let files: Vec<String> = run_git(root, diff(&["--name-only"]))?.lines().take(200).map(String::from).collect();
    let (stat, _) = run_git_capped(root, diff(&["--stat=100,60,40"]), 4_000, &[0])?;
    let (text, truncated) = run_git_capped(root, diff(&["--unified=2"]), max, &[0])?;
    let recent = run_git(root, ["log", "-n", "30", "--format=%s", "--no-color", "--no-show-signature", &format!("{full}..HEAD")])
        .map(|out| out.lines().map(|l| l.chars().take(200).collect::<String>()).filter(|l| !l.trim().is_empty()).collect())
        .unwrap_or_default();
    Ok(CommitContext { files, stat, diff: text, truncated, recent })
}

// ---------------------------------------------------------------------------------------------
// Commands

/// Remotes, upstream, ahead/behind, remote branches and whether the current branch is protected.
#[tauri::command]
pub async fn git_publish_info(root: String) -> Result<PublishInfo, String> {
    blocking(move || publish_info(&canonical_root(&root)?)).await
}

/// Creates a branch at HEAD and switches to it (before pushing, to keep a protected branch untouched on the remote).
#[tauri::command]
pub async fn git_create_branch(root: String, name: String) -> Result<String, String> {
    blocking(move || create_branch(&canonical_root(&root)?, &name)).await
}

/// Pushes the current branch (never force) to an existing remote.
#[tauri::command]
pub async fn git_push(root: String, remote: String, branch: String, set_upstream: bool, confirm_protected: Option<bool>) -> Result<PushResult, String> {
    blocking(move || push(&canonical_root(&root)?, &remote, &branch, set_upstream, confirm_protected.unwrap_or(false))).await
}

/// Bounded diff, diffstat and commit subjects of the current branch against a remote-tracking base branch.
#[tauri::command]
pub async fn git_pr_context(root: String, base_ref: String, max_bytes: Option<usize>) -> Result<CommitContext, String> {
    blocking(move || pr_context(&canonical_root(&root)?, &base_ref, max_bytes.unwrap_or(24_000))).await
}

/// Whether `gh` is installed and signed in (bounded by a timeout).
#[tauri::command]
pub async fn gh_status(root: String) -> Result<GhStatus, String> {
    blocking(move || Ok(gh_auth_status(find_gh().as_deref(), &canonical_root(&root)?, GH_AUTH_TIMEOUT))).await
}

/// Creates a pull request for the current branch with `gh pr create` and returns its URL.
#[tauri::command]
pub async fn git_create_pr(root: String, title: String, body: String, base: String, draft: bool) -> Result<PrResult, String> {
    blocking(move || create_pr(find_gh().as_deref(), &canonical_root(&root)?, &title, &body, &base, draft)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fx {
        _tmp: tempfile::TempDir,
        base: PathBuf,
        root: PathBuf,
        remote: PathBuf,
    }

    fn g(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// Repo on `main` with one commit and a local bare remote named `origin` (not yet pushed).
    fn fx() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let (root, remote) = (base.join("repo"), base.join("remote.git"));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&remote).unwrap();
        g(&remote, &["init", "-q", "--bare"]);
        g(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        g(&root, &["init", "-q"]);
        g(&root, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        for (k, v) in [("user.name", "T"), ("user.email", "t@e.com"), ("commit.gpgsign", "false"), ("core.hooksPath", base.join("nohooks").to_str().unwrap())] {
            g(&root, &["config", k, v]);
        }
        fs::write(root.join("a.txt"), "1\n").unwrap();
        g(&root, &["add", "."]);
        g(&root, &["commit", "-q", "-m", "init"]);
        let remote_url = reqwest::Url::from_file_path(&remote).unwrap().to_string();
        g(&root, &["remote", "add", "origin", &remote_url]);
        Fx { _tmp: tmp, base, root, remote }
    }

    #[cfg(unix)]
    fn fake_gh(f: &Fx, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = f.base.join("gh");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn remote_has(f: &Fx, branch: &str) -> bool {
        Command::new("git").current_dir(&f.remote).args(["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")]).output().unwrap().status.success()
    }

    #[test]
    fn remote_names_are_validated() {
        for ok in ["origin", "up-stream", "team/fork", "a.b"] {
            assert!(valid_remote_name(ok), "{ok}");
        }
        for bad in ["", "-f", "--force", "+origin", "a b", "a;b", "$(x)", "a..b", ".hidden", "o\nrigin", "a:b", "../x"] {
            assert!(!valid_remote_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn protected_branches_are_detected() {
        for b in ["main", "master", "develop"] {
            assert!(is_protected(b));
        }
        for b in ["gustaf/fix", "main2", "feature/main", ""] {
            assert!(!is_protected(b));
        }
    }

    #[test]
    fn credentials_are_stripped_from_urls_and_pr_urls_are_parsed() {
        assert_eq!(strip_credentials("https://user:tok@github.com/o/r.git"), "https://github.com/o/r.git");
        assert_eq!(strip_credentials("git@github.com:o/r.git"), "git@github.com:o/r.git");
        assert_eq!(strip_credentials("/local/path@x"), "/local/path@x");
        assert_eq!(pr_url("Creating pull request...\n\nhttps://github.com/o/r/pull/7\n").as_deref(), Some("https://github.com/o/r/pull/7"));
        assert_eq!(pr_url("javascript:alert(1)\nhttp://x/y"), None);
    }

    #[test]
    fn info_reports_remotes_upstream_ahead_and_behind() {
        let f = fx();
        let info = publish_info(&f.root).unwrap();
        assert!(info.repo && info.has_commits);
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.remotes.len(), 1);
        assert_eq!(info.remotes[0].name, "origin");
        assert!(info.upstream.is_none() && info.ahead.is_none() && info.protected);
        push(&f.root, "origin", "main", true, true).unwrap();
        let info = publish_info(&f.root).unwrap();
        assert_eq!(info.upstream.as_deref(), Some("origin/main"));
        assert_eq!((info.ahead, info.behind), (Some(0), Some(0)));
        assert!(info.remote_branches.contains(&"origin/main".to_string()));
        fs::write(f.root.join("a.txt"), "2\n").unwrap();
        g(&f.root, &["commit", "-q", "-am", "two"]);
        assert_eq!(publish_info(&f.root).unwrap().ahead, Some(1));
        let plain = tempfile::tempdir().unwrap();
        assert!(!publish_info(plain.path()).unwrap().repo);
    }

    #[test]
    fn pushes_the_current_branch_and_sets_the_upstream() {
        let f = fx();
        g(&f.root, &["checkout", "-q", "-b", "gustaf/feature"]);
        let res = push(&f.root, "origin", "gustaf/feature", true, false).unwrap();
        assert!(remote_has(&f, "gustaf/feature"));
        assert!(!remote_has(&f, "main"), "only the current branch is pushed");
        assert_eq!(res.info.upstream.as_deref(), Some("origin/gustaf/feature"));
        assert_eq!(res.info.ahead, Some(0));
    }

    #[test]
    fn refuses_force_bad_remotes_other_branches_and_unconfirmed_protected_pushes() {
        let f = fx();
        let err = |r: Result<PushResult, String>| r.err().unwrap();
        assert!(err(push(&f.root, "origin", "+main", false, true)).contains("Force"));
        assert!(err(push(&f.root, "+origin", "main", false, true)).contains("Force"));
        assert!(err(push(&f.root, "--force", "main", false, true)).contains("Force"));
        assert!(err(push(&f.root, "--mirror", "main", false, true)).contains("Invalid remote"));
        assert!(err(push(&f.root, "nope", "main", false, true)).contains("No remote"));
        assert!(err(push(&f.root, "origin", "other", false, true)).contains("current branch"));
        assert!(err(push(&f.root, "origin", "main", false, false)).contains("protected"));
        assert!(!remote_has(&f, "main"), "nothing was pushed by the refusals");
        g(&f.root, &["checkout", "-q", "--detach"]);
        assert!(err(push(&f.root, "origin", "main", false, true)).contains("detached"));
    }

    #[test]
    fn a_rejected_push_explains_and_never_forces() {
        let f = fx();
        push(&f.root, "origin", "main", true, true).unwrap();
        let other = f.base.join("other");
        let remote_url = reqwest::Url::from_file_path(&f.remote).unwrap().to_string();
        g(&f.base, &["clone", "-q", &remote_url, "other"]);
        for (k, v) in [("user.name", "T"), ("user.email", "t@e.com"), ("commit.gpgsign", "false")] {
            g(&other, &["config", k, v]);
        }
        fs::write(other.join("b.txt"), "x\n").unwrap();
        g(&other, &["add", "."]);
        g(&other, &["commit", "-q", "-m", "remote work"]);
        g(&other, &["push", "-q", "origin", "main"]);
        fs::write(f.root.join("a.txt"), "local\n").unwrap();
        g(&f.root, &["commit", "-q", "-am", "local work"]);
        let e = push(&f.root, "origin", "main", false, true).err().unwrap();
        assert!(e.contains("never force-pushes"), "{e}");
    }

    #[test]
    fn pr_context_covers_the_branch_against_a_known_base_only() {
        let f = fx();
        push(&f.root, "origin", "main", true, true).unwrap();
        g(&f.root, &["checkout", "-q", "-b", "gustaf/x"]);
        fs::write(f.root.join("b.txt"), "new\n").unwrap();
        g(&f.root, &["add", "."]);
        g(&f.root, &["commit", "-q", "-m", "Add b"]);
        let ctx = pr_context(&f.root, "origin/main", 24_000).unwrap();
        assert_eq!(ctx.files, ["b.txt"]);
        assert!(ctx.diff.contains("+new") && ctx.stat.contains("b.txt") && !ctx.truncated);
        assert_eq!(ctx.recent, ["Add b"]);
        for bad in ["origin/nope", "--output=x", "HEAD", "main"] {
            assert!(pr_context(&f.root, bad, 24_000).is_err(), "{bad}");
        }
    }

    #[test]
    fn creates_a_branch_for_the_commit_and_refuses_bad_or_existing_names() {
        let f = fx();
        assert_eq!(create_branch(&f.root, "gustaf/new").unwrap(), "gustaf/new");
        assert_eq!(current_branch(&f.root).as_deref(), Some("gustaf/new"));
        for bad in ["", "--orphan", "a..b", "main", "gustaf/new", "x y"] {
            assert!(create_branch(&f.root, bad).is_err(), "{bad:?}");
        }
        assert_eq!(current_branch(&f.root).as_deref(), Some("gustaf/new"));
    }

    #[test]
    fn the_source_never_uses_force_or_a_shell() {
        let source = include_str!("git_publish.rs");
        let production = source.split("#[cfg(test)]").next().unwrap();
        for forbidden in ["\"--force\"", "\"--force-with-lease\"", "\"-f\"", "\"--mirror\"", "\"--no-verify\"", "\"sh\"", "\"-c\", \""] {
            assert!(!production.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn run_bounded_times_out_and_bounds_output() {
        let mut sleep = Command::new("node");
        sleep.args(["-e", "setTimeout(() => {}, 5000)"]);
        let started = Instant::now();
        let out = run_bounded(sleep, Duration::from_millis(200)).unwrap();
        assert!(out.timed_out && !out.success && started.elapsed() < Duration::from_secs(3));
        let mut big = Command::new("node");
        big.args(["-e", "process.stdout.write('x'.repeat(2000000))"]);
        let out = run_bounded(big, Duration::from_secs(10)).unwrap();
        assert!(out.text.chars().count() <= MAX_OUTPUT_CHARS + 2);
    }

    #[test]
    fn gh_missing_is_reported_with_the_manual_command() {
        let f = fx();
        assert!(!gh_auth_status(None, &f.root, Duration::from_secs(1)).installed);
        g(&f.root, &["checkout", "-q", "-b", "gustaf/x"]);
        let e = create_pr(None, &f.root, "Title", "Body", "main", false).err().unwrap();
        assert!(e.contains("not installed") && e.contains("gh pr create --base main --head gustaf/x"), "{e}");
    }

    #[cfg(unix)]
    #[test]
    fn gh_unauthenticated_stops_before_creating_anything() {
        let f = fx();
        let log = f.base.join("calls.log");
        let gh = fake_gh(&f, &format!("echo \"$@\" >> '{}'\nif [ \"$1\" = auth ]; then echo 'You are not logged in' >&2; exit 1; fi\necho https://github.com/o/r/pull/1", log.display()));
        g(&f.root, &["checkout", "-q", "-b", "gustaf/x"]);
        assert!(!gh_auth_status(Some(&gh), &f.root, Duration::from_secs(5)).authenticated);
        let e = create_pr(Some(&gh), &f.root, "Title", "Body", "main", false).err().unwrap();
        assert!(e.contains("gh auth login") && e.contains("not logged in"), "{e}");
        assert!(!fs::read_to_string(&log).unwrap().contains("pr create"));
    }

    #[cfg(unix)]
    #[test]
    fn creates_a_pr_with_an_argument_array_and_returns_the_url() {
        let f = fx();
        let log = f.base.join("calls.log");
        let gh = fake_gh(&f, &format!("if [ \"$1\" = auth ]; then exit 0; fi\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> '{}'; done\necho 'Creating pull request for gustaf/x into main'\necho\necho https://github.com/o/r/pull/42", log.display()));
        g(&f.root, &["checkout", "-q", "-b", "gustaf/x"]);
        let res = create_pr(Some(&gh), &f.root, "-Fix $(rm -rf) things", "line1\n`x`; rm -rf /", "main", true).unwrap();
        assert_eq!(res.url, "https://github.com/o/r/pull/42");
        let args: Vec<String> = fs::read_to_string(&log).unwrap().lines().map(String::from).collect();
        assert_eq!(args[..2], ["pr", "create"]);
        assert!(args.contains(&"--title=-Fix $(rm -rf) things".to_string()));
        assert!(args.contains(&"--base=main".to_string()) && args.contains(&"--head=gustaf/x".to_string()) && args.contains(&"--draft".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn a_failing_gh_reports_its_output_and_bad_inputs_are_refused() {
        let f = fx();
        let gh = fake_gh(&f, "if [ \"$1\" = auth ]; then exit 0; fi\necho 'GraphQL: No commits between main and gustaf/x' >&2\nexit 1");
        g(&f.root, &["checkout", "-q", "-b", "gustaf/x"]);
        let e = create_pr(Some(&gh), &f.root, "T", "B", "main", false).err().unwrap();
        assert!(e.contains("No commits between") && e.contains("gh pr create"), "{e}");
        for (title, base) in [("", "main"), ("a\nb", "main"), ("T", "--web"), ("T", "a..b"), ("T", ""), ("T", "gustaf/x")] {
            assert!(create_pr(Some(&gh), &f.root, title, "B", base, false).is_err(), "{title:?} {base:?}");
        }
    }
}
