use serde_json::{json, Value};
use std::sync::Mutex;

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc,
    };
    use std::time::Duration;
    use tauri::Manager;

    type Reply = Result<Value, String>;
    type Replies = Arc<Mutex<HashMap<u64, mpsc::SyncSender<Reply>>>>;
    pub struct Helper {
        child: Mutex<Child>,
        stdin: Mutex<ChildStdin>,
        replies: Replies,
        next: AtomicU64,
    }
    impl Drop for Helper {
        fn drop(&mut self) {
            if let Ok(child) = self.child.get_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    impl Helper {
        pub fn start(app: &tauri::AppHandle) -> Result<Self, String> {
            use std::os::unix::fs::PermissionsExt;
            let directory = app
                .path()
                .app_cache_dir()
                .map_err(|e| e.to_string())?
                .join("native");
            std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let path = directory.join("gustaf-snapshot");
            let temporary = directory.join(format!("snapshot-{}.tmp", std::process::id()));
            std::fs::write(
                &temporary,
                include_bytes!(concat!(env!("OUT_DIR"), "/gustaf-snapshot")),
            )
            .map_err(|e| e.to_string())?;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
            std::fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
            let locale = std::env::var("LANG").unwrap_or_default();
            let mut child = Command::new(path)
                .arg(std::process::id().to_string())
                .arg(if locale.starts_with("ru") { "ru" } else { "en" })
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| e.to_string())?;
            let stdin = child.stdin.take().ok_or("Missing snapshot stdin")?;
            let stdout = child.stdout.take().ok_or("Missing snapshot stdout")?;
            let replies: Replies = Arc::default();
            let reader_replies = replies.clone();
            let app = app.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let Ok(value) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if let Some(event) = value.get("event") {
                        if valid_event(event) {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ =
                                    window.eval(format!("window.__gustafSnapShotEvent?.({event})"));
                                if event["type"] == "ready" {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    } else if let Some(id) = value["id"].as_u64() {
                        if let Ok(mut pending) = reader_replies.lock() {
                            if let Some(sender) = pending.remove(&id) {
                                let reply = match value["error"].as_str() {
                                    Some(error) => Err(error.to_owned()),
                                    None => Ok(value["result"].clone()),
                                };
                                let _ = sender.send(reply);
                            }
                        }
                    }
                }
                if let Ok(mut pending) = reader_replies.lock() {
                    for (_, sender) in pending.drain() {
                        let _ = sender.send(Err("Snapshot helper stopped".into()));
                    }
                }
            });
            Ok(Self {
                child: Mutex::new(child),
                stdin: Mutex::new(stdin),
                replies,
                next: AtomicU64::new(1),
            })
        }
        pub fn request(&self, action: &str, input: Value) -> Reply {
            let id = self.next.fetch_add(1, Ordering::Relaxed);
            let (sender, receiver) = mpsc::sync_channel(1);
            self.replies
                .lock()
                .map_err(|e| e.to_string())?
                .insert(id, sender);
            let result = (|| {
                let mut stdin = self.stdin.lock().map_err(|e| e.to_string())?;
                writeln!(
                    stdin,
                    "{}",
                    json!({ "id": id, "action": action, "input": input })
                )
                .map_err(|e| e.to_string())?;
                drop(stdin);
                receiver
                    .recv_timeout(Duration::from_secs(30))
                    .map_err(|e| e.to_string())?
            })();
            if let Ok(mut pending) = self.replies.lock() {
                pending.remove(&id);
            }
            result
        }
    }
}

pub(crate) struct SnapShotService {
    #[cfg(target_os = "macos")]
    helper: Mutex<Option<native::Helper>>,
    settings: Mutex<Value>,
}

pub(crate) fn initialize(app: &tauri::AppHandle) {
    use tauri::Manager;
    app.manage(SnapShotService {
        #[cfg(target_os = "macos")]
        helper: Mutex::new(None),
        settings: Mutex::new(json!({})),
    });
}

fn valid_action(action: &str) -> bool {
    matches!(
        action,
        "state"
            | "configure"
            | "permissions"
            | "setup"
            | "suppress"
            | "list"
            | "read"
            | "acknowledge"
            | "check"
            | "animation"
    )
}

#[cfg(any(target_os = "macos", test))]
fn valid_event(event: &Value) -> bool {
    let id_valid = event["id"].as_str().is_some_and(|id| {
        !id.is_empty() && id.len() <= 64 && id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
    });
    match event["type"].as_str() {
        Some("requested" | "started" | "ready") => id_valid,
        Some("failed") => event.get("id").is_none() || id_valid,
        Some("shortcut-changed") => true,
        _ => false,
    }
}

fn unavailable_state(settings: &Value, message: &str) -> Value {
    json!({"mode": "unavailable", "shortcut": settings.get("snapShotShortcut").cloned().unwrap_or(json!({"kind": "both-shift-keys"})),
        "shortcutRegistered": false, "shortcutMessage": null, "message": message})
}

#[tauri::command]
pub(crate) async fn snap_shot_command(
    app: tauri::AppHandle,
    action: String,
    input: Option<Value>,
) -> Result<Value, String> {
    if !valid_action(&action) {
        return Err("Unknown snapshot command".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let service = app.state::<SnapShotService>();
        let input = input.unwrap_or(json!({}));
        if action == "configure" {
            *service.settings.lock().map_err(|e| e.to_string())? = input.clone();
        }
        #[cfg(target_os = "macos")]
        {
            let mut slot = service.helper.lock().map_err(|e| e.to_string())?;
            if slot.is_none() {
                let settings = service.settings.lock().map_err(|e| e.to_string())?.clone();
                if action == "configure" && settings["snapShotEnabled"] != true {
                    return Ok(Value::Null);
                }
                match native::Helper::start(&app) {
                    Ok(helper) => {
                        if action != "configure" { helper.request("configure", settings)?; }
                        *slot = Some(helper);
                    }
                    Err(error) if action == "state" => return Ok(unavailable_state(&settings, &error)),
                    Err(error) => return Err(error),
                }
            }
            slot.as_ref().ok_or("Snapshot helper unavailable")?.request(&action, input)
        }
        #[cfg(not(target_os = "macos"))]
        match action.as_str() {
            "state" => {
                let settings = service.settings.lock().map_err(|e| e.to_string())?;
                Ok(unavailable_state(&settings, "SnapShots are only available on macOS in this Gustaf build. / Снимки в этой сборке Gustaf доступны только на macOS."))
            },
            "list" => Ok(json!([])),
            "configure" | "suppress" | "animation" | "acknowledge" => Ok(Value::Null),
            "check" => Ok(json!({"available": false, "message": "SnapShots require macOS. / Для снимков требуется macOS."})),
            _ => Err("SnapShots require macOS. / Для снимков требуется macOS.".into()),
        }
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_native_protocol_before_forwarding() {
        assert!(valid_action("permissions"));
        assert!(!valid_action("capture-path"));
        assert!(valid_event(&json!({"type": "ready", "id": "a1-b2"})));
        assert!(valid_event(&json!({"type": "failed"})));
        assert!(!valid_event(&json!({"type": "ready", "id": "../secret"})));
        assert!(!valid_event(&json!({"type": "ready"})));
        assert!(!valid_event(&json!({"type": "send-turn", "id": "abc"})));
    }
    #[test]
    fn unavailable_does_not_claim_a_working_shortcut() {
        let state = unavailable_state(&json!({}), "Unavailable");
        assert_eq!(state["mode"], "unavailable");
        assert_eq!(state["shortcutRegistered"], false);
        assert_eq!(state["shortcut"]["kind"], "both-shift-keys");
    }
}
