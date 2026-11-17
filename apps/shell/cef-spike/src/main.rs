//! Stage 0 spike. A Tauri window whose page is WKWebView, as in the shell, plus a Chromium tab
//! placed over it. Chromium comes from a module installed under the app's data directory.
//!
//! Knobs, all environment variables so runs can be scripted:
//! - `CEF_SPIKE_AUTO=1` installs the module, starts CEF and opens the tab without the buttons.
//! - `CEF_SPIKE_URL` is the tab's first page.
//! - `CEF_SPIKE_ENGINE=wk|none` opens the page in a child WKWebView, or opens nothing: the
//!   baselines for the memory and CPU comparison.
//! - `CEF_SPIKE_SANDBOX=0|1` forces Chromium's sandbox off or on. By default it is on for the
//!   module in the app bundle and off for one outside it.
//! - `CEF_SPIKE_KEYCHAIN=mock|real|service:<name>` picks where cookie encryption gets its key.
//! - `CEF_SPIKE_ADHOC_SIGN=1` re-signs the unpacked module ad hoc before loading it.
//! - `CEF_SPIKE_IGNORE_BUNDLED=1` skips the copy in the app bundle, as if the user removed it.
//! - `CEF_SPIKE_MODULE_ROOT` loads the module from that directory, wherever it is.
//! - `CEF_SPIKE_MAIN_BUNDLE=app|<path>` sets what Chromium takes for the main bundle of an
//!   external module; `app` leaves it alone. Its sandbox lets helpers read only below it.
//! - `CEF_SPIKE_DRIVER=program|arg|…` starts a driver in the server's place, on the browser pipes.
//! - `CEF_SPIKE_QUIT_AFTER_MS` quits cleanly after a while, which is when Chromium saves cookies.
//! - `CEF_SPIKE_EXIT_WITH_DRIVER=1` quits when the driver does, with its exit code.

mod cdp;
mod cef_host;
mod channel;
mod module;
mod quiet_crash;

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

use objc2::msg_send;
use objc2::runtime::AnyObject;
use objc2_foundation::NSRect;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use cef_host::{HostEvent, Rect};
use module::ModuleManifest;

const THREAD_ID: &str = "spike-thread";
const TAB_ID: &str = "tab-1";
/// The strip of the page left visible above the tab.
const TOOLBAR_HEIGHT: f64 = 72.0;

static STARTED_AT: OnceLock<Instant> = OnceLock::new();
static CEF_STARTED: AtomicBool = AtomicBool::new(false);
static CHANNEL: OnceLock<channel::Channel> = OnceLock::new();

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn log(app: &AppHandle, message: impl AsRef<str>) {
    let elapsed = STARTED_AT.get_or_init(Instant::now).elapsed().as_millis();
    let line = format!("[spike +{elapsed}ms] {}", message.as_ref());
    eprintln!("{line}");
    let _ = app.emit("spike-log", line);
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

/// The copy shipped inside the app, at the place CEF looks by default.
fn bundled_module() -> Option<PathBuf> {
    if env("CEF_SPIKE_IGNORE_BUNDLED").is_some() {
        return None;
    }
    let frameworks = std::env::current_exe().ok()?.parent()?.parent()?.join("Frameworks");
    frameworks.join(cef_host::FRAMEWORK).exists().then_some(frameworks)
}

/// Where the module is, and whether that is outside the app (a reinstall after removal).
fn module_location(app: &AppHandle) -> Result<Option<(PathBuf, bool)>, String> {
    if let Some(root) = env("CEF_SPIKE_MODULE_ROOT") {
        return Ok(Some((PathBuf::from(root), true)));
    }
    if let Some(bundled) = bundled_module() {
        return Ok(Some((bundled, false)));
    }
    let manifest = ModuleManifest::embedded();
    let data_dir = data_dir(app)?;
    Ok(manifest.installed(&data_dir).then(|| (manifest.root(&data_dir), true)))
}

#[tauri::command]
fn spike_state(app: AppHandle) -> Result<Value, String> {
    let location = module_location(&app)?;
    Ok(json!({
        "installed": location.is_some(),
        "external": location.as_ref().map(|(_, external)| *external),
        "root": location.map(|(root, _)| root),
        "started": CEF_STARTED.load(Ordering::SeqCst),
        "manifest": ModuleManifest::embedded(),
    }))
}

/// Deletes the module wherever it is. Chromium cannot be unloaded, so only before it starts.
#[tauri::command]
async fn module_remove(app: AppHandle) -> Result<(), String> {
    if CEF_STARTED.load(Ordering::SeqCst) {
        return Err("Restart the app before removing the browser module".to_owned());
    }
    let Some((root, external)) = module_location(&app)? else {
        return Ok(());
    };
    if external {
        std::fs::remove_dir_all(&root).map_err(|error| error.to_string())?;
    } else {
        for entry in std::fs::read_dir(&root).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
            if name == cef_host::FRAMEWORK || name.starts_with(cef_host::HELPER) {
                std::fs::remove_dir_all(&path).map_err(|error| error.to_string())?;
            }
        }
    }
    log(&app, format!("module removed from {}", root.display()));
    Ok(())
}

