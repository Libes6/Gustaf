//! The GitHub Releases feed is always named here. The native updater stays off
//! until a release build supplies a non-empty minisign public key, the same
//! rule as the previous Gustaf app.
//!
//! The web app already shows app updates in its sidebar button and in Settings.
//! It was written against Electron's bridge, so the shell keeps the same state
//! and answers the same calls (`window.gustafShell.updater` in `bridge.rs`).
//! The shell only looks for a release by itself; downloading and installing
//! wait for the user.

use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);
/// Applies to the check only; a download of a large release may take far longer.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// Lets the page receive the answer to its install call before the server goes away.
const INSTALL_DELAY: Duration = Duration::from_millis(300);
const UNAVAILABLE: &str = "Automatic updates are not available in this build.";

/// `DesktopUpdateReleaseNote` in `packages/contracts/src/ipc.ts`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseNote {
    version: String,
    items: Vec<String>,
    total_items: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    footer: Option<String>,
}

/// `DesktopUpdateState` in `packages/contracts/src/ipc.ts`; the web app reads these names.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateState {
    enabled: bool,
    status: &'static str,
    channel: &'static str,
    current_version: String,
    host_arch: &'static str,
    app_arch: &'static str,
    running_under_arm64_translation: bool,
    available_version: Option<String>,
    downloaded_version: Option<String>,
    release_notes: Vec<ReleaseNote>,
    omitted_release_count: u32,
    download_percent: Option<f64>,
    checked_at: Option<String>,
    message: Option<String>,
    error_context: Option<&'static str>,
    can_retry: bool,
}

impl UpdateState {
    fn new(current_version: String, enabled: bool) -> Self {
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            _ => "other",
        };
        Self {
            enabled,
            status: if enabled { "idle" } else { "disabled" },
            channel: "latest",
            current_version,
            host_arch: arch,
            app_arch: arch,
            running_under_arm64_translation: false,
            available_version: None,
            downloaded_version: None,
            release_notes: Vec::new(),
            omitted_release_count: 0,
            download_percent: None,
            checked_at: None,
            message: (!enabled).then(|| UNAVAILABLE.to_owned()),
            error_context: None,
            can_retry: false,
        }
    }

    fn busy(&self) -> bool {
        matches!(self.status, "checking" | "downloading")
    }

    fn fail(&mut self, context: &'static str, message: String) {
        self.status = "error";
        self.error_context = Some(context);
        self.message = Some(message);
        self.can_retry = true;
        self.download_percent = None;
    }

    fn settle(&mut self, status: &'static str) {
        self.status = status;
        self.error_context = None;
        self.message = None;
        self.can_retry = false;
        self.download_percent = None;
    }
}

pub(crate) struct Updater {
    state: Mutex<UpdateState>,
    /// The release the feed last offered.
    offered: Mutex<Option<Update>>,
    /// Its verified bytes, once the user asked for the download.
    downloaded: Mutex<Option<Vec<u8>>>,
}

#[derive(Serialize)]
pub(crate) struct CheckResult {
    checked: bool,
    state: UpdateState,
}

#[derive(Serialize)]
pub(crate) struct ActionResult {
    accepted: bool,
    completed: bool,
    state: UpdateState,
}

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

/// The feed's notes are the release's Markdown; the button lists its bullet points.
/// `scripts/release-notes.mjs` closes generated notes with `Plus N bug fixes and improvements.`
fn release_notes(version: &str, body: Option<&str>) -> Vec<ReleaseNote> {
    let mut items = Vec::new();
    let mut footer = None;
    let mut omitted = 0;
    for line in body.unwrap_or_default().lines().map(str::trim) {
        if let Some(item) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            let item = item.trim();
            if !item.is_empty() {
                items.push(item.to_owned());
            }
        } else if let Some(count) = omitted_count(line) {
            omitted = count;
            footer = Some(line.to_owned());
        }
    }
    if items.is_empty() && footer.is_none() {
        return Vec::new();
    }
    vec![ReleaseNote {
        version: version.to_owned(),
        total_items: items.len() + omitted,
        items,
        footer,
    }]
}

