//! The executor's only caller: the server this shell started, over a Unix socket.
//!
//! No page gets a Tauri command for any of this. The socket lives in the per-user temporary
//! directory, and every request carries a token the shell minted at launch and gave only to
//! its own server. The connection that starts a session owns it; when it closes, control ends.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{guard, same_secret, Action, Error, ErrorCode, Executor, Owner, Permission};

/// A screenshot request is small; anything longer is not ours.
const MAX_REQUEST_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    id: u64,
    token: String,
    #[serde(flatten)]
    request: Value,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
enum Request {
    Status,
    SetEnabled {
        enabled: bool,
    },
    OpenPermissionSettings {
        permission: Permission,
    },
    Start {
        owner: Owner,
    },
    Stop {
        session_token: Option<String>,
    },
    Displays {
        session_token: String,
    },
    Context {
        session_token: String,
    },
    Screenshot {
        session_token: String,
        display_id: Option<u32>,
        max_width: Option<u32>,
        max_height: Option<u32>,
    },
    Act {
        session_token: String,
        action: Action,
    },
}

pub(crate) struct Channel {
    executor: Arc<Executor>,
    token: String,
    connections: Mutex<HashMap<u64, Arc<Mutex<UnixStream>>>>,
    next: AtomicU64,
}

impl Channel {
    pub(crate) fn new(executor: Arc<Executor>, token: String) -> Arc<Self> {
        Arc::new(Self {
            executor,
            token,
            connections: Mutex::default(),
            next: AtomicU64::new(1),
        })
    }

    /// Answers one request line. Nothing runs unless the channel token matches.
    pub(crate) fn handle(&self, connection: u64, line: &str) -> Value {
        let envelope: Envelope = match serde_json::from_str(line) {
            Ok(envelope) => envelope,
            Err(_) => {
                return failure(
                    Value::Null,
                    Error::new(ErrorCode::InvalidRequest, "Malformed request."),
                )
            }
        };
        let id = json!(envelope.id);
        if !same_secret(&envelope.token, &self.token) {
            return failure(
                id,
                Error::new(
                    ErrorCode::Unauthorized,
                    "This caller may not control the Mac.",
                ),
            );
        }
        let request: Request = match serde_json::from_value(envelope.request) {
            Ok(request) => request,
            Err(error) => {
                return failure(
                    id,
                    Error::new(
                        ErrorCode::InvalidRequest,
                        format!("Invalid request: {error}"),
                    ),
                )
            }
        };
        let executor = &self.executor;
        let result = match request {
            Request::Status => Ok(json!(executor.status())),
            Request::SetEnabled { enabled } => executor
                .set_enabled(enabled)
                .map(|()| json!(executor.status())),
            Request::OpenPermissionSettings { permission } => {
                executor.open_settings(permission).map(|()| Value::Null)
            }
            Request::Start { owner } => executor
                .start(connection, owner)
                .map(|session_token| json!({ "sessionToken": session_token })),
            Request::Stop { session_token } => executor
                .stop(connection, session_token.as_deref())
                .map(|()| Value::Null),
            Request::Displays { session_token } => executor
                .displays(connection, &session_token)
                .map(|displays| json!(displays)),
            Request::Context { session_token } => executor
                .context(connection, &session_token)
                .map(|context| json!(context)),
            Request::Screenshot {
                session_token,
                display_id,
                max_width,
                max_height,
            } => executor
                .screenshot(
                    connection,
                    &session_token,
                    display_id,
                    max_width,
                    max_height,
                )
                .map(|screenshot| json!(screenshot)),
            Request::Act {
                session_token,
                action,
            } => executor
                .act(connection, &session_token, action)
                .map(|()| Value::Null),
        };
        match result {
            Ok(result) => json!({ "id": id, "ok": true, "result": result }),
            Err(error) => failure(id, error),
        }
    }

    /// Tells every connected server the new status, such as after Stop in the menu bar.
    pub(crate) fn broadcast_status(&self) {
        let event = json!({ "event": "status", "status": self.executor.status() }).to_string();
        let connections: Vec<_> = guard(&self.connections).values().cloned().collect();
        for stream in connections {
            let _ = writeln!(guard(&stream), "{event}");
        }
    }

    fn serve(self: Arc<Self>, stream: UnixStream) {
        let connection = self.next.fetch_add(1, Ordering::Relaxed);
        let Ok(writer) = stream.try_clone() else {
            return;
        };
        let writer = Arc::new(Mutex::new(writer));
        guard(&self.connections).insert(connection, Arc::clone(&writer));
        let mut reader = BufReader::new(stream);
        loop {
            let mut line = Vec::new();
            match (&mut reader)
                .take(MAX_REQUEST_BYTES)
                .read_until(b'\n', &mut line)
            {
                Ok(0) | Err(_) => break,
                Ok(_) if line.last() != Some(&b'\n') => break,
                Ok(_) => {}
            }
            let reply = self.handle(connection, &String::from_utf8_lossy(&line));
            if writeln!(guard(&writer), "{reply}").is_err() {
                break;
            }
        }
        guard(&self.connections).remove(&connection);
        self.executor.connection_closed(connection);
    }
}

fn failure(id: Value, error: Error) -> Value {
    json!({ "id": id, "ok": false, "error": error })
}

/// Binds the socket readable only by this user and serves each connection on its own thread.
pub(crate) fn listen(path: &Path, channel: Arc<Channel>) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    std::thread::spawn(move || {
        for stream in listener.incoming().map_while(Result::ok) {
            let channel = Arc::clone(&channel);
            std::thread::spawn(move || channel.serve(stream));
        }
    });
    Ok(())
}

pub(crate) fn socket_path() -> PathBuf {
    std::env::temp_dir().join(format!("gustaf-computer-use-{}.sock", std::process::id()))
}
