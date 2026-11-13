use crate::server_process::Server;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::Manager;

type Reply = Result<Value, String>;
#[derive(Default)]
struct Replies {
    closed: bool,
    requests: HashMap<u64, mpsc::Sender<Reply>>,
}
type Pending = Arc<Mutex<Replies>>;

#[derive(Default)]
pub(crate) struct SshState(Mutex<Option<Worker>>);

struct Worker {
    server: Server,
    input: Option<ChildStdin>,
    pending: Pending,
    next_id: u64,
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.input.take();
        self.server.wait_for_exit(Duration::from_secs(8));
        self.server.stop(Duration::ZERO);
        reject_pending(&self.pending);
    }
}

fn reject_pending(pending: &Pending) {
    if let Ok(mut pending) = pending.lock() {
        pending.closed = true;
        for (_, reply) in pending.requests.drain() {
            let _ = reply.send(Err("SSH process stopped / Процесс SSH остановлен.".into()));
        }
    }
}

fn command(app: &tauri::AppHandle) -> Result<Command, String> {
    #[cfg(debug_assertions)]
    {
        let repo = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut command = Command::new("node");
        command
            .args(["apps/server/src/bin.ts", "__desktop-ssh"])
            .current_dir(repo);
        if let Some(path) = crate::login_shell_path() {
            command.env("PATH", path);
        }
        let _ = app;
        Ok(command)
    }
    #[cfg(not(debug_assertions))]
    {
        let runtime = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?
            .join("runtime");
        let mut command = Command::new(runtime.join(if cfg!(windows) { "t3.exe" } else { "t3" }));
        command.arg("__desktop-ssh").current_dir(runtime);
        if let Some(path) = crate::login_shell_path() {
            command.env("PATH", path);
        }
        Ok(command)
    }
}

impl Worker {
    fn start(app: tauri::AppHandle) -> Result<Self, String> {
        let mut command = command(&app)?;
        command
            // Remote hosts download the runtime of this app's release.
            .env("GUSTAF_APP_VERSION", app.package_info().version.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x08000000);
        let mut server = Server::spawn(&mut command)
            .map_err(|error| format!("Cannot start SSH / Не удалось запустить SSH: {error}"))?;
        let input = server.take_stdin().ok_or("SSH stdin is unavailable")?;
        let output = server.take_stdout().ok_or("SSH stdout is unavailable")?;
        let pending: Pending = Arc::default();
        let replies = pending.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(prompt) = value.get("prompt") {
                    if let Some(window) = app.get_webview_window("main") {
                        let script = format!("window.__gustafSshPasswordPrompt?.({prompt})");
                        let _ = window.eval(script);
                    }
                } else if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    if let Ok(mut pending) = replies.lock() {
                        if let Some(reply) = pending.requests.remove(&id) {
                            let result = match value.get("error").and_then(Value::as_str) {
                                Some(error) => Err(error.to_owned()),
                                None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                            };
                            let _ = reply.send(result);
                        }
                    }
                }
            }
            reject_pending(&replies);
        });
        Ok(Self {
            server,
            input: Some(input),
            pending,
            next_id: 0,
        })
    }
}

pub(crate) fn stop(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SshState>() {
        if let Ok(mut worker) = state.0.lock() {
            worker.take();
        }
    }
}

#[tauri::command]
pub(crate) async fn ssh_request(
    app: tauri::AppHandle,
    method: String,
    input: Value,
    locale: String,
) -> Reply {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SshState>();
        let receiver = {
            let mut worker = state.0.lock().map_err(|_| "SSH state is unavailable")?;
            if worker.as_mut().is_some_and(|worker| !matches!(worker.server.try_wait(), Ok(None)) || worker.pending.lock().map(|pending| pending.closed).unwrap_or(true)) {
                worker.take();
            }
            if worker.is_none() { *worker = Some(Worker::start(app.clone())?); }
            let worker = worker.as_mut().ok_or("SSH process is unavailable")?;
            worker.next_id += 1;
            let id = worker.next_id;
            let (sender, receiver) = mpsc::channel();
            {
                let mut pending = worker.pending.lock().map_err(|_| "SSH replies are unavailable")?;
                if pending.closed { return Err("SSH connection closed / Соединение SSH закрыто.".into()); }
                pending.requests.insert(id, sender);
            }
            let frame = json!({ "id": id, "locale": locale, "request": { "method": method, "input": input } });
            if let Err(error) = writeln!(worker.input.as_mut().ok_or("SSH stdin is unavailable")?, "{frame}") {
                worker.pending.lock().map_err(|_| "SSH replies are unavailable")?.requests.remove(&id);
                return Err(format!("SSH connection closed / Соединение SSH закрыто: {error}"));
            }
            receiver
        };
        receiver.recv().map_err(|_| "SSH connection closed / Соединение SSH закрыто.".to_owned())?
    }).await.map_err(|error| error.to_string())?
}
