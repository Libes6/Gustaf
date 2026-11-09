mod updater;

use std::fs::{self, File};
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

fn repo_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn spawn_stack() -> (Child, std::path::PathBuf) {
    let log_path = repo_root().join(".t3/shell.log");
    fs::create_dir_all(log_path.parent().expect("shell log directory")).expect("create .t3");
    let log = File::create(&log_path).expect("create shell log");
    let log_err = log.try_clone().expect("clone shell log");
    let mut command = Command::new("node");
    command
        .args(["scripts/dev-runner.ts", "dev", "--no-seed"])
        .current_dir(repo_root())
        .env("T3CODE_DEV_SEED", "0")
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    #[cfg(unix)]
    command.process_group(0);
    let child = command.spawn().expect("start the Gustaf server");
    (child, log_path)
}

fn pairing_url_from_line(line: &str) -> Option<&str> {
    let rest = line.split_once("pairingUrl:")?.1.trim();
    let url = rest.trim_end_matches([',', '"', '\'']);
    url.starts_with("http").then_some(url)
}

fn wait_for_pairing_url(child: &mut Child, log_path: &std::path::Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut seen = 0usize;
    while Instant::now() < deadline {
        if let Ok(text) = fs::read_to_string(log_path) {
            if text.len() > seen {
                let _ = std::io::stderr().write_all(&text.as_bytes()[seen..]);
                let _ = std::io::stderr().flush();
                seen = text.len();
            }
            for line in text.lines() {
                if let Some(url) = pairing_url_from_line(line) {
                    return url.to_string();
                }
            }
        }
        if let Some(status) = child.try_wait().ok().flatten() {
            panic!("Gustaf server exited before pairing ({status})");
        }
        thread::sleep(Duration::from_millis(200));
    }
    panic!("Gustaf server did not print a pairing URL");
}

fn stop_stack(child: &mut Child) {
    let Ok(pid) = i32::try_from(child.id()) else {
        let _ = child.kill();
        return;
    };
    #[cfg(unix)]
    {
        unsafe { libc::kill(-pid, libc::SIGTERM) };
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
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
    let (mut child, log_path) = spawn_stack();
    let pairing_url = wait_for_pairing_url(&mut child, &log_path);
    let child = Arc::new(Mutex::new(child));
    let child_for_exit = Arc::clone(&child);
    let pairing_url = pairing_url.parse().expect("pairing URL");

    tauri::Builder::default()
        .setup(move |app| {
            updater::initialize(app)?;
            set_dock_icon();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(pairing_url))
                .title("Gustaf")
                .inner_size(1280.0, 800.0)
                .resizable(true)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Gustaf")
        .run(move |_app, event| {
            if matches!(event, RunEvent::Exit) {
                if let Ok(mut child) = child_for_exit.lock() {
                    stop_stack(&mut child);
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
