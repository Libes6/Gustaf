//! The GitHub Releases feed is always named here. The native updater stays off
//! until a release build supplies a non-empty minisign public key, the same
//! rule as the previous Gustaf app.
//!
//! The window shows the server's web app, which has no desktop bridge, so the
//! shell checks the feed itself and asks with a native dialog.

use std::thread;
use std::time::Duration;

use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

fn configured(plugins: &std::collections::HashMap<String, serde_json::Value>) -> bool {
    let Some(config) = plugins.get("updater") else {
        return false;
    };
    let key = config.get("pubkey").and_then(|v| v.as_str()).unwrap_or("");
    let endpoints = config.get("endpoints").and_then(|v| v.as_array());
    !key.trim().is_empty()
        && endpoints.is_some_and(|xs| {
            !xs.is_empty()
                && xs.iter().all(|v| {
                    v.as_str()
                        .is_some_and(|url| url.starts_with("https://") && url.len() > 8)
                })
        })
}

/// The feed carries an AppImage for Linux; a deb or rpm install belongs to the package manager.
fn self_updating_install() -> bool {
    #[cfg(target_os = "linux")]
    if tauri::utils::platform::bundle_type() != Some(tauri::utils::config::BundleType::AppImage) {
        return false;
    }
    true
}

struct Prompt {
    title: &'static str,
    message: String,
    accept: &'static str,
    later: &'static str,
}

fn prompt(russian: bool, current: &str, available: &str) -> Prompt {
    if russian {
        Prompt {
            title: "Обновление Gustaf",
            message: format!(
                "Доступна версия Gustaf {available} (сейчас {current}).\n\nОбновить и перезапустить? Работающие агенты будут остановлены."
            ),
            accept: "Обновить и перезапустить",
            later: "Позже",
        }
    } else {
        Prompt {
            title: "Gustaf update",
            message: format!(
                "Gustaf {available} is available (you have {current}).\n\nUpdate and restart now? Running agents will be stopped."
            ),
            accept: "Update and restart",
            later: "Later",
        }
    }
}

fn accepted(app: &tauri::AppHandle, update: &Update) -> bool {
    let russian = sys_locale::get_locale().is_some_and(|locale| locale.starts_with("ru"));
    let text = prompt(russian, &update.current_version, &update.version);
    app.dialog()
        .message(text.message)
        .title(text.title)
        .buttons(MessageDialogButtons::OkCancelCustom(
            text.accept.to_owned(),
            text.later.to_owned(),
        ))
        .blocking_show()
}

fn check(app: &tauri::AppHandle) -> Option<Update> {
    let updater = app
        .updater()
        .inspect_err(|error| eprintln!("Gustaf update check could not start: {error}"))
        .ok()?;
    tauri::async_runtime::block_on(updater.check())
        .inspect_err(|error| eprintln!("Gustaf update check failed: {error}"))
        .ok()?
}

/// Returns only when the download failed; the running app is untouched until then.
fn install(app: &tauri::AppHandle, update: &Update) {
    let bytes = match tauri::async_runtime::block_on(update.download(|_, _| {}, || {})) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("Gustaf update download failed: {error}");
            return;
        }
    };
    // Past this point the window has no server, so every outcome ends in a restart.
    crate::stop_server(app);
    if let Err(error) = update.install(bytes) {
        eprintln!("Gustaf update install failed: {error}");
    }
    app.restart();
}

fn watch(app: tauri::AppHandle) {
    let mut declined: Option<String> = None;
    thread::sleep(FIRST_CHECK_DELAY);
    loop {
        if let Some(update) = check(&app) {
            if declined.as_deref() != Some(update.version.as_str()) {
                if accepted(&app, &update) {
                    install(&app, &update);
                } else {
                    // Asked again on the next launch, not every few hours.
                    declined = Some(update.version.clone());
                }
            }
        }
        thread::sleep(CHECK_INTERVAL);
    }
}

pub fn initialize(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(desktop)]
    if configured(&app.config().plugins.0) {
        app.handle()
            .plugin(tauri_plugin_updater::Builder::new().build())?;
        app.handle().plugin(tauri_plugin_process::init())?;
        app.handle().plugin(tauri_plugin_dialog::init())?;
        if self_updating_install() {
            let handle = app.handle().clone();
            thread::spawn(move || watch(handle));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::configured;

    #[test]
    fn only_a_signed_https_feed_enables_updates() {
        let mut plugins = std::collections::HashMap::new();
        assert!(!configured(&plugins));
        plugins.insert(
            "updater".into(),
            serde_json::json!({"pubkey":"", "endpoints":["https://github.com/Libes6/Gustaf/releases/latest/download/latest.json"]}),
        );
        assert!(!configured(&plugins));
        plugins.insert(
            "updater".into(),
            serde_json::json!({"pubkey":"public", "endpoints":["https://github.com/Libes6/Gustaf/releases/latest/download/latest.json"]}),
        );
        assert!(configured(&plugins));
    }
}
