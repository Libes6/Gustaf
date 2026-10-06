//! Reads the state of one pull request with `gh pr view` for the PR watcher (src/lib/prWatch*.ts, T9). Read-only: no
//! write command, an argument array (no shell), prompts disabled, a hard timeout and bounded output. The JSON is reduced
//! by gh's own `--jq` to what the watcher compares (state, mergeable, checks, comment and review ids and authors).
use crate::git::{blocking, canonical_root};
use crate::git_publish::{find_gh, gh_command};
use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BYTES: usize = 512 * 1024;
const FIELDS: &str = "state,mergeable,author,title,url,number,headRefName,statusCheckRollup,comments,reviews";
const JQ: &str = r#"{state, mergeable, title, url, number, head: .headRefName, author: .author.login,
  checks: [.statusCheckRollup[]? | {name: (.name // .context // ""), status: (.status // .state // ""), conclusion: (.conclusion // .state // "")}],
  comments: [.comments[]? | {id: .id, author: .author.login, at: .createdAt}],
  reviews: [.reviews[]? | {id: .id, author: .author.login, state: .state, at: .submittedAt}]}"#;

/// A PR reference gh accepts: a number, or an https://github.com/<owner>/<repo>/pull/<n> URL.
pub fn valid_pr_ref(r: &str) -> bool {
    let r = r.trim();
    if !r.is_empty() && r.len() <= 10 && r.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    let Some(rest) = r.strip_prefix("https://github.com/") else { return false };
    let parts: Vec<&str> = rest.trim_end_matches('/').split('/').collect();
    let name_ok = |s: &str| !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) && !s.starts_with('.');
    parts.len() == 4 && name_ok(parts[0]) && name_ok(parts[1]) && parts[2] == "pull" && !parts[3].is_empty() && parts[3].len() <= 10 && parts[3].chars().all(|c| c.is_ascii_digit())
}

fn view(root: &std::path::Path, pr: &str) -> Result<String, String> {
    if !valid_pr_ref(pr) {
        return Err("Not a pull request URL or number.".into());
    }
    let gh = find_gh().ok_or("GitHub CLI (gh) is not installed.")?;
    let mut cmd = gh_command(&gh, root);
    cmd.args(["pr", "view", pr.trim(), &format!("--json={FIELDS}"), &format!("--jq={JQ}")]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().ok_or("no output pipe")?;
    let mut err = child.stderr.take().ok_or("no output pipe")?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.by_ref().take(MAX_BYTES as u64 + 1).read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err.by_ref().take(16 * 1024).read_to_end(&mut buf);
        buf
    });
    let started = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("gh pr view timed out.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = reader.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).trim().to_string();
    if !status.success() {
        return Err(if stderr.is_empty() { "gh pr view failed.".into() } else { stderr });
    }
    if stdout.len() > MAX_BYTES {
        return Err("The pull request data is too large.".into());
    }
    String::from_utf8(stdout).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn gh_pr_view(root: String, pr: String) -> Result<String, String> {
    blocking(move || view(&canonical_root(&root)?, &pr)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pr_refs_are_numbers_or_github_pull_urls() {
        for ok in ["42", "https://github.com/o/r/pull/7", "https://github.com/my-org/repo.name/pull/123/"] {
            assert!(valid_pr_ref(ok), "{ok}");
        }
        for bad in ["", "-1", "--web", "https://github.com/o/r/issues/7", "https://evil.com/o/r/pull/7", "https://github.com/o/r/pull/7?x=1", "https://github.com/../r/pull/7", "12345678901"] {
            assert!(!valid_pr_ref(bad), "{bad}");
        }
    }
}
