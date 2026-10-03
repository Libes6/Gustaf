//! Image attachments for CLI providers: the composer's base64 images are written to
//! `<app data>/attachments/<chat id>/<n>.<ext>` so a CLI agent can read them from disk.
//! Never inside the project folder; the files are removed after the reply and with the chat.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_IMAGES: usize = 8;

#[derive(Serialize, Debug)]
pub struct Saved {
    pub dir: String,
    pub files: Vec<String>,
}

/// File extension for a supported image, judged by its magic bytes (the composer labels everything png).
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

fn chat_dir(root: &Path, chat_id: u64) -> Result<PathBuf, String> {
    if chat_id == 0 {
        return Err("invalid chat id".into());
    }
    Ok(root.join("attachments").join(chat_id.to_string()))
}

/// Writes every image or none. Names are the first unused `<n>.<ext>` (created with `create_new`, so nothing is overwritten).
fn save_images(root: &Path, chat_id: u64, images: &[String]) -> Result<Saved, String> {
    if images.len() > MAX_IMAGES {
        return Err(format!("at most {MAX_IMAGES} images per message"));
    }
    let mut decoded = Vec::with_capacity(images.len());
    for b64 in images {
        // Cheap bound before decoding: base64 is 4 chars per 3 bytes.
        if b64.len() > MAX_IMAGE_BYTES / 3 * 4 + 8 {
            return Err("image is larger than 10 MB".into());
        }
        let bytes = STANDARD.decode(b64.trim()).map_err(|_| "image is not valid base64".to_string())?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err("image is larger than 10 MB".into());
        }
        let ext = sniff(&bytes).ok_or("unsupported image type (png, jpeg, gif and webp are accepted)")?;
        decoded.push((bytes, ext));
    }
    let dir = chat_dir(root, chat_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut written: Vec<PathBuf> = Vec::new();
    // Continue after the highest existing number, whatever its extension.
    let mut n = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok()?.path().file_stem()?.to_str()?.parse::<u32>().ok())
        .max()
        .map_or(1, |m| m + 1);
    for (bytes, ext) in &decoded {
        let result = loop {
            let path = dir.join(format!("{n}.{ext}"));
            n += 1;
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => break f.write_all(bytes).map(|_| path),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => break Err(e),
            }
        };
        match result {
            Ok(path) => written.push(path),
            Err(e) => {
                for p in &written {
                    let _ = std::fs::remove_file(p);
                }
                return Err(e.to_string());
            }
        }
    }
    Ok(Saved {
        dir: dir.to_string_lossy().into_owned(),
        files: written.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
    })
}

fn clear(root: &Path, chat_id: u64) -> Result<(), String> {
    let dir = chat_dir(root, chat_id)?;
    match std::fs::remove_dir_all(&dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn attachments_save(app: tauri::AppHandle, chat_id: u64, images: Vec<String>) -> Result<Saved, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    save_images(&root, chat_id, &images)
}

#[tauri::command]
pub fn attachments_clear(app: tauri::AppHandle, chat_id: u64) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    clear(&root, chat_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];
    const JPG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10];
    fn b64(b: &[u8]) -> String {
        STANDARD.encode(b)
    }

    #[test]
    fn saves_with_unique_numbered_names_under_the_app_dir() {
        let root = tempfile::tempdir().unwrap();
        let first = save_images(root.path(), 7, &[b64(PNG), b64(JPG)]).unwrap();
        assert_eq!(first.files.len(), 2);
        assert!(Path::new(&first.files[0]).ends_with(Path::new("attachments").join("7").join("1.png")));
        assert!(Path::new(&first.files[1]).ends_with(Path::new("attachments").join("7").join("2.jpg")));
        assert!(Path::new(&first.dir).starts_with(root.path()));
        // A second call never overwrites existing files.
        let second = save_images(root.path(), 7, &[b64(PNG)]).unwrap();
        assert!(Path::new(&second.files[0]).ends_with(Path::new("attachments").join("7").join("3.png")));
        assert_eq!(std::fs::read(&first.files[0]).unwrap(), PNG);
    }

    #[test]
    fn rejects_bad_input_without_leaving_files() {
        let root = tempfile::tempdir().unwrap();
        assert!(save_images(root.path(), 0, &[b64(PNG)]).is_err());
        assert!(save_images(root.path(), 1, &["!!!not base64".into()]).is_err());
        assert!(save_images(root.path(), 1, &[b64(b"just text, not an image")]).is_err());
        // One bad image in a batch stops the whole batch before anything is written.
        assert!(save_images(root.path(), 1, &[b64(PNG), b64(b"nope")]).is_err());
        assert!(!root.path().join("attachments/1").exists());
        let too_many = vec![b64(PNG); MAX_IMAGES + 1];
        assert!(save_images(root.path(), 1, &too_many).is_err());
    }

    #[test]
    fn rejects_oversized_images() {
        let root = tempfile::tempdir().unwrap();
        let mut big = PNG.to_vec();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(save_images(root.path(), 1, &[b64(&big)]).is_err());
        big.truncate(MAX_IMAGE_BYTES);
        assert!(save_images(root.path(), 1, &[b64(&big)]).is_ok());
    }

    #[test]
    fn clear_removes_only_that_chat_and_tolerates_missing() {
        let root = tempfile::tempdir().unwrap();
        save_images(root.path(), 1, &[b64(PNG)]).unwrap();
        save_images(root.path(), 2, &[b64(PNG)]).unwrap();
        clear(root.path(), 1).unwrap();
        assert!(!root.path().join("attachments/1").exists());
        assert!(root.path().join("attachments/2").exists());
        clear(root.path(), 1).unwrap();
        assert!(clear(root.path(), 0).is_err());
    }
}
