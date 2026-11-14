//! `Backend` over native/ComputerUse.swift, a helper process started on first use.
//! A separate process because ScreenCaptureKit is Swift-first, the same pattern as SnapShots,
//! and killing it is a hard stop. Requests and replies are never logged.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Manager;

use super::{
    Backend, Button, Display, FrontApp, Input, Permission, Permissions, Probe, RawImage, Rect,
};

const QUICK: Duration = Duration::from_secs(5);
const SLOW: Duration = Duration::from_secs(20);

struct Process {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
    next: u64,
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Process {
    fn start(app: &tauri::AppHandle) -> Result<Self, String> {
        use std::os::unix::fs::PermissionsExt;
        let directory = app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?
            .join("native");
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let path = directory.join("gustaf-computer-use");
        let temporary = directory.join(format!("computer-use-{}.tmp", std::process::id()));
        std::fs::write(
            &temporary,
            include_bytes!(concat!(env!("OUT_DIR"), "/gustaf-computer-use")),
        )
        .map_err(|error| error.to_string())?;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
        let mut child = Command::new(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;
        let stdin = child.stdin.take().ok_or("helper-stdin")?;
        let stdout = child.stdout.take().ok_or("helper-stdout")?;
        let (send, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if send.send(line).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            lines,
            next: 0,
        })
    }
}

pub(crate) struct HelperBackend {
    app: tauri::AppHandle,
    process: Option<Process>,
}

impl HelperBackend {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app, process: None }
    }

    fn call(&mut self, mut request: Value, timeout: Duration) -> Result<Value, String> {
        if self.process.is_none() {
            self.process = Some(Process::start(&self.app)?);
        }
        let process = self.process.as_mut().ok_or("helper-missing")?;
        process.next += 1;
        let id = process.next;
        request["id"] = json!(id);
        if writeln!(process.stdin, "{request}").is_err() {
            self.process = None;
            return Err("helper-stopped".into());
        }
        loop {
            let Ok(line) = process.lines.recv_timeout(timeout) else {
                // A helper that stops answering is replaced; its held input is released by `release`.
                self.process = None;
                return Err("helper-timed-out".into());
            };
            let Ok(reply) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if reply["id"].as_u64() != Some(id) {
                continue;
            }
            return match reply["error"].as_str() {
                Some(error) => Err(error.to_owned()),
                None => Ok(reply["result"].clone()),
            };
        }
    }
}

fn button_name(button: Button) -> &'static str {
    match button {
        Button::Left => "left",
        Button::Right => "right",
        Button::Middle => "middle",
    }
}

fn parse_display(value: &Value) -> Option<Display> {
    Some(Display {
        id: u32::try_from(value["id"].as_u64()?).ok()?,
        name: value["name"].as_str().unwrap_or_default().to_owned(),
        main: value["main"].as_bool().unwrap_or(false),
        bounds: Rect {
            x: value["x"].as_f64()?,
            y: value["y"].as_f64()?,
            width: value["width"].as_f64()?,
            height: value["height"].as_f64()?,
        },
        scale: value["scale"].as_f64()?,
    })
}

impl Backend for HelperBackend {
    fn permissions(&mut self) -> Result<Permissions, String> {
        let value = self.call(json!({ "op": "permissions" }), QUICK)?;
        Ok(Permissions {
            screen_recording: value["screenRecording"].as_bool() == Some(true),
            accessibility: value["accessibility"].as_bool() == Some(true),
        })
    }

    fn open_settings(&mut self, permission: Permission) -> Result<(), String> {
        let permission = match permission {
            Permission::ScreenRecording => "screen-recording",
            Permission::Accessibility => "accessibility",
        };
        self.call(
            json!({ "op": "open-settings", "permission": permission }),
            QUICK,
        )
        .map(drop)
    }

    fn displays(&mut self) -> Result<Vec<Display>, String> {
        let value = self.call(json!({ "op": "displays" }), QUICK)?;
        Ok(value
            .as_array()
            .map(|displays| displays.iter().filter_map(parse_display).collect())
            .unwrap_or_default())
    }

    fn probe(&mut self) -> Result<Probe, String> {
        let value = self.call(json!({ "op": "context" }), QUICK)?;
        let app = &value["app"];
        Ok(Probe {
            app: app.is_object().then(|| FrontApp {
                name: app["name"].as_str().unwrap_or_default().to_owned(),
                bundle_id: app["bundleId"].as_str().unwrap_or_default().to_owned(),
                pid: app["pid"]
                    .as_i64()
                    .and_then(|pid| i32::try_from(pid).ok())
                    .unwrap_or(0),
            }),
            window_title: value["windowTitle"].as_str().map(str::to_owned),
            screen_locked: value["screenLocked"].as_bool() == Some(true),
            secure_input: value["secureInput"].as_bool() == Some(true),
        })
    }

    fn capture(&mut self, display: u32, width: u32, height: u32) -> Result<RawImage, String> {
        let value = self.call(
            json!({ "op": "capture", "display": display, "width": width, "height": height }),
            SLOW,
        )?;
        let size = |key: &str| {
            value[key]
                .as_u64()
                .and_then(|size| u32::try_from(size).ok())
                .filter(|size| *size > 0)
                .ok_or("capture-failed")
        };
        Ok(RawImage {
            width: size("width")?,
            height: size("height")?,
            data: value["data"].as_str().ok_or("capture-failed")?.to_owned(),
        })
    }

    fn input(&mut self, input: &Input) -> Result<(), String> {
        let request = match input {
            Input::Move { x, y, dragging } => json!({
                "kind": "move", "x": x, "y": y, "dragging": dragging.map(button_name),
            }),
            Input::Button {
                x,
                y,
                button,
                down,
                clicks,
            } => json!({
                "kind": "button", "x": x, "y": y, "button": button_name(*button),
                "down": down, "clicks": clicks,
            }),
            Input::Scroll { dx, dy } => json!({ "kind": "scroll", "dx": dx, "dy": dy }),
            Input::Key { code, down, flags } => {
                json!({ "kind": "key", "code": code, "down": down, "flags": flags })
            }
            Input::Text(text) => json!({ "kind": "text", "text": text }),
        };
        let mut request = request;
        request["op"] = json!("input");
        self.call(request, QUICK).map(drop)
    }

    fn activate(&mut self, app: &str) -> Result<(), String> {
        self.call(json!({ "op": "activate", "app": app }), SLOW)
            .map(drop)
    }
}
