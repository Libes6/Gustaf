mod account;
mod bridge;
mod cloud_api;
mod connection_storage;
mod diagnostics;
mod ipc_scope;
mod local_env;
mod network;
mod server_process;
mod shell_settings;
mod ssh;
mod updater;

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use local_env::{build_local_environment, LocalEnvironmentState};
use server_process::Server;
use shell_settings::{ExposureMode, ShellSettings};

#[cfg(not(debug_assertions))]
fn apply_exposure_args(command: &mut Command, settings: &ShellSettings) {
    match settings.exposure_mode {
        ExposureMode::LocalOnly => {
            command.args(["--host", "127.0.0.1"]);
        }
        ExposureMode::NetworkAccessible => {
            // Bind every interface so a phone on the same Wi-Fi can pair.
            command.args(["--host", "0.0.0.0", "--lan"]);
        }
    }
    if settings.tailscale_serve_enabled {
        command.arg("--tailscale-serve");
        command.arg("--tailscale-serve-port");
        command.arg(settings.tailscale_serve_port.to_string());
    }
}

#[cfg(debug_assertions)]
fn server_command(app: &tauri::App, settings: &ShellSettings) -> tauri::Result<Command> {
    let repo = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut command = Command::new("node");
    command
        .args(["scripts/dev-runner.ts", "dev", "--no-seed"])
        .current_dir(repo);
    // Dev runner forwards unknown flags poorly; expose via env the server already reads.
    match settings.exposure_mode {
        ExposureMode::LocalOnly => {
            command.env("T3CODE_HOST", "127.0.0.1");
            command.env_remove("T3CODE_LAN");
        }
        ExposureMode::NetworkAccessible => {
            command.env("T3CODE_HOST", "0.0.0.0");
            command.env("T3CODE_LAN", "1");
        }
    }
    if settings.tailscale_serve_enabled {
        command.env("T3CODE_TAILSCALE_SERVE", "1");
        command.env(
            "T3CODE_TAILSCALE_SERVE_PORT",
            settings.tailscale_serve_port.to_string(),
        );
    }
    let _ = app;
    Ok(command)
}

#[cfg(not(debug_assertions))]
fn server_command(app: &tauri::App, settings: &ShellSettings) -> tauri::Result<Command> {
    let runtime = app.path().resource_dir()?.join("runtime");
    let executable = if cfg!(windows) { "t3.exe" } else { "t3" };
    let data_dir = app.path().app_local_data_dir()?;
    let mut command = Command::new(runtime.join(executable));
    command
        .current_dir(runtime)
        .args(["--mode", "web", "--no-browser"])
        .arg("--no-auto-bootstrap-project-from-cwd")
        .arg("--base-dir")
        .arg(data_dir)
        .env("GUSTAF_APP_VERSION", app.package_info().version.to_string())
        .env_remove("VITE_DEV_SERVER_URL");
    apply_exposure_args(&mut command, settings);
    Ok(command)
}

fn pairing_url_from_line(line: &str) -> Option<&str> {
    let rest = line.split_once("pairingUrl:")?.1.trim();
    let url = rest.trim_end_matches([',', '"', '\'']);
    url.starts_with("http://").then_some(url)
}

/// Read once: the shell takes seconds to start and the network helpers ask again.
pub(crate) fn login_shell_path() -> Option<String> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(read_login_shell_path).clone()
}

fn read_login_shell_path() -> Option<String> {
    // A Dock launch does not inherit the shell PATH, so codex, claude, and cursor disappear.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
    let mut command = Command::new(shell);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x08000000);
    let mut child = command
        .args(["-lic", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (send, receive) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut path = String::new();
        let _ = stdout.read_to_string(&mut path);
        let _ = send.send(path);
    });
    let path = match receive.recv_timeout(Duration::from_secs(4)) {
        Ok(path) => path,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let _ = child.wait();
    let path = path.trim();
    (!path.is_empty()).then(|| path.to_owned())
}

/// Lines of server output kept to tell the user why it did not start.
const LOG_TAIL_LINES: usize = 20;