fn omitted_count(line: &str) -> Option<usize> {
    let rest = line.strip_prefix("Plus ")?;
    let (count, rest) = rest.split_once(' ')?;
    matches!(
        rest,
        "bug fix and improvements." | "bug fixes and improvements."
    )
    .then(|| count.parse().ok())
    .flatten()
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Changes the state and tells the page, which has no other way to hear from the shell.
fn publish(app: &tauri::AppHandle, change: impl FnOnce(&mut UpdateState)) -> UpdateState {
    let state = {
        let updater = app.state::<Updater>();
        let mut state = locked(&updater.state);
        change(&mut state);
        state.clone()
    };
    if let (Some(window), Ok(json)) = (app.get_webview("main"), serde_json::to_string(&state)) {
        let _ = window.eval(format!("window.__gustafUpdateState?.({json})"));
    }
    state
}

fn current(app: &tauri::AppHandle) -> UpdateState {
    locked(&app.state::<Updater>().state).clone()
}

/// A hung request must not leave the state on `checking`, which refuses every later check.
async fn within<T, E: std::fmt::Display>(
    limit: Duration,
    request: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, String> {
    match tokio::time::timeout(limit, request).await {
        Ok(result) => result.map_err(|error| error.to_string()),
        Err(_) => Err("The update server did not answer in time.".to_owned()),
    }
}

/// `checkedAt` is an ISO 8601 UTC string, as the page parses it with `new Date`.
fn iso_timestamp(at: SystemTime) -> String {
    let seconds = at
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let shifted = days as i64 + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

/// False when there was nothing to ask: updates are off, or a check or download is running.
async fn check(app: &tauri::AppHandle) -> bool {
    let mut begun = false;
    let mut waiting_to_install = false;
    publish(app, |state| {
        if !state.enabled || state.busy() {
            return;
        }
        // A downloaded release stays the one to install until the restart.
        if state.downloaded_version.is_some() {
            waiting_to_install = true;
            return;
        }
        state.settle("checking");
        begun = true;
    });
    if waiting_to_install {
        return true;
    }
    if !begun {
        return false;
    }

    let found = match app.updater() {
        Ok(updater) => within(CHECK_TIMEOUT, async { updater.check().await }).await,
        Err(error) => Err(error.to_string()),
    };
    let updater = app.state::<Updater>();
    let checked_at = iso_timestamp(SystemTime::now());
    match found {
        Ok(Some(update)) => {
            let notes = release_notes(&update.version, update.body.as_deref());
            let version = update.version.clone();
            *locked(&updater.offered) = Some(update);
            publish(app, |state| {
                state.settle("available");
                state.checked_at = Some(checked_at);
                state.available_version = Some(version);
                state.release_notes = notes;
            });
        }
        Ok(None) => {
            *locked(&updater.offered) = None;
            publish(app, |state| {
                state.settle("up-to-date");
                state.checked_at = Some(checked_at);
                state.available_version = None;
                state.release_notes = Vec::new();
            });
        }
        Err(error) => {
            eprintln!("Gustaf update check failed: {error}");
            // A release found earlier is still there; being offline must not hide it.
            let still_offered = locked(&updater.offered).is_some();
            publish(app, |state| {
                state.checked_at = Some(checked_at);
                if still_offered {
                    state.settle("available");
                } else {
                    state.fail("check", error);
                }
            });
        }
    }
    true
}

async fn download(app: &tauri::AppHandle) -> ActionResult {
    let updater = app.state::<Updater>();
    let offered = locked(&updater.offered).clone();
    let mut begun = false;
    let state = publish(app, |state| {
        if offered.is_none() || state.busy() {
            return;
        }
        state.settle("downloading");
        state.download_percent = Some(0.0);
        begun = true;
    });
    let Some(update) = offered.filter(|_| begun) else {
        return ActionResult {
            accepted: false,
            completed: false,
            state,
        };
    };

    let mut received: u64 = 0;
    let mut shown: u64 = 0;
    let bytes = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                let Some(total) = total.filter(|total| *total > 0) else {
                    return;
                };
                let percent = (received.saturating_mul(100) / total).min(100);
                // One message per percent, not per network chunk.
                if percent != shown {
                    shown = percent;
                    publish(app, |state| state.download_percent = Some(percent as f64));
                }
            },
            || {},
        )
        .await;
    match bytes {
        Ok(bytes) => {
            *locked(&updater.downloaded) = Some(bytes);
            let state = publish(app, |state| {
                state.settle("downloaded");
                state.downloaded_version = Some(update.version.clone());
            });
            ActionResult {
                accepted: true,
                completed: true,
                state,
            }
        }
        Err(error) => {
            eprintln!("Gustaf update download failed: {error}");
            let state = publish(app, |state| state.fail("download", error.to_string()));
            ActionResult {
                accepted: true,
                completed: false,
                state,
            }
        }
    }
}

/// Answers first, then replaces the app; the running app is untouched until the server stops.
fn install(app: &tauri::AppHandle, expected_version: Option<String>) -> ActionResult {
    let updater = app.state::<Updater>();
    let state = current(app);
    let matches_request = expected_version
        .as_deref()
        .is_none_or(|expected| state.downloaded_version.as_deref() == Some(expected));
    let ready = if matches_request {
        let update = locked(&updater.offered).clone();
        let bytes = locked(&updater.downloaded).take();
        update.zip(bytes)
    } else {
        None
    };
    let Some((update, bytes)) = ready else {
        return ActionResult {
            accepted: false,
            completed: false,
            state,
        };
    };

    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(INSTALL_DELAY);
        // Past this point the window has no server, so every outcome ends in a restart.
        crate::stop_server(&handle);
        if let Err(error) = update.install(bytes) {
            eprintln!("Gustaf update install failed: {error}");
        }
        handle.restart();
    });
    ActionResult {
        accepted: true,
        completed: false,
        state,
    }
}

#[tauri::command]
pub(crate) fn update_state(app: tauri::AppHandle) -> UpdateState {
    current(&app)
}

