//! The built-in browser (Chromium) ships inside the app bundle, in `Contents/Frameworks`, where
//! its sandbox works. A user who does not want it removes it from there; installing it again
//! downloads this release's copy, checked against the release's `SHA256SUMS.txt`.
//!
//! An app update brings the files back, so a removal is remembered and repeated at startup.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::local_env::{read_settings, write_settings};

const FRAMEWORK: &str = "Chromium Embedded Framework.framework";
const HELPER: &str = "Gustaf Browser Helper.app";
const RELEASES: &str = "https://github.com/Libes6/Gustaf/releases/download";

/// The release asset with this version's Chromium; `stage-release.mjs` publishes it.
fn archive_name(version: &str) -> String {
    format!("gustaf-browser-{version}-darwin-arm64.tar.xz")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserModuleState {
    /// This build can carry the built-in browser at all.
    supported: bool,
    installed: bool,
    running: bool,
    size_bytes: u64,
}

fn frameworks_dir() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.parent()?.parent()?.join("Frameworks"))
}

fn installed_in(dir: &Path) -> bool {
    dir.join(FRAMEWORK).exists() && dir.join(HELPER).exists()
}

fn size_of(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if !meta.is_dir() {
        return meta.len();
    }
    fs::read_dir(path)
        .map(|entries| entries.flatten().map(|entry| size_of(&entry.path())).sum())
        .unwrap_or(0)
}

fn remove_files(dir: &Path) -> Result<(), String> {
    for name in [FRAMEWORK, HELPER] {
        let path = dir.join(name);
        if path.exists() {
            fs::remove_dir_all(&path).map_err(|error| {
                format!(
                    "Could not remove {} ({error}). Is the app in a folder you can write to?",
                    path.display()
                )
            })?;
        }
    }
    Ok(())
}

/// Called before Chromium starts: repeats a removal an update undid.
pub(crate) fn apply_removal(app: &tauri::AppHandle) {
    if !read_settings(app).browser_removed {
        return;
    }
    if let Some(dir) = frameworks_dir().filter(|dir| installed_in(dir)) {
        if let Err(error) = remove_files(&dir) {
            eprintln!("[browser] {error}");
        }
    }
}

fn running() -> bool {
    #[cfg(all(target_os = "macos", feature = "cef-browser"))]
    return crate::cef::running();
    #[cfg(not(all(target_os = "macos", feature = "cef-browser")))]
    false
}

#[tauri::command]
pub(crate) fn browser_module_state() -> BrowserModuleState {
    let dir = frameworks_dir();
    let installed = dir.as_deref().is_some_and(installed_in);
    BrowserModuleState {
        supported: cfg!(all(target_os = "macos", feature = "cef-browser")),
        installed,
        running: running(),
        size_bytes: dir
            .filter(|_| installed)
            .map(|dir| size_of(&dir.join(FRAMEWORK)) + size_of(&dir.join(HELPER)))
            .unwrap_or(0),
    }
}

/// Removes the browser and restarts, since Chromium's helpers start from those files.
#[tauri::command]
pub(crate) async fn browser_module_remove(app: tauri::AppHandle) -> Result<(), String> {
    let mut settings = read_settings(&app);
    settings.browser_removed = true;
    write_settings(&app, &settings)?;
    let dir = frameworks_dir().ok_or("The app bundle was not found")?;
    tauri::async_runtime::spawn_blocking(move || remove_files(&dir))
        .await
        .map_err(|error| error.to_string())??;
    app.restart();
}

#[tauri::command]
pub(crate) async fn browser_module_install(app: tauri::AppHandle) -> Result<(), String> {
    let version = app.package_info().version.to_string();
    let dir = frameworks_dir().ok_or("The app bundle was not found")?;
    tauri::async_runtime::spawn_blocking(move || install(&version, &dir))
        .await
        .map_err(|error| error.to_string())??;
    let mut settings = read_settings(&app);
    settings.browser_removed = false;
    write_settings(&app, &settings)?;
    app.restart();
}

fn install(version: &str, frameworks: &Path) -> Result<(), String> {
    let name = archive_name(version);
    let base = format!("{RELEASES}/v{version}");
    let sums = ureq::get(&format!("{base}/SHA256SUMS.txt"))
        .call()
        .map_err(|error| format!("Could not get the release checksums: {error}"))?
        .into_string()
        .map_err(|error| error.to_string())?;
    let expected = expected_sha256(&sums, &name)
        .ok_or_else(|| format!("Release v{version} lists no {name}"))?;

    let staging = frameworks.join(".browser-install");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|error| {
        format!("Could not write into the app ({error}). Is it in a folder you can write to?")
    })?;
    let archive = staging.join(&name);
    let result = (|| {
        let mut response = ureq::get(&format!("{base}/{name}"))
            .call()
            .map_err(|error| format!("Could not download the browser: {error}"))?
            .into_reader();
        let mut file = fs::File::create(&archive).map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 1 << 20];
        loop {
            let read = response.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            std::io::Write::write_all(&mut file, &buffer[..read])
                .map_err(|error| error.to_string())?;
        }
        let actual: String = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
        if actual != expected {
            return Err("The downloaded browser failed its checksum".to_owned());
        }
        let status = Command::new("/usr/bin/tar")
            .arg("-xJf")
            .arg(&archive)
            .arg("-C")
            .arg(&staging)
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() || !installed_in(&staging) {
            return Err("The downloaded browser could not be unpacked".to_owned());
        }
        remove_files(frameworks)?;
        for item in [FRAMEWORK, HELPER] {
            fs::rename(staging.join(item), frameworks.join(item))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

/// The digest `sha256sum` printed for `name`, in its `<hex>  <name>` or `<hex> *<name>` form.
fn expected_sha256(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hex, file) = line.split_once(char::is_whitespace)?;
        let file = file.trim_start().trim_start_matches('*');
        (file == name && hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| hex.to_ascii_lowercase())
    })
}

#[cfg(test)]
mod tests {
    use super::expected_sha256;

    #[test]
    fn finds_an_assets_digest_in_sha256sums() {
        let hex = "a".repeat(64);
        let sums = format!(
            "{}  gustaf-0.16.0-darwin-arm64.tar.gz\n{hex} *gustaf-browser-0.16.0-darwin-arm64.tar.xz\n",
            "b".repeat(64)
        );
        assert_eq!(
            expected_sha256(&sums, "gustaf-browser-0.16.0-darwin-arm64.tar.xz"),
            Some(hex)
        );
        assert_eq!(expected_sha256(&sums, "gustaf-browser-0.15.0-darwin-arm64.tar.xz"), None);
        assert_eq!(expected_sha256("zz  gustaf-browser.tar.xz", "gustaf-browser.tar.xz"), None);
    }
}
