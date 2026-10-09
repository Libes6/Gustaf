//! Private profile of one Antigravity provider (Google's `agy_acp_server` ACP agent). Each provider owns a directory
//! `<app data>/antigravity-profiles/<name>` with `home/` (handed to the agent as `GEMINI_HOME`, so its Google sign-in
//! lives there and never mixes with another account or with `~/.gemini`) and `tmp/` (the agent unpacks itself there on
//! every launch). The agent is only ever started by the TypeScript process host; this module just prepares and removes
//! the folders. It never reads a credential.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_SETTINGS_BYTES: usize = 4096;

fn profiles_root(root: &Path) -> PathBuf {
    root.join("antigravity-profiles")
}

fn profile_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    // Same naming rule as the Cursor profiles: lowercase letters, digits and dashes only.
    Ok(profiles_root(root).join(crate::cursor_accounts::validate_name(name)?))
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub gemini_home: String,
    pub temp_dir: String,
}

#[cfg(unix)]
fn private(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn private(_dir: &Path) -> Result<(), String> {
    Ok(())
}

/// `settings` must be a small JSON object (auth method and GCP project/location, no secrets). Rewritten on every
/// launch so an edit in the settings page takes effect.
fn prepare(root: &Path, name: &str, settings: &str) -> Result<Prepared, String> {
    if settings.len() > MAX_SETTINGS_BYTES {
        return Err("settings are too large".into());
    }
    match serde_json::from_str::<serde_json::Value>(settings) {
        Ok(v) if v.is_object() => {}
        _ => return Err("settings must be a JSON object".into()),
    }
    let dir = profile_path(root, name)?;
    let home = dir.join("home");
    let acp = home.join("antigravity-acp");
    let tmp = dir.join("tmp");
    for d in [&dir, &home, &acp, &tmp] {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        private(d)?;
    }
    std::fs::write(acp.join("settings.json"), settings).map_err(|e| e.to_string())?;
    Ok(Prepared {
        gemini_home: home.to_string_lossy().into_owned(),
        temp_dir: tmp.to_string_lossy().into_owned(),
    })
}

/// Removes the profile (the sign-in and the temp folder); refuses symlinks so a planted link can never redirect the delete.
fn remove(root: &Path, name: &str) -> Result<(), String> {
    let dir = profile_path(root, name)?;
    match std::fs::symlink_metadata(&dir) {
        Ok(m) if m.file_type().is_symlink() || !m.is_dir() => {
            Err("profile path is not a plain directory".into())
        }
        Ok(_) => std::fs::remove_dir_all(&dir).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn app_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn antigravity_profile_prepare(
    app: tauri::AppHandle,
    name: String,
    settings: String,
) -> Result<Prepared, String> {
    prepare(&app_root(&app)?, &name, &settings)
}

#[tauri::command]
pub fn antigravity_profile_remove(app: tauri::AppHandle, name: String) -> Result<(), String> {
    remove(&app_root(&app)?, &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_creates_private_folders_and_writes_settings() {
        let root = tempfile::tempdir().unwrap();
        let p = prepare(
            root.path(),
            "antigravity-abc1",
            r#"{"auth":{"type":"oauth-personal"}}"#,
        )
        .unwrap();
        assert!(p.gemini_home.ends_with("home"));
        assert!(Path::new(&p.temp_dir).is_dir());
        let written = std::fs::read_to_string(
            Path::new(&p.gemini_home).join("antigravity-acp/settings.json"),
        )
        .unwrap();
        assert!(written.contains("oauth-personal"));
        // Rewritten on the next launch.
        prepare(
            root.path(),
            "antigravity-abc1",
            r#"{"auth":{"type":"gemini-api-key"}}"#,
        )
        .unwrap();
        let again = std::fs::read_to_string(
            Path::new(&p.gemini_home).join("antigravity-acp/settings.json"),
        )
        .unwrap();
        assert!(again.contains("gemini-api-key"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&p.gemini_home)
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o700);
        }
    }

    #[test]
    fn rejects_bad_names_and_settings() {
        let root = tempfile::tempdir().unwrap();
        assert!(prepare(root.path(), "../evil", "{}").is_err());
        assert!(prepare(root.path(), "Upper", "{}").is_err());
        assert!(prepare(root.path(), "ok-name", "[1]").is_err());
        assert!(prepare(root.path(), "ok-name", "not json").is_err());
        assert!(prepare(
            root.path(),
            "ok-name",
            &format!("{{\"a\":\"{}\"}}", "x".repeat(5000))
        )
        .is_err());
    }

    #[test]
    fn remove_deletes_the_profile_and_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let p = prepare(root.path(), "antigravity-x", "{}").unwrap();
        remove(root.path(), "antigravity-x").unwrap();
        assert!(!Path::new(&p.gemini_home).exists());
        remove(root.path(), "antigravity-x").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn remove_refuses_a_symlinked_profile() {
        let root = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(profiles_root(root.path())).unwrap();
        std::os::unix::fs::symlink(target.path(), profile_path(root.path(), "evil").unwrap())
            .unwrap();
        assert!(remove(root.path(), "evil").is_err());
        assert!(target.path().exists());
    }
}