#[tauri::command]
pub(crate) async fn update_check(app: tauri::AppHandle) -> CheckResult {
    let checked = check(&app).await;
    CheckResult {
        checked,
        state: current(&app),
    }
}

#[tauri::command]
pub(crate) async fn update_download(app: tauri::AppHandle) -> ActionResult {
    download(&app).await
}

#[tauri::command]
pub(crate) fn update_install(
    app: tauri::AppHandle,
    expected_version: Option<String>,
) -> ActionResult {
    install(&app, expected_version)
}

fn watch(app: tauri::AppHandle) {
    thread::sleep(FIRST_CHECK_DELAY);
    loop {
        tauri::async_runtime::block_on(check(&app));
        thread::sleep(CHECK_INTERVAL);
    }
}

pub fn initialize(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let mut enabled = false;
    #[cfg(desktop)]
    if configured(&app.config().plugins.0) {
        app.handle()
            .plugin(tauri_plugin_updater::Builder::new().build())?;
        app.handle().plugin(tauri_plugin_process::init())?;
        enabled = self_updating_install();
    }
    app.manage(Updater {
        state: Mutex::new(UpdateState::new(
            app.package_info().version.to_string(),
            enabled,
        )),
        offered: Mutex::new(None),
        downloaded: Mutex::new(None),
    });
    if enabled {
        let handle = app.handle().clone();
        thread::spawn(move || watch(handle));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{configured, iso_timestamp, release_notes, within, ReleaseNote, UpdateState};
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn a_check_that_never_answers_ends_with_a_message() {
        let hung = within(
            Duration::from_millis(20),
            std::future::pending::<Result<(), String>>(),
        );
        assert_eq!(
            tauri::async_runtime::block_on(hung),
            Err("The update server did not answer in time.".to_owned())
        );
        let failed = within(Duration::from_secs(5), async { Err::<(), _>("offline") });
        assert_eq!(
            tauri::async_runtime::block_on(failed),
            Err("offline".to_owned())
        );
        let answered = within(Duration::from_secs(5), async { Ok::<_, String>(7) });
        assert_eq!(tauri::async_runtime::block_on(answered), Ok(7));
    }

    #[test]
    fn last_checked_is_an_iso_utc_timestamp() {
        for (seconds, text) in [
            (0, "1970-01-01T00:00:00Z"),
            (951_782_400 + 86_399, "2000-02-29T23:59:59Z"),
            (1_795_000_000, "2026-11-18T11:06:40Z"),
        ] {
            assert_eq!(
                iso_timestamp(UNIX_EPOCH + Duration::from_secs(seconds)),
                text
            );
        }
    }

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

    #[test]
    fn the_page_gets_the_state_under_the_names_it_reads() {
        let mut state = UpdateState::new("0.8.3".into(), true);
        state.fail("download", "offline".into());
        state.available_version = Some("0.8.4".into());
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "enabled": true,
                "status": "error",
                "channel": "latest",
                "currentVersion": "0.8.3",
                "hostArch": json["hostArch"],
                "appArch": json["appArch"],
                "runningUnderArm64Translation": false,
                "availableVersion": "0.8.4",
                "downloadedVersion": null,
                "releaseNotes": [],
                "omittedReleaseCount": 0,
                "downloadPercent": null,
                "checkedAt": null,
                "message": "offline",
                "errorContext": "download",
                "canRetry": true,
            })
        );

        let off = UpdateState::new("0.8.3".into(), false);
        assert_eq!(off.status, "disabled");
        assert!(off.message.is_some());
    }

    #[test]
    fn release_notes_are_the_bullets_of_the_release_text() {
        let body =
            "## What's new\n\n- Update button in the sidebar\n  * Nested point\n-\nPlain line\n";
        assert_eq!(
            release_notes("0.8.4", Some(body)),
            vec![ReleaseNote {
                version: "0.8.4".into(),
                items: vec!["Update button in the sidebar".into(), "Nested point".into()],
                total_items: 2,
                footer: None,
            }]
        );
        assert!(release_notes("0.8.4", Some("Bug fixes.")).is_empty());
        assert!(release_notes("0.8.4", None).is_empty());
    }

    #[test]
    fn release_notes_count_the_fixes_of_the_closing_line() {
        assert_eq!(
            release_notes(
                "0.10.0",
                Some("- Cloud API\n- Mobile client\n\nPlus 3 bug fixes and improvements.\n")
            ),
            vec![ReleaseNote {
                version: "0.10.0".into(),
                items: vec!["Cloud API".into(), "Mobile client".into()],
                total_items: 5,
                footer: Some("Plus 3 bug fixes and improvements.".into()),
            }]
        );
        assert_eq!(
            release_notes("0.10.1", Some("Plus 1 bug fix and improvements.\n")),
            vec![ReleaseNote {
                version: "0.10.1".into(),
                items: Vec::new(),
                total_items: 1,
                footer: Some("Plus 1 bug fix and improvements.".into()),
            }]
        );
        assert!(release_notes("0.10.1", Some("Plus many bug fixes and improvements.")).is_empty());
    }
}
