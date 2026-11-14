//! Persisted shell preferences that survive a restart.
//!
//! Network exposure and Tailscale Serve change how the child server is started,
//! so a toggle saves here and relaunches the app (same idea as Electron's desktop
//! settings + relaunch).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

pub(crate) const DEFAULT_TAILSCALE_SERVE_PORT: u16 = 443;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ExposureMode {
    LocalOnly,
    NetworkAccessible,
}

impl ExposureMode {
    pub(crate) fn as_bridge_str(&self) -> &'static str {
        match self {
            Self::LocalOnly => "local-only",
            Self::NetworkAccessible => "network-accessible",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "local-only" => Some(Self::LocalOnly),
            "network-accessible" => Some(Self::NetworkAccessible),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellSettings {
    pub exposure_mode: ExposureMode,
    pub tailscale_serve_enabled: bool,
    pub tailscale_serve_port: u16,
    /// Lets agents control this Mac. Off until the user agrees in a native dialog.
    #[serde(default)]
    pub computer_use_enabled: bool,
}

impl Default for ShellSettings {
    fn default() -> Self {
        Self {
            exposure_mode: ExposureMode::LocalOnly,
            tailscale_serve_enabled: false,
            tailscale_serve_port: DEFAULT_TAILSCALE_SERVE_PORT,
            computer_use_enabled: false,
        }
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("app data dir: {error}"))?;
    Ok(dir.join("shell-settings.json"))
}

pub(crate) fn load(app: &tauri::AppHandle) -> ShellSettings {
    let Ok(path) = settings_path(app) else {
        return ShellSettings::default();
    };
    read_file(&path).unwrap_or_default()
}

fn read_file(path: &Path) -> Option<ShellSettings> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub(crate) fn save(app: &tauri::AppHandle, settings: &ShellSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create settings dir: {error}"))?;
    }
    let raw = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("encode settings: {error}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|error| format!("write settings: {error}"))?;
    fs::rename(&tmp, &path).map_err(|error| format!("replace settings: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ExposureMode, ShellSettings};

    #[test]
    fn round_trips_default_settings_json() {
        let raw = serde_json::to_string(&ShellSettings::default()).unwrap();
        let parsed: ShellSettings = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.exposure_mode, ExposureMode::LocalOnly);
        assert!(!parsed.tailscale_serve_enabled);
        assert_eq!(parsed.tailscale_serve_port, 443);
        assert!(!parsed.computer_use_enabled);
    }

    #[test]
    fn settings_saved_before_computer_use_leave_it_off() {
        let parsed: ShellSettings = serde_json::from_str(
            r#"{"exposureMode":"local-only","tailscaleServeEnabled":false,"tailscaleServePort":443}"#,
        )
        .unwrap();
        assert!(!parsed.computer_use_enabled);
    }
}
