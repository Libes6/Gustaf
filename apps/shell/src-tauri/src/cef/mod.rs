//! Chromium (CEF) draws the server's browser tabs in the app window, and the server drives the
//! same tab over the desktop browser channel (`packages/contracts/src/desktopBrowser.ts`), so the
//! user and the agent share one page. Development only for now (`--features cef-browser`).
//!
//! The server connects to a Unix socket the shell listens on; newline-delimited
//! `DesktopBrowserEvent`s go out and `DesktopBrowserCommand`s come in. CEF is only ever touched
//! on the main thread.

mod cdp;
mod host;

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use host::{HostEvent, Rect};

static RUNNING: AtomicBool = AtomicBool::new(false);
static NEXT_NUMBER: AtomicU64 = AtomicU64::new(1);
static SERVER: OnceLock<Mutex<Option<UnixStream>>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerTab {
    pub thread_id: String,
    pub tab_id: String,
}

#[derive(Default)]
struct Tab {
    server: Option<ServerTab>,
    /// Stands in for WebKit's web contents id, which the page treats as "has a page".
    number: u64,
    attached: bool,
    shown: bool,
}

thread_local! {
    /// Shell tab ids (the page's runtime tab ids) to what the server calls them.
    static TABS: RefCell<HashMap<String, Tab>> = RefCell::default();
}

pub(crate) fn running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// The framework and helper: in the app bundle, or a directory named by `GUSTAF_CEF_MODULE`.
fn module_root() -> Option<(PathBuf, bool)> {
    if let Some(dir) = std::env::var_os("GUSTAF_CEF_MODULE") {
        let dir = PathBuf::from(dir);
        return dir.join(host::FRAMEWORK).exists().then_some((dir, true));
    }
    let frameworks = std::env::current_exe().ok()?.parent()?.parent()?.join("Frameworks");
    frameworks.join(host::FRAMEWORK).exists().then_some((frameworks, false))
}

/// Starts CEF and the channel socket. Returns the socket path for the server's environment.
pub(crate) fn start(app: &AppHandle) -> Option<PathBuf> {
    let (module_root, external) = module_root()?;
    let data_dir = app.path().app_local_data_dir().ok()?;
    let config = host::Config {
        main_bundle_path: external.then(|| module_root.clone()),
        // Chromium's sandbox only lets helpers read the app's own bundle.
        sandbox: !external,
        module_root,
        profile_root: data_dir.join("chromium"),
        log_file: data_dir.join("chromium.log"),
        // No Developer ID: a real Keychain item would ask again after every update.
        mock_keychain: true,
        keychain_service: None,
        remote_debugging_port: None,
    };
    let events_app = app.clone();
    if let Err(error) = host::start(&config, move |event| on_host_event(&events_app, event)) {
        eprintln!("[cef] did not start: {error}");
        return None;
    }
    RUNNING.store(true, Ordering::SeqCst);
    let socket = std::env::temp_dir().join(format!("gustaf-browser-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let listener = match UnixListener::bind(&socket) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[cef] channel socket failed: {error}");
            return None;
        }
    };
    let accept_app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().map_while(Result::ok) {
            serve(&accept_app, stream);
        }
    });
    eprintln!("[cef] started from {}", config_summary(&config));
    Some(socket)
}

fn config_summary(config: &host::Config) -> String {
    format!(
        "{} (sandbox {})",
        config.module_root.display(),
        config.sandbox
    )
}

/// One server connection at a time; a restarted server gets the tabs that are already attached.
fn serve(app: &AppHandle, stream: UnixStream) {
    let Ok(reader) = stream.try_clone() else {
        return;
    };
    if let Ok(mut server) = SERVER.get_or_init(Mutex::default).lock() {
        *server = Some(stream);
    }
    let replay = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = replay;
        TABS.with(|tabs| {
            for tab in tabs.borrow().values() {
                if let (Some(server), true) = (&tab.server, tab.attached) {
                    send(&event("attached", server));
                    let mut shown = event("shown", server);
                    shown["shown"] = json!(tab.shown);
                    send(&shown);
                }
            }
        });
    });
    let commands = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let Ok(command) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let app = commands.clone();
            let _ = commands.run_on_main_thread(move || on_command(&app, command));
        }
    });
}

fn event(kind: &str, server: &ServerTab) -> Value {
    json!({ "type": kind, "threadId": server.thread_id, "tabId": server.tab_id })
}