fn start_server(
    app: &tauri::App,
    settings: &ShellSettings,
) -> Result<(Server, tauri::Url), String> {
    let mut command = server_command(app, settings).map_err(|error| error.to_string())?;
    if let Some(path) = login_shell_path() {
        command.env("PATH", path);
    }
    command.stdin(Stdio::null()).stdout(Stdio::piped());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x08000000);

    let mut server = Server::spawn(&mut command)
        .map_err(|error| format!("The server program could not be started: {error}"))?;
    let stdout = server.take_stdout().expect("piped server stdout");
    let log_tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
    let (send_url, receive_url) = mpsc::sync_channel(1);
    let reader_tail = Arc::clone(&log_tail);
    thread::spawn(move || {
        let mut send_url = Some(send_url);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(url) = pairing_url_from_line(&line) {
                if let Some(sender) = send_url.take() {
                    let _ = sender.send(url.to_owned());
                }
            } else {
                eprintln!("{line}");
                diagnostics::record(&line);
                if let Ok(mut tail) = reader_tail.lock() {
                    if tail.len() == LOG_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            }
        }
    });

    let describe = |problem: String| {
        let tail = log_tail
            .lock()
            .map(|tail| tail.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        if tail.is_empty() {
            problem
        } else {
            format!("{problem}\n\nLast server output:\n{tail}")
        }
    };
    let url = match receive_url.recv_timeout(Duration::from_secs(120)) {
        Ok(url) => url,
        // The reader ends when the server's output closes, which is when the server exits.
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let status = server
                .try_wait()
                .ok()
                .flatten()
                .map(|status| format!(" ({status})"))
                .unwrap_or_default();
            return Err(describe(format!(
                "The server stopped before it was ready{status}."
            )));
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err(describe(
                "The server did not become ready within two minutes.".to_owned(),
            ));
        }
    };
    let url: tauri::Url = url
        .parse()
        .map_err(|error| format!("The server reported an invalid address: {error}"))?;
    if !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) {
        return Err("The server did not report a local address.".to_owned());
    }
    Ok((server, url))
}

/// Without a window there is nothing else to show the reason in; leaving silently looked like a crash.
/// Signed in, the user can send exactly the text shown here as a problem report.
fn report_start_failure(app: &tauri::AppHandle, reason: &str) {
    eprintln!("Gustaf could not start: {reason}");
    let handle = app.clone();
    let text = format!("Gustaf could not start.\n\n{reason}");
    // The account check reads the keyring, which can block; the dialog shows from any thread.
    thread::spawn(move || {
        if !account::has_session(&handle) {
            let exit = handle.clone();
            handle
                .dialog()
                .message(text)
                .title("Gustaf")
                .kind(MessageDialogKind::Error)
                .buttons(MessageDialogButtons::OkCustom("Quit".to_owned()))
                .show(move |_| exit.exit(1));
            return;
        }
        let exit = handle.clone();
        handle
            .dialog()
            .message(format!(
                "{text}\n\nYou can send this message to the Gustaf team as a problem report."
            ))
            .title("Gustaf")
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Send report and quit".to_owned(),
                "Quit".to_owned(),
            ))
            .show(move |send| {
                if !send {
                    exit.exit(1);
                    return;
                }
                let outcome = match account::send_problem_report(&exit, &text, None) {
                    Ok(()) => "The report was sent. Thank you.".to_owned(),
                    Err(error) => format!("The report could not be sent: {error}"),
                };
                let quit = exit.clone();
                exit.dialog()
                    .message(outcome)
                    .title("Gustaf")
                    .buttons(MessageDialogButtons::OkCustom("Quit".to_owned()))
                    .show(move |_| quit.exit(1));
            });
    });
}

fn is_external_browser_url(url: &tauri::Url) -> bool {
    url.scheme() == "http" || url.scheme() == "https"
}

pub(crate) fn open_external_url(url: &tauri::Url) {
    if !is_external_browser_url(url) && !bridge::is_handoff_url(url) {
        return;
    }
    let mut command = if cfg!(target_os = "macos") {
        Command::new("open")
    } else if cfg!(target_os = "windows") {
        // Not `cmd /C start`: cmd reads `&` in a URL as the start of another command.
        let mut command = Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        command
    } else {
        let mut command = Command::new("xdg-open");
        if let Ok(app_dir) = std::env::var("APPDIR") {
            // `vars()` panics on a non-UTF-8 entry; those are left as they are.
            let vars = std::env::vars_os().filter_map(|(key, value)| {
                Some((key.into_string().ok()?, value.into_string().ok()?))
            });
            for (key, value) in appimage_env_changes(vars, &app_dir) {
                match value {
                    Some(value) => command.env(key, value),
                    None => command.env_remove(key),
                };
            }
        }
        command
    };
    command.arg(url.as_str());
    let _ = command.spawn();
}

