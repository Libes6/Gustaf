//! caffeinate -s holds system sleep only on AC power; the display may still sleep.
use crate::shell_settings::{self, ExposureMode, ShellSettings};
use std::{
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::Manager;

#[derive(Default)]
pub(crate) struct PowerState(Mutex<Option<Child>>);

fn should_hold(settings: &ShellSettings) -> bool {
    settings.prevent_sleep
        && (settings.exposure_mode == ExposureMode::NetworkAccessible
            || settings.tailscale_serve_enabled)
}

pub(crate) fn apply(state: &PowerState, settings: &ShellSettings) -> Result<(), String> {
    let mut child = state.0.lock().map_err(|error| error.to_string())?;
    if let Some(process) = child.as_mut() {
        if process
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            *child = None;
        }
    }
    if should_hold(settings) {
        if child.is_none() {
            *child = Some(
                Command::new("/usr/bin/caffeinate")
                    .args(["-s", "-w", &std::process::id().to_string()])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|error| error.to_string())?,
            );
        }
    } else if let Some(mut process) = child.take() {
        let _ = process.kill();
        let _ = process.wait();
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn get_prevent_sleep(app: tauri::AppHandle) -> Result<bool, String> {
    let state = app.state::<Mutex<ShellSettings>>();
    let settings = state.lock().map_err(|error| error.to_string())?;
    Ok(settings.prevent_sleep)
}

#[tauri::command]
pub(crate) fn set_prevent_sleep(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<Mutex<ShellSettings>>();
    let mut settings = state.lock().map_err(|error| error.to_string())?;
    let mut next = settings.clone();
    next.prevent_sleep = enabled;
    let power = app.state::<PowerState>();
    apply(&power, &next)?;
    if let Err(error) = shell_settings::save(&app, &next) {
        let _ = apply(&power, &settings);
        return Err(error);
    }
    *settings = next;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn holds_sleep_only_for_enabled_remote_access() {
        let mut settings = ShellSettings {
            prevent_sleep: true,
            ..ShellSettings::default()
        };
        assert!(!should_hold(&settings));
        settings.exposure_mode = ExposureMode::NetworkAccessible;
        assert!(should_hold(&settings));
        settings.prevent_sleep = false;
        assert!(!should_hold(&settings));
        settings.exposure_mode = ExposureMode::LocalOnly;
        settings.tailscale_serve_enabled = true;
        settings.prevent_sleep = true;
        assert!(should_hold(&settings));
    }
    #[test]
    fn old_preferences_keep_sleep_enabled() {
        let settings: ShellSettings = serde_json::from_str(r#"{"exposureMode":"local-only","tailscaleServeEnabled":false,"tailscaleServePort":443}"#).unwrap();
        assert!(!settings.prevent_sleep);
    }
}
