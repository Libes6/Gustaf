mod updater;

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

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

#[cfg(debug_assertions)]
fn server_command(_app: &tauri::App) -> tauri::Result<Command> {
    let repo = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut command = Command::new("node");
    command
        .args(["scripts/dev-runner.ts", "dev", "--no-seed"])
        .current_dir(repo);
    Ok(command)
}

#[cfg(not(debug_assertions))]
fn server_command(app: &tauri::App) -> tauri::Result<Command> {
    let runtime = app.path().resource_dir()?.join("runtime");
    let executable = if cfg!(windows) { "t3.exe" } else { "t3" };
    let data_dir = app.path().app_local_data_dir()?;
    let mut command = Command::new(runtime.join(executable));
    command
        .current_dir(runtime)
        .args(["--mode", "web", "--host", "127.0.0.1", "--no-browser"])
        .arg("--no-auto-bootstrap-project-from-cwd")
        .arg("--base-dir")
        .arg(data_dir)
        .env_remove("VITE_DEV_SERVER_URL");
    Ok(command)
}

fn pairing_url_from_line(line: &str) -> Option<&str> {
    let rest = line.split_once("pairingUrl:")?.1.trim();
    let url = rest.trim_end_matches([',', '"', '\'']);
    url.starts_with("http://").then_some(url)
}

fn start_server(app: &tauri::App) -> Result<(Server, tauri::Url), Box<dyn std::error::Error>> {
    let mut command = server_command(app)?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            updater::initialize(app)?;
            set_dock_icon();
            let (server, pairing_url) = start_server(app)?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(pairing_url))
                .title("Gustaf")
                .inner_size(1280.0, 800.0)
                .resizable(true)
                .build()?;
            app.manage(Mutex::new(Some(server)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Gustaf")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                if let Some(server) = app.try_state::<Mutex<Option<Server>>>() {
                    let _ = server.lock().map(|mut server| server.take());
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::pairing_url_from_line;

    #[test]
    fn reads_the_pairing_url_from_the_server_log() {
        let line = "  pairingUrl: http://localhost:7445/pair#token=abc";
        assert_eq!(
            pairing_url_from_line(line),
            Some("http://localhost:7445/pair#token=abc")
        );
        assert_eq!(pairing_url_from_line("serverPort=1 webPort=2"), None);
    }
}