/// The AppImage's AppRun points PATH, libraries and GTK modules into its mount; the browser
/// started from here must load the system's. Returns the variables to change: `None` removes.
fn appimage_env_changes(
    vars: impl Iterator<Item = (String, String)>,
    app_dir: &str,
) -> Vec<(String, Option<String>)> {
    let app_dir = app_dir.trim_end_matches('/');
    if app_dir.is_empty() {
        return Vec::new();
    }
    let under_app_dir = |segment: &str| {
        segment == app_dir
            || segment
                .strip_prefix(app_dir)
                .is_some_and(|rest| rest.starts_with('/'))
    };
    vars.filter_map(|(key, value)| {
        if matches!(key.as_str(), "APPIMAGE" | "APPDIR" | "ARGV0" | "OWD") {
            return Some((key, None));
        }
        if !value.contains(app_dir) {
            return None;
        }
        let segments: Vec<&str> = value.split(':').collect();
        let kept: Vec<&str> = segments
            .iter()
            .copied()
            .filter(|segment| !segment.is_empty() && !under_app_dir(segment))
            .collect();
        if kept.len() == segments.len() {
            None
        } else if kept.is_empty() {
            Some((key, None))
        } else {
            Some((key, Some(kept.join(":"))))
        }
    })
    .collect()
}

fn set_dock_icon() {
    #[cfg(target_os = "macos")]
    {
        use objc2::AnyThread;
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::NSData;

        let Some(thread) = MainThreadMarker::new() else {
            return;
        };
        let data = NSData::with_bytes(include_bytes!("../icons/icon.png"));
        let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
            return;
        };
        unsafe {
            NSApplication::sharedApplication(thread).setApplicationIconImage(Some(&image));
        }
    }
}

/// The server holds files inside the app bundle, so it has to end before an update replaces them.
pub(crate) fn stop_server(app: &tauri::AppHandle) {
    if let Some(server) = app.try_state::<Mutex<Option<Server>>>() {
        let _ = server.lock().map(|mut server| server.take());
    }
}