fn send(event: &Value) {
    let Some(server) = SERVER.get() else {
        return;
    };
    if let Ok(mut server) = server.lock() {
        if let Some(stream) = server.as_mut() {
            if writeln!(stream, "{event}").is_err() {
                *server = None;
            }
        }
    }
}

fn server_of(shell_tab: &str) -> Option<ServerTab> {
    TABS.with(|tabs| tabs.borrow().get(shell_tab).and_then(|tab| tab.server.clone()))
}

fn shell_tab_of(server: &ServerTab) -> Option<String> {
    TABS.with(|tabs| {
        tabs.borrow()
            .iter()
            .find(|(_, tab)| tab.server.as_ref() == Some(server))
            .map(|(id, _)| id.clone())
    })
}

fn on_host_event(app: &AppHandle, event_in: HostEvent) {
    match event_in {
        HostEvent::Attached { tab_id } => {
            TABS.with(|tabs| {
                if let Some(tab) = tabs.borrow_mut().get_mut(&tab_id) {
                    tab.attached = true;
                }
            });
            if let Some(server) = server_of(&tab_id) {
                send(&event("attached", &server));
            }
            publish(app, &tab_id);
        }
        HostEvent::Detached { tab_id } => {
            let removed = TABS.with(|tabs| tabs.borrow_mut().remove(&tab_id));
            if let Some(server) = removed.and_then(|tab| tab.server) {
                send(&event("detached", &server));
            }
        }
        HostEvent::Loaded { tab_id, .. } => publish(app, &tab_id),
        HostEvent::Cdp { tab_id, message } => {
            if let Some(server) = server_of(&tab_id) {
                let mut cdp = event("cdp", &server);
                cdp["message"] = json!(message);
                send(&cdp);
            }
        }
    }
}

/// Tells the page the tab has a page, as WebKit tabs do; the server reports the rest of its state.
fn publish(app: &AppHandle, tab_id: &str) {
    let Some((url, loading, can_go_back, can_go_forward)) = host::page_state(tab_id) else {
        return;
    };
    let number = TABS.with(|tabs| tabs.borrow().get(tab_id).map(|tab| tab.number)).unwrap_or(0);
    let state = json!({
        "tabId": tab_id,
        "number": number,
        "url": url,
        "title": "",
        "loading": loading,
        "canGoBack": can_go_back,
        "canGoForward": can_go_forward,
        "zoomFactor": host::zoom_factor(tab_id),
    });
    if let Some(page) = app.get_webview("main") {
        let _ = page.eval(format!("window.__gustafNativeBrowserState?.({state})"));
    }
}

fn on_command(app: &AppHandle, command: Value) {
    let server = |command: &Value| ServerTab {
        thread_id: command["threadId"].as_str().unwrap_or_default().to_owned(),
        tab_id: command["tabId"].as_str().unwrap_or_default().to_owned(),
    };
    match command["type"].as_str() {
        Some("cdp") => {
            if let Some(tab) = shell_tab_of(&server(&command)) {
                host::from_client(&tab, command["message"].as_str().unwrap_or_default());
            }
        }
        Some("zoom") => {
            if let (Some(tab), Some(zoom)) = (
                shell_tab_of(&server(&command)),
                command["zoomFactor"]
                    .as_f64()
                    .filter(|zoom| (0.25..=5.0).contains(zoom)),
            ) {
                host::set_zoom(&tab, zoom);
                publish(app, &tab);
            }
        }
        Some("pointer") => {
            if let Some(tab) = shell_tab_of(&server(&command)) {
                let (Some(x), Some(y)) = (command["x"].as_f64(), command["y"].as_f64()) else {
                    return;
                };
                host::point(&tab, x, y, command["phase"].as_str() == Some("click"));
            }
        }
        Some("release") => {
            if let Some(tab) = shell_tab_of(&server(&command)) {
                host::hide_pointer(&tab);
            }
        }
        // A turn that ends takes the agent's pointers off its thread's tabs.
        Some("turn") => {
            if command["active"].as_bool() == Some(false) {
                let thread = command["threadId"].as_str().unwrap_or_default();
                let tabs: Vec<String> = TABS.with(|tabs| {
                    tabs.borrow()
                        .iter()
                        .filter(|(_, tab)| {
                            tab.server.as_ref().is_some_and(|server| server.thread_id == thread)
                        })
                        .map(|(id, _)| id.clone())
                        .collect()
                });
                for tab in tabs {
                    host::hide_pointer(&tab);
                }
            }
        }
        None => {}
        Some(other) => eprintln!("[cef] unknown command {other}"),
    }
}