/// Async: a synchronous command runs on the main thread and would freeze the window meanwhile.
#[tauri::command]
async fn module_install(app: AppHandle) -> Result<(), String> {
    install(&app)
}

fn install(app: &AppHandle) -> Result<(), String> {
    let manifest = ModuleManifest::embedded();
    let data_dir = data_dir(app)?;
    if let Some((root, external)) = module_location(app)? {
        let place = if external { "outside the app" } else { "inside the app bundle" };
        log(app, format!("module present {place}: {}", root.display()));
        return Ok(());
    }
    log(app, format!("installing {} {} from {}", manifest.id, manifest.version, manifest.url));
    let started = Instant::now();
    let last = std::cell::Cell::new(0u64);
    let root = manifest.install(&data_dir, &|done, total| {
        if done - last.get() >= 32 << 20 || done == total {
            last.set(done);
            log(app, format!("downloaded {} of {} MiB", done >> 20, total >> 20));
        }
    })?;
    if env("CEF_SPIKE_ADHOC_SIGN").is_some() {
        module::adhoc_sign(&root)?;
        log(app, "module re-signed ad hoc");
    }
    log(
        app,
        format!("module installed at {} in {} ms", root.display(), started.elapsed().as_millis()),
    );
    Ok(())
}

#[derive(Deserialize)]
struct RectInput {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl From<RectInput> for Rect {
    fn from(rect: RectInput) -> Self {
        Rect { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
}

#[tauri::command]
async fn browser_open(app: AppHandle, url: String, rect: Option<RectInput>) -> Result<(), String> {
    let rect = rect.map(Rect::from);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = open_on_main(&handle, &url, rect) {
            log(&handle, format!("open failed: {error}"));
        }
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn browser_present(app: AppHandle, rect: Option<RectInput>) -> Result<(), String> {
    let rect = rect.map(Rect::from);
    app.run_on_main_thread(move || cef_host::present(TAB_ID, rect))
        .map_err(|error| error.to_string())
}

fn start_cef(app: &AppHandle) -> Result<(), String> {
    if CEF_STARTED.load(Ordering::SeqCst) {
        return Ok(());
    }
    let data_dir = data_dir(app)?;
    let (module_root, external) =
        module_location(app)?.ok_or("The browser module is not installed")?;
    let main_bundle_path = match env("CEF_SPIKE_MAIN_BUNDLE").as_deref() {
        Some("app") => None,
        Some(path) => Some(PathBuf::from(path)),
        None => external.then(|| module_root.clone()),
    };
    let keychain = env("CEF_SPIKE_KEYCHAIN").unwrap_or_else(|| "mock".to_owned());
    let config = cef_host::Config {
        main_bundle_path,
        module_root,
        profile_root: data_dir.join("browser-profile"),
        log_file: data_dir.join("cef.log"),
        // Chromium's sandbox lets helpers read only the app's own bundle, so a module outside
        // it runs unsandboxed (measured: with the sandbox on, no helper can load the framework).
        sandbox: match env("CEF_SPIKE_SANDBOX").as_deref() {
            Some(choice) => choice != "0",
            None => !external,
        },
        mock_keychain: keychain == "mock",
        keychain_service: keychain.strip_prefix("service:").map(str::to_owned),
        remote_debugging_port: env("CEF_SPIKE_REMOTE_DEBUGGING_PORT")
            .and_then(|port| port.parse().ok()),
    };
    let started = Instant::now();
    let handle = app.clone();
    let app_class = cef_host::start(&config, move |event| on_host_event(&handle, event))?;
    CEF_STARTED.store(true, Ordering::SeqCst);
    log(
        app,
        format!(
            "CEF started in {} ms from {} (NSApp class {app_class}, sandbox {}, keychain {keychain})",
            started.elapsed().as_millis(),
            config.module_root.display(),
            config.sandbox,
        ),
    );
    Ok(())
}

/// Today's engine for a user's tab, to weigh Chromium against: a child WKWebView.
fn open_webkit_tab(app: &AppHandle, url: &str) -> Result<(), String> {
    let window = app.get_window("main").ok_or("no main window")?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let size = size.to_logical::<f64>(scale);
    let page: tauri::Url = url.parse().map_err(|error| format!("{error}"))?;
    window
        .add_child(
            tauri::webview::WebviewBuilder::new("webkit-tab", tauri::WebviewUrl::External(page)),
            tauri::LogicalPosition::new(0.0, TOOLBAR_HEIGHT),
            tauri::LogicalSize::new(size.width, size.height - TOOLBAR_HEIGHT),
        )
        .map_err(|error| error.to_string())?;
    log(app, format!("WKWebView tab opened: {url}"));
    Ok(())
}

fn open_on_main(app: &AppHandle, url: &str, rect: Option<Rect>) -> Result<(), String> {
    start_cef(app)?;
    let window = app.get_webview_window("main").ok_or("no main window")?;
    let ns_window = window.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: the main window's NSWindow, on the main thread.
    let (content_view, bounds): (*mut AnyObject, NSRect) = unsafe {
        let view: *mut AnyObject = msg_send![ns_window.cast::<AnyObject>(), contentView];
        (view, msg_send![view, bounds])
    };
    let rect = rect.unwrap_or(Rect {
        x: 0.0,
        y: TOOLBAR_HEIGHT,
        width: bounds.size.width,
        height: bounds.size.height - TOOLBAR_HEIGHT,
    });
    cef_host::open_tab(TAB_ID, url, content_view.cast::<c_void>(), rect)?;
    log(app, format!("tab requested: {url} at {rect:?}"));
    Ok(())
}

fn tab_event(kind: &str, tab_id: &str) -> Value {
    json!({ "type": kind, "threadId": THREAD_ID, "tabId": tab_id })
}

fn on_host_event(app: &AppHandle, event: HostEvent) {
    match event {
        HostEvent::Attached { tab_id, target } => {
            log(app, format!("DevTools agent attached: {target}"));
            if let Some(view) = cef_host::describe_view(&tab_id) {
                log(app, format!("tab view: {view}"));
            }
            let _ = app.emit("spike-tab", true);
            // The round trip the control channel needs, with nothing but Rust in between.
            let handle = app.clone();
            cef_host::call(
                &tab_id,
                "Runtime.evaluate",
                json!({ "expression": "`${6 * 7} ${navigator.userAgent}`", "returnByValue": true }),
                move |result| log(&handle, format!("CDP Runtime.evaluate -> {result:?}")),
            );
            if let Some(channel) = CHANNEL.get() {
                channel.send(&tab_event("attached", &tab_id));
                let mut shown = tab_event("shown", &tab_id);
                shown["shown"] = json!(true);
                channel.send(&shown);
            }
        }
        HostEvent::Detached { tab_id } => {
            log(app, format!("tab {tab_id} detached"));
            if let Some(channel) = CHANNEL.get() {
                channel.send(&tab_event("detached", &tab_id));
            }
        }
        HostEvent::Loaded { tab_id, url, status } => {
            log(app, format!("tab {tab_id} loaded {url} (HTTP {status})"));
            // Cookies read back from an earlier run prove their encryption key was available.
            let handle = app.clone();
            cef_host::call(&tab_id, "Network.getCookies", json!({}), move |result| {
                let names: Vec<String> = result
                    .ok()
                    .and_then(|result| result["cookies"].as_array().cloned())
                    .unwrap_or_default()
                    .iter()
                    .map(|cookie| {
                        let value = cookie["value"].as_str().unwrap_or_default();
                        format!("{}({} chars)", cookie["name"].as_str().unwrap_or_default(), value.len())
                    })
                    .collect();
                log(&handle, format!("cookies for the page: {names:?}"));
            });
        }
        HostEvent::Cdp { tab_id, message } => {
            if let Some(channel) = CHANNEL.get() {
                let mut event = tab_event("cdp", &tab_id);
                event["message"] = json!(message);
                channel.send(&event);
            }
        }
    }
}

/// Commands arrive on the channel's reader thread; CEF is touched only on the main thread.
fn on_command(app: &AppHandle, command: Value) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let tab_id = command["tabId"].as_str().unwrap_or_default();
        match command["type"].as_str() {
            Some("cdp") => {
                cef_host::from_client(tab_id, command["message"].as_str().unwrap_or_default())
            }
            // The agent's pointer overlay, focus keeping and release are stage 2 work.
            Some(kind) => log(&handle, format!("command {kind}: {command}")),
            None => {}
        }
    });
}

fn start_driver(app: &AppHandle) {
    let Some(spec) = env("CEF_SPIKE_DRIVER") else {
        return;
    };
    let mut parts = spec.split('|').map(str::to_owned);
    let Some(program) = parts.next() else {
        return;
    };
    let args: Vec<String> = parts.collect();
    let handle = app.clone();
    match channel::Channel::start(&program, &args, move |command| on_command(&handle, command)) {
        Ok(channel) => {
            let _ = CHANNEL.set(channel);
            log(app, format!("driver started: {program} {args:?}"));
            let handle = app.clone();
            std::thread::spawn(move || loop {
                let status = CHANNEL
                    .get()
                    .and_then(|channel| channel.driver.lock().ok()?.try_wait().ok().flatten());
                if let Some(status) = status {
                    log(&handle, format!("driver exited: {status}"));
                    if env("CEF_SPIKE_EXIT_WITH_DRIVER").is_some() {
                        handle.exit(status.code().unwrap_or(1));
                    }
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            });
        }
        Err(error) => log(app, format!("driver failed to start: {error}")),
    }
}

fn auto(app: &AppHandle) {
    let handle = app.clone();
    // Installing blocks on the network and on `tar`; only starting CEF needs the main thread.
    std::thread::spawn(move || {
        if let Err(error) = install(&handle) {
            log(&handle, format!("install failed: {error}"));
            return;
        }
        let url = env("CEF_SPIKE_URL").unwrap_or_else(|| "https://example.com/".to_owned());
        match env("CEF_SPIKE_ENGINE").as_deref() {
            // Off the main thread: Tauri builds a web view by waiting on the main thread.
            Some("wk") => {
                if let Err(error) = open_webkit_tab(&handle, &url) {
                    log(&handle, format!("open failed: {error}"));
                }
                return;
            }
            Some("none") => return,
            _ => {}
        }
        let main = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if let Err(error) = open_on_main(&main, &url, None) {
                log(&main, format!("open failed: {error}"));
            }
        });
    });
}

fn main() {
    STARTED_AT.get_or_init(Instant::now);
    quiet_crash::install();
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            spike_state,
            module_install,
            module_remove,
            browser_open,
            browser_present
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            log(&handle, format!("data dir: {}", data_dir(&handle)?.display()));
            start_driver(&handle);
            if env("CEF_SPIKE_AUTO").is_some() {
                auto(&handle);
            }
            if let Some(after) = env("CEF_SPIKE_QUIT_AFTER_MS").and_then(|ms| ms.parse().ok()) {
                let handle = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(after));
                    handle.exit(0);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the spike failed to start");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if CEF_STARTED.load(Ordering::SeqCst) {
                cef_host::stop();
                log(app, "CEF shut down");
            }
            if let Some(channel) = CHANNEL.get() {
                if let Ok(mut driver) = channel.driver.lock() {
                    let _ = driver.kill();
                }
            }
        }
    });
}