/// The default menu binds Cmd+W to "Close Window", which ends the app and every running agent.
/// The web app uses that shortcut to close a panel, so this menu leaves it out.
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, PredefinedMenuItem as Item, Submenu};

    let name = app.package_info().name.clone();
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                name,
                true,
                &[
                    &Item::about(app, None, None)?,
                    &Item::separator(app)?,
                    &Item::services(app, None)?,
                    &Item::separator(app)?,
                    &Item::hide(app, None)?,
                    &Item::hide_others(app, None)?,
                    &Item::show_all(app, None)?,
                    &Item::separator(app)?,
                    &Item::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &Item::undo(app, None)?,
                    &Item::redo(app, None)?,
                    &Item::separator(app)?,
                    &Item::cut(app, None)?,
                    &Item::copy(app, None)?,
                    &Item::paste(app, None)?,
                    &Item::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "View", true, &[&Item::fullscreen(app, None)?])?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[&Item::minimize(app, None)?, &Item::maximize(app, None)?],
            )?,
        ],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    builder
        // Must be the first plugin. A second launch would start a second server on the same data.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_request,
            bridge::dropped_paths,
            bridge::drag_window,
            connection_storage::read_connection_catalog,
            connection_storage::write_connection_catalog,
            bridge::reveal_window,
            bridge::window_fullscreen_state,
            bridge::set_window_theme,
            bridge::read_client_settings,
            bridge::write_client_settings,
            local_env::local_environment_bootstraps,
            local_env::local_environment_bearer_token,
            local_env::local_environment_enabled,
            local_env::set_local_environment_enabled,
            local_env::server_exposure_state,
            local_env::set_server_exposure_mode,
            local_env::set_tailscale_serve_enabled,
            local_env::advertised_endpoints,
            local_env::client_platform,
            local_env::app_branding,
            updater::update_state,
            updater::update_check,
            updater::update_download,
            updater::update_install,
            account::account_state,
            account::account_sign_in,
            account::account_cancel_sign_in,
            account::account_sign_out,
            account::account_devices,
            account::account_register_device,
            account::account_revoke_device,
            account::client_config,
            account::account_report_problem,
        ])
        .setup(|app| {
            updater::initialize(app)?;
            app.manage(ssh::SshState::default());
            app.manage(bridge::ClientSettingsFile(Mutex::new(())));
            app.manage(connection_storage::CatalogStore::default());
            app.manage(account::AccountStore::default());
            set_dock_icon();
            let settings = shell_settings::load(app.handle());
            app.manage(Mutex::new(settings.clone()));
            let (server, pairing_url) = match start_server(app, &settings) {
                Ok(started) => started,
                Err(reason) => {
                    report_start_failure(app.handle(), &reason);
                    return Ok(());
                }
            };
            let local = match build_local_environment(&pairing_url) {
                Ok(local) => local,
                Err(error) => {
                    report_start_failure(
                        app.handle(),
                        &format!("The server started, but signing in to it failed: {error}"),
                    );
                    return Ok(());
                }
            };
            let bootstraps = serde_json::json!([{
                "id": "primary",
                "label": "This computer",
                "httpBaseUrl": local.http_base_url,
                "wsBaseUrl": local.ws_base_url,
                "bootstrapToken": local.bootstrap_token,
            }]);
            let app_url = local.app_url.clone();
            let Some(port) = app_url.port() else {
                report_start_failure(
                    app.handle(),
                    "The server reported an address without a port.",
                );
                return Ok(());
            };
            if let Err(error) = app.add_capability(ipc_scope::server_capability(port)) {
                report_start_failure(
                    app.handle(),
                    &format!("The window could not be given access to the shell: {error}"),
                );
                return Ok(());
            }
            let platform = local_env::client_platform();
            app.manage(LocalEnvironmentState::new(local));
            let relay_app = app.handle().clone();
            std::thread::spawn(move || account::sync_relay_credential(&relay_app));
            account::run_heartbeat(app.handle().clone());
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(app_url));
            #[cfg(target_os = "macos")]
            let window = window
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(16.0, 20.0));
            window
                .title("Gustaf")
                .inner_size(1280.0, 800.0)
                .resizable(true)
                // Tauri's own drop handler swallows Finder drags before the page sees them.
                // The composer handles drops itself, so the web view has to receive them.
                .disable_drag_drop_handler()
                .initialization_script(bridge::init_script(
                    &app.package_info().version.to_string(),
                    &bootstraps,
                    platform,
                ))
                // Editor and mail links have no page to load; their own app opens them.
                .on_navigation(|url| {
                    if bridge::is_handoff_url(url) {
                        open_external_url(url);
                        return false;
                    }
                    true
                })
                // Without a handler the web view cancels every download.
                .on_download(|_webview, event| {
                    if let tauri::webview::DownloadEvent::Requested { destination, .. } = event {
                        *destination = bridge::free_destination(destination);
                    }
                    true
                })
                // WKWebView drops window.open. ChatGPT sign-in uses it.
                .on_new_window(|url, _features| {
                    open_external_url(&url);
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            app.manage(Mutex::new(Some(server)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Gustaf")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                ssh::stop(app);
                stop_server(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{appimage_env_changes, is_external_browser_url, pairing_url_from_line};

    #[test]
    fn links_opened_from_an_appimage_drop_its_mount_paths() {
        let app_dir = "/tmp/.mount_Gustaf1";
        let vars = [
            ("APPDIR", app_dir.to_owned()),
            ("PATH", format!("{app_dir}/usr/bin:/usr/bin")),
            ("LD_LIBRARY_PATH", format!("{app_dir}/usr/lib")),
            ("HOME", "/home/user".to_owned()),
            ("OTHER", "/tmp/.mount_Gustaf10/lib".to_owned()),
        ]
        .map(|(key, value)| (key.to_owned(), value));
        assert_eq!(
            appimage_env_changes(vars.into_iter(), &format!("{app_dir}/")),
            vec![
                ("APPDIR".to_owned(), None),
                ("PATH".to_owned(), Some("/usr/bin".to_owned())),
                ("LD_LIBRARY_PATH".to_owned(), None),
            ]
        );
    }

    #[test]
    fn reads_the_pairing_url_from_the_server_log() {
        let line = "  pairingUrl: http://localhost:7445/pair#token=abc";
        assert_eq!(
            pairing_url_from_line(line),
            Some("http://localhost:7445/pair#token=abc")
        );
        assert_eq!(pairing_url_from_line("serverPort=1 webPort=2"), None);
    }

    #[test]
    fn only_http_links_leave_the_app() {
        assert!(is_external_browser_url(
            &"https://auth.openai.com/authorize".parse().unwrap()
        ));
        assert!(!is_external_browser_url(
            &"javascript:alert(1)".parse().unwrap()
        ));
    }
}
