mod bridge;
mod connection_storage;
mod local_env;
mod network;
mod shell_settings;
mod updater;

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

use local_env::{build_local_environment, LocalEnvironmentState};
use shell_settings::{ExposureMode, ShellSettings};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(None)) {
            return;
        }
        #[cfg(unix)]
        if let Ok(pid) = i32::try_from(self.0.id()) {
            unsafe { libc::kill(-pid, libc::SIGTERM) };
        }
        #[cfg(not(unix))]
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

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
        .env_remove("VITE_DEV_SERVER_URL");
    apply_exposure_args(&mut command, settings);
    Ok(command)
}

fn pairing_url_from_line(line: &str) -> Option<&str> {
    let rest = line.split_once("pairingUrl:")?.1.trim();
    let url = rest.trim_end_matches([',', '"', '\'']);
    url.starts_with("http://").then_some(url)
}

fn login_shell_path() -> Option<String> {
    // A Dock launch does not inherit the shell PATH, so codex, claude, and cursor disappear.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
    let mut child = Command::new(shell)
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

fn start_server(
    app: &tauri::App,
    settings: &ShellSettings,
) -> Result<(Server, tauri::Url), Box<dyn std::error::Error>> {
    let mut command = server_command(app, settings)?;
    if let Some(path) = login_shell_path() {
        command.env("PATH", path);
    }
    command.stdin(Stdio::null()).stdout(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x08000000);

    let mut server = Server(command.spawn()?);
    let stdout = server.0.stdout.take().expect("piped server stdout");
    let (send_url, receive_url) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut send_url = Some(send_url);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(url) = pairing_url_from_line(&line) {
                if let Some(sender) = send_url.take() {
                    let _ = sender.send(url.to_owned());
                }
            } else {
                eprintln!("{line}");
            }
        }
    });

    let url: tauri::Url = receive_url
        .recv_timeout(Duration::from_secs(120))?
        .parse()?;
    if !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) {
        return Err("Gustaf server did not report a local pairing URL".into());
    }
    Ok((server, url))
}

fn is_external_browser_url(url: &tauri::Url) -> bool {
    url.scheme() == "http" || url.scheme() == "https"
}

fn open_external_url(url: &tauri::Url) {
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
        Command::new("xdg-open")
    };
    command.arg(url.as_str());
    let _ = command.spawn();
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
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
        ])
        .setup(|app| {
            updater::initialize(app)?;
            app.manage(bridge::ClientSettingsFile(Mutex::new(())));
            app.manage(connection_storage::CatalogStore::default());
            set_dock_icon();
            let settings = shell_settings::load(app.handle());
            app.manage(Mutex::new(settings.clone()));
            let (server, pairing_url) = start_server(app, &settings)?;
            let local = build_local_environment(&pairing_url).map_err(|error| {
                Box::<dyn std::error::Error>::from(format!(
                    "failed to hand off the local environment: {error}"
                ))
            })?;
            let bootstraps = serde_json::json!([{
                "id": "primary",
                "label": "This computer",
                "httpBaseUrl": local.http_base_url,
                "wsBaseUrl": local.ws_base_url,
                "bootstrapToken": local.bootstrap_token,
            }]);
            let app_url = local.app_url.clone();
            let platform = local_env::client_platform();
            app.manage(LocalEnvironmentState::new(local));
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
                stop_server(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{is_external_browser_url, pairing_url_from_line};

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
