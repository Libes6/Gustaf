//! Scratch folders of chats without a project (T8): `<app data>/scratch/<name>-<chat id>`, created on first use.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Keeps `[a-z0-9-]`, folds everything else into single dashes, at most 60 characters.
fn clean(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 60 {
            break;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "chat".into()
    } else {
        out
    }
}

/// The folder of chat `chat_id` under `base`: an existing `*-<id>` folder is reused, otherwise `<name>-<id>` is created.
fn scratch_in(base: &Path, chat_id: i64, name: &str) -> Result<PathBuf, String> {
    if chat_id <= 0 {
        return Err("invalid chat id".into());
    }
    fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let suffix = format!("-{chat_id}");
    if let Ok(entries) = fs::read_dir(base) {
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.ends_with(&suffix)
                && entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
            {
                return Ok(entry.path());
            }
        }
    }
    let dir = base.join(format!("{}{suffix}", clean(name)));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn scratch_dir(app: AppHandle, chat_id: i64, name: String) -> Result<String, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("scratch");
    scratch_in(&base, chat_id, &name).map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_cleaned_and_folders_reused_per_chat() {
        assert_eq!(
            clean("2026-10-06 Fix: the Parser!!"),
            "2026-10-06-fix-the-parser"
        );
        assert_eq!(clean("../../etc"), "etc");
        assert_eq!(clean("Привет"), "chat");
        let tmp = tempfile::tempdir().unwrap();
        let a = scratch_in(tmp.path(), 7, "2026-10-06 notes").unwrap();
        assert!(a.ends_with("2026-10-06-notes-7") && a.is_dir());
        assert_eq!(
            scratch_in(tmp.path(), 7, "other name").unwrap(),
            a,
            "same chat, same folder"
        );
        assert_ne!(scratch_in(tmp.path(), 17, "x").unwrap(), a, "-17 is not -7");
        assert!(scratch_in(tmp.path(), 0, "x").is_err());
    }
}