/// The parent of every tab view: the window's content view.
fn content_view(app: &AppHandle) -> Result<*mut std::ffi::c_void, String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let window = app.get_webview_window("main").ok_or("The app window is not open")?;
    let ns_window = window.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: the main window's NSWindow, used on the main thread.
    let view: *mut AnyObject = unsafe { msg_send![ns_window.cast::<AnyObject>(), contentView] };
    Ok(view.cast())
}

/// Runs `work` on the main thread and waits for its result.
async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (send, receive) = tauri::async_runtime::channel::<Result<T, String>>(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = send.blocking_send(work(&handle));
    })
    .map_err(|error| error.to_string())?;
    let mut receive = receive;
    receive.recv().await.unwrap_or_else(|| Err("The main thread went away".to_owned()))
}

pub(crate) async fn create(
    app: &AppHandle,
    tab_id: String,
    url: String,
    profile: String,
    server: Option<ServerTab>,
) -> Result<(), String> {
    on_main(app, move |app| {
        // Asked again by a remount: the tab keeps its page and reports its state once more.
        if host::is_open(&tab_id) {
            publish(app, &tab_id);
            return Ok(());
        }
        TABS.with(|tabs| {
            tabs.borrow_mut().insert(
                tab_id.clone(),
                Tab {
                    server,
                    number: NEXT_NUMBER.fetch_add(1, Ordering::Relaxed),
                    ..Tab::default()
                },
            )
        });
        // Hidden until the page places it.
        let created = host::open_tab(
            &tab_id,
            &url,
            &profile,
            content_view(app)?,
            Rect { x: 0.0, y: 0.0, width: 1.0, height: 1.0 },
        );
        if created.is_err() {
            TABS.with(|tabs| tabs.borrow_mut().remove(&tab_id));
        }
        created
    })
    .await
}

/// Cookies go through each profile's cookie store; a cache clear needs a live page of the
/// profile, as Chromium offers no other way to drop a profile's HTTP cache.
pub(crate) async fn clear_data(
    app: &AppHandle,
    profile: Option<String>,
    cookies: bool,
) -> Result<(), String> {
    on_main(app, move |_| {
        if cookies {
            host::clear_cookies(profile.as_deref());
        } else {
            for tab in host::tabs_of(profile.as_deref()) {
                host::call(&tab, "Network.clearBrowserCache", json!({}), |_| {});
            }
        }
        Ok(())
    })
    .await
}

pub(crate) async fn present(
    app: &AppHandle,
    tab_id: String,
    rect: Option<(f64, f64, f64, f64)>,
    corner_radius: f64,
) -> Result<(), String> {
    on_main(app, move |_| {
        let rect = rect.map(|(x, y, width, height)| Rect { x, y, width, height });
        host::present(&tab_id, rect, corner_radius);
        let shown = rect.is_some();
        let changed = TABS.with(|tabs| {
            let mut tabs = tabs.borrow_mut();
            let tab = tabs.get_mut(&tab_id)?;
            let changed = tab.shown != shown && tab.attached;
            tab.shown = shown;
            changed.then(|| tab.server.clone()).flatten()
        });
        if let Some(server) = changed {
            let mut event = event("shown", &server);
            event["shown"] = json!(shown);
            send(&event);
        }
        Ok(())
    })
    .await
}

pub(crate) async fn with_tab(
    app: &AppHandle,
    tab_id: String,
    work: impl FnOnce(&str) + Send + 'static,
) -> Result<(), String> {
    on_main(app, move |_| {
        work(&tab_id);
        Ok(())
    })
    .await
}

pub(crate) async fn close(app: &AppHandle, tab_id: String) -> Result<(), String> {
    with_tab(app, tab_id, host::close_tab).await
}

pub(crate) async fn close_all(app: &AppHandle) -> Result<(), String> {
    on_main(app, |_| {
        let ids: Vec<String> = TABS.with(|tabs| tabs.borrow().keys().cloned().collect());
        for id in ids {
            host::close_tab(&id);
        }
        Ok(())
    })
    .await
}

pub(crate) use host::{history, navigate, open_devtools, reload, set_zoom};

pub(crate) fn stop() {
    if running() {
        host::stop();
    }
}
