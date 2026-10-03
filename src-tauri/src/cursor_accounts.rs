//! Isolated `cursor-agent` profiles for account rotation. Each Cursor account lives in its own
//! directory `<app data>/cursor-profiles/<name>`, handed to the CLI as `CURSOR_CONFIG_DIR`, so the
//! tokens of different accounts never mix with each other or with the shared `~/.cursor`.
//! The CLI is only ever run as an argument array (never a shell string built from input); the
//! profile path travels in the child's environment.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;

const STATUS_TIMEOUT: Duration = Duration::from_secs(15);

/// Names we generate look like `acc-m1x2y3`; anything else is refused (no separators, dots, case tricks).
pub fn validate_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && name.len() <= 40
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-');
    if ok {
        Ok(name)
    } else {
        Err("invalid profile name (lowercase letters, digits and dashes only, up to 40)".into())
    }
}

fn profiles_root(root: &Path) -> PathBuf {
    root.join("cursor-profiles")
}

pub fn profile_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    Ok(profiles_root(root).join(validate_name(name)?))
}

fn create(root: &Path, name: &str) -> Result<PathBuf, String> {
    let dir = profile_path(root, name)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// Removes the profile directory; refuses symlinks so a planted link can never redirect the delete.
fn remove(root: &Path, name: &str) -> Result<(), String> {
    let dir = profile_path(root, name)?;
    match std::fs::symlink_metadata(&dir) {
        Ok(m) if m.file_type().is_symlink() || !m.is_dir() => Err("profile path is not a plain directory".into()),
        Ok(_) => std::fs::remove_dir_all(&dir).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub logged_in: bool,
    pub email: Option<String>,
    pub message: Option<String>,
}

fn looks_like_email(s: &str) -> bool {
    let s = s.trim();
    let Some((local, domain)) = s.split_once('@') else { return false };
    !local.is_empty() && domain.contains('.') && !s.contains(char::is_whitespace) && s.len() <= 254
}

fn find_email(v: &serde_json::Value, depth: usize) -> Option<String> {
    if depth > 4 {
        return None;
    }
    match v {
        serde_json::Value::String(s) if looks_like_email(s) => Some(s.trim().to_string()),
        serde_json::Value::Object(o) => {
            // Prefer well-known keys, then any nested value.
            for k in ["email", "userEmail", "user", "account"] {
                if let Some(e) = o.get(k).and_then(|x| find_email(x, depth + 1)) {
                    return Some(e);
                }
            }
            o.values().find_map(|x| find_email(x, depth + 1))
        }
        _ => None,
    }
}

/// Reads `cursor-agent status --format json`. The unauthenticated shape was observed
/// (`isAuthenticated: false`); the authenticated one is not verified, so the email is searched tolerantly.
pub fn parse_status(stdout: &str) -> Identity {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) else {
        return Identity { logged_in: false, email: None, message: Some("unreadable status output".into()) };
    };
    let logged_in = v
        .get("isAuthenticated")
        .and_then(|b| b.as_bool())
        .unwrap_or_else(|| v.get("status").and_then(|s| s.as_str()) == Some("authenticated"));
    Identity {
        logged_in,
        email: if logged_in { find_email(&v, 0) } else { None },
        message: v.get("message").and_then(|m| m.as_str()).map(String::from),
    }
}

/// Locates the CLI through a login shell (a GUI app's PATH is minimal). The script is a constant.
fn find_cursor_agent() -> Result<PathBuf, String> {
    let out = Command::new("/bin/zsh")
        .args(["-lc", "command -v cursor-agent || { test -x \"$HOME/.local/bin/cursor-agent\" && echo \"$HOME/.local/bin/cursor-agent\"; }"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    let path = String::from_utf8_lossy(&out.stdout).lines().last().unwrap_or("").trim().to_string();
    if path.is_empty() {
        Err("Cursor CLI is unavailable.".into())
    } else {
        Ok(PathBuf::from(path))
    }
}

/// Runs `program status --format json` with the profile as config dir, killed after `timeout`.
fn run_status(program: &Path, dir: &Path, timeout: Duration) -> Result<Identity, String> {
    let mut child = Command::new(program)
        .args(["status", "--format", "json"])
        .env("CURSOR_CONFIG_DIR", dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().ok_or("failed to capture output")?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("cursor-agent status timed out".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let bytes = reader.join().unwrap_or_default();
    Ok(parse_status(&String::from_utf8_lossy(&bytes)))
}

fn app_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cursor_profile_create(app: tauri::AppHandle, name: String) -> Result<String, String> {
    Ok(create(&app_root(&app)?, &name)?.to_string_lossy().into_owned())
}

/// Path of a profile (for `CURSOR_CONFIG_DIR`); does not create it.
#[tauri::command]
pub fn cursor_profile_dir(app: tauri::AppHandle, name: String) -> Result<String, String> {
    Ok(profile_path(&app_root(&app)?, &name)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn cursor_profile_remove(app: tauri::AppHandle, name: String) -> Result<(), String> {
    remove(&app_root(&app)?, &name)
}

/// Login state and email of one profile. Runs on a worker thread; never starts a login.
#[tauri::command]
pub async fn cursor_profile_status(app: tauri::AppHandle, name: String) -> Result<Identity, String> {
    let dir = profile_path(&app_root(&app)?, &name)?;
    if !dir.is_dir() {
        return Ok(Identity { logged_in: false, email: None, message: Some("profile does not exist".into()) });
    }
    tauri::async_runtime::spawn_blocking(move || run_status(&find_cursor_agent()?, &dir, STATUS_TIMEOUT))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_strict() {
        for ok in ["acc-m1x2", "a", "work2"] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", "..", "a/b", "a\\b", "A", "a b", "-a", "a-", "a.b", "é", &"x".repeat(41), "a\0b", "a;rm"] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn profile_paths_stay_under_the_profiles_root() {
        let root = Path::new("/data");
        assert_eq!(profile_path(root, "acc-1").unwrap(), Path::new("/data/cursor-profiles/acc-1"));
        assert!(profile_path(root, "../x").is_err());
    }

    #[test]
    fn create_and_remove_profile() {
        let root = tempfile::tempdir().unwrap();
        let dir = create(root.path(), "acc-1").unwrap();
        assert!(dir.is_dir());
        std::fs::write(dir.join("cli-config.json"), "{}").unwrap();
        remove(root.path(), "acc-1").unwrap();
        assert!(!dir.exists());
        // Removing a missing profile is fine; an invalid name is not.
        remove(root.path(), "acc-1").unwrap();
        assert!(remove(root.path(), "../etc").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn remove_refuses_a_symlinked_profile() {
        let root = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(profiles_root(root.path())).unwrap();
        std::os::unix::fs::symlink(target.path(), profile_path(root.path(), "evil").unwrap()).unwrap();
        assert!(remove(root.path(), "evil").is_err());
        assert!(target.path().exists());
    }

    #[test]
    fn parses_status_json() {
        let out = parse_status(r#"{"status":"unauthenticated","isAuthenticated":false,"hasAccessToken":false,"message":"Not logged in"}"#);
        assert_eq!(out, Identity { logged_in: false, email: None, message: Some("Not logged in".into()) });
        let ok = parse_status(r#"{"isAuthenticated":true,"user":{"email":"me@example.com"}}"#);
        assert!(ok.logged_in);
        assert_eq!(ok.email.as_deref(), Some("me@example.com"));
        let top = parse_status(r#"{"isAuthenticated":true,"email":"a@b.co"}"#);
        assert_eq!(top.email.as_deref(), Some("a@b.co"));
        assert!(!parse_status("not json").logged_in);
        // An email in an unauthenticated payload is ignored.
        assert_eq!(parse_status(r#"{"isAuthenticated":false,"email":"a@b.co"}"#).email, None);
    }

    #[cfg(unix)]
    #[test]
    fn status_runs_a_fake_cli_with_the_profile_env_and_times_out() {
        use std::os::unix::fs::PermissionsExt;
        let bin = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let fake = bin.path().join("cursor-agent");
        std::fs::write(&fake, "#!/bin/sh\nprintf '{\"isAuthenticated\":true,\"email\":\"%s\"}' \"$(basename \"$CURSOR_CONFIG_DIR\")@x.io\"\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let id = run_status(&fake, profile.path(), Duration::from_secs(5)).unwrap();
        assert!(id.logged_in);
        assert!(id.email.unwrap().ends_with("@x.io"));
        let slow = bin.path().join("slow");
        std::fs::write(&slow, "#!/bin/sh\nsleep 5\n").unwrap();
        std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(run_status(&slow, profile.path(), Duration::from_millis(200)).is_err());
    }
}
