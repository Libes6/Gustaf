//! Local bridge for agent CLIs (Claude Code, Codex, Cursor) that use app features through shell commands:
//! `gustaf-device` (drive a simulator or emulator, docs/features/devices.md "Agents") and `gustaf-agent` (start subagents
//! on any provider, docs/features/agents.md "Subagents from CLI agents"). One server, one token per chat, one launcher
//! script installed under both names.
//!
//! The CLI cannot call app tools, so the app puts a small launcher (`device_bridge/bridge-launcher.sh`) on the agent's PATH.
//! The launcher POSTs its arguments to `/v1/<command>`; the server hands them to the webview (`device-bridge-request`,
//! with the command name), which runs the same tools the API agents use (src/agent/deviceBridge.ts, agentBridge.ts) and
//! answers with `device_bridge_reply`. The Tauri command names keep the `device_bridge_` prefix of the first command.
//!
//! * binds 127.0.0.1 only, random port, started on first use
//! * every request needs `Authorization: Bearer <token>` for a token the webview registered (one per chat, handed to the
//!   agent process in its environment only); requests with an `Origin` header (browsers) or a foreign `Host` are refused
//! * bodies are capped; the answer is plain text, status 200 for success, 422 for a tool error
//! * the body is a form: the repeated field `a` is argv, the optional field `i` is a text input (a plan file or stdin)
//! * a screenshot from the webview is written to the app's own folder and the answer names the file

use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

/// The launcher the agent runs (shared with the node tests, which run it against a local server).
const SHIM: &str = include_str!("device_bridge/bridge-launcher.sh");
/// The commands this server answers: each is a path `/v1/<name>` and the launcher installed as `gustaf-<name>`.
const COMMANDS: [&str; 2] = ["device", "agent"];
fn shim_name(command: &str) -> String {
    format!("gustaf-{command}")
}
const MAX_BODY: usize = 128 * 1024;
const MAX_ARGS: usize = 16;
/// Approval cards can stay open for a long time; the launcher's own curl limit is a little longer.
const WAIT: Duration = Duration::from_secs(600);
const KEEP_SHOTS: usize = 8;
const MAX_IMAGE_B64: usize = 24 * 1024 * 1024;
const MAX_TOKENS: usize = 10_000;

pub struct Reply {
    pub ok: bool,
    pub text: String,
    /// Base64 PNG.
    pub image: Option<String>,
}

/// (request id, command, token, argv, input)
type Emit = Arc<dyn Fn(u64, &str, &str, &[String], Option<&str>) + Send + Sync>;

#[derive(Default)]
struct Shared {
    tokens: Mutex<HashSet<String>>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    next: AtomicU64,
    shots: AtomicU64,
}

impl Shared {
    fn token_ok(&self, token: &str) -> bool {
        use subtle::ConstantTimeEq;
        self.tokens
            .lock()
            .map(|t| {
                t.iter().fold(false, |hit, k| {
                    hit | bool::from(k.as_bytes().ct_eq(token.as_bytes()))
                })
            })
            .unwrap_or(false)
    }

    /// Delivers the webview's answer to the waiting request; false when nobody waits (timed out or unknown id).
    fn deliver(&self, id: u64, reply: Reply) -> bool {
        let tx = self.pending.lock().ok().and_then(|mut p| p.remove(&id));
        tx.is_some_and(|tx| tx.send(reply).is_ok())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    /// `http://127.0.0.1:<port>/v1`; the launcher appends the command name.
    pub base_url: String,
    /// The folder holding the launcher: prepended to the agent's PATH.
    pub bin_dir: String,
}

#[derive(Default)]
pub struct DeviceBridge {
    shared: Arc<Shared>,
    running: Mutex<Option<Info>>,
}

// ---- pure helpers ----

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(v) => {
                        out.push(v);
                        i += 3;
                    }
                    None => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The values of the repeated form field `a`, in order (what the launcher sends), and the text of field `i`, if any
/// (a plan file or stdin); other fields are ignored.
fn parse_form(body: &str) -> (Vec<String>, Option<String>) {
    let mut args = Vec::new();
    let mut input = None;
    for pair in body.split('&') {
        if let Some(v) = pair.strip_prefix("a=") {
            args.push(percent_decode(v));
        } else if let Some(v) = pair.strip_prefix("i=") {
            input.get_or_insert_with(|| percent_decode(v));
        }
    }
    (args, input)
}

/// The command a request path names: `/v1/<command>` for a known command.
fn command_of(path: &str) -> Option<&'static str> {
    let name = path.strip_prefix("/v1/")?;
    COMMANDS.iter().copied().find(|c| *c == name)
}

fn bearer(header: Option<&str>) -> Option<&str> {
    header?.strip_prefix("Bearer ").map(str::trim)
}

fn valid_token(t: &str) -> bool {
    (32..=256).contains(&t.len()) && t.bytes().all(|c| c.is_ascii_alphanumeric())
}

// ---- server ----

fn header(req: &tiny_http::Request, name: &str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn respond(req: tiny_http::Request, status: u16, text: &str) {
    let ct = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/plain; charset=utf-8"[..]);
    let mut r = tiny_http::Response::from_string(text).with_status_code(status);
    if let Ok(h) = ct {
        r = r.with_header(h);
    }
    let _ = req.respond(r);
}

/// Writes a screenshot into `dir` (keeping the latest few) and returns its path.
fn save_shot(shared: &Shared, dir: &Path, b64: &str) -> Result<PathBuf, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    if b64.len() > MAX_IMAGE_B64 {
        return Err("screenshot too large".into());
    }
    let bytes = STANDARD.decode(b64.trim()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let n = shared.shots.fetch_add(1, Ordering::SeqCst);
    let path = dir.join(format!("shot-{n:04}.png"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    if let Ok(rd) = std::fs::read_dir(dir) {
        let mut files: Vec<_> = rd.flatten().map(|e| e.path()).collect();
        files.sort();
        let extra = files.len().saturating_sub(KEEP_SHOTS);
        for old in files.into_iter().take(extra) {
            let _ = std::fs::remove_file(old);
        }
    }
    Ok(path)
}

fn handle(
    shared: &Shared,
    shots: &Path,
    port: u16,
    wait: Duration,
    emit: &Emit,
    mut req: tiny_http::Request,
) {
    let command = command_of(req.url());
    let Some(command) = command.filter(|_| req.method() == &tiny_http::Method::Post) else {
        return respond(req, 404, "Not found");
    };
    // A browser page (DNS rebinding, a malicious site) must not reach this: no Origin, and our own Host only.
    let host = header(&req, "Host").unwrap_or_default();
    if header(&req, "Origin").is_some()
        || (host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}"))
    {
        return respond(req, 403, "Forbidden");
    }
    let auth = header(&req, "Authorization");
    let Some(token) = bearer(auth.as_deref()).map(str::to_string) else {
        return respond(req, 401, "Unauthorized");
    };
    if !shared.token_ok(&token) {
        return respond(req, 401, "Unauthorized");
    }
    if req.body_length().unwrap_or(0) > MAX_BODY {
        return respond(req, 413, "Request too large");
    }
    let mut body = String::new();
    if req
        .as_reader()
        .take(MAX_BODY as u64 + 1)
        .read_to_string(&mut body)
        .is_err()
        || body.len() > MAX_BODY
    {
        return respond(req, 400, "Invalid request body");
    }
    let (args, input) = parse_form(&body);
    if args.len() > MAX_ARGS {
        return respond(req, 400, "Too many arguments");
    }
    let id = shared.next.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = mpsc::channel();
    if let Ok(mut p) = shared.pending.lock() {
        p.insert(id, tx);
    }
    emit(id, command, &token, &args, input.as_deref());
    match rx.recv_timeout(wait) {
        Ok(reply) => {
            let mut text = reply.text;
            if let (true, Some(image)) = (reply.ok, reply.image.as_deref()) {
                match save_shot(shared, shots, image) {
                    Ok(p) => text.push_str(&format!(
                        "\nScreenshot saved: {} (open it with your file-reading tool)",
                        p.display()
                    )),
                    Err(e) => text.push_str(&format!("\n(The screenshot could not be saved: {e})")),
                }
            }
            respond(req, if reply.ok { 200 } else { 422 }, &text)
        }
        Err(_) => {
            if let Ok(mut p) = shared.pending.lock() {
                p.remove(&id);
            }
            respond(req, 504, "Gustaf did not answer in time.")
        }
    }
}

/// Starts the loopback server; returns its port.
fn serve(shared: Arc<Shared>, shots: PathBuf, wait: Duration, emit: Emit) -> Result<u16, String> {
    let server = tiny_http::Server::http(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("no port")?;
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let (shared, shots, emit) = (shared.clone(), shots.clone(), emit.clone());
            // A request may wait minutes for an approval: one thread each.
            std::thread::spawn(move || handle(&shared, &shots, port, wait, &emit, req));
        }
    });
    Ok(port)
}

/// Writes the launcher once per command name (the script reads its own name to pick the path).
fn install_shim(bin: &Path) -> Result<(), String> {
    std::fs::create_dir_all(bin).map_err(|e| e.to_string())?;
    for command in COMMANDS {
        let path = bin.join(shim_name(command));
        if std::fs::read_to_string(&path).ok().as_deref() != Some(SHIM) {
            std::fs::write(&path, SHIM).map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---- commands ----

/// Starts the bridge (once) and installs the launchers. Errors on Windows: the launcher is a POSIX script.
#[tauri::command]
pub fn device_bridge_prepare(
    app: AppHandle,
    state: State<'_, DeviceBridge>,
) -> Result<Info, String> {
    if cfg!(windows) {
        return Err(
            "The gustaf-device and gustaf-agent commands are not available on Windows.".into(),
        );
    }
    let mut running = state.running.lock().map_err(|e| e.to_string())?;
    if let Some(info) = running.as_ref() {
        return Ok(info.clone());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("device-bridge");
    let bin = dir.join("bin");
    install_shim(&bin)?;
    let handle = app.clone();
    let emit: Emit = Arc::new(move |id, command, token, argv, input| {
        let _ = handle.emit(
            "device-bridge-request",
            serde_json::json!({ "id": id, "command": command, "token": token, "argv": argv, "input": input }),
        );
    });
    let port = serve(state.shared.clone(), dir.join("shots"), WAIT, emit)?;
    let info = Info {
        base_url: format!("http://127.0.0.1:{port}/v1"),
        bin_dir: bin.to_string_lossy().to_string(),
    };
    *running = Some(info.clone());
    Ok(info)
}

/// Lets requests with this token through (one random token per chat, made by the webview).
#[tauri::command]
pub fn device_bridge_register(state: State<'_, DeviceBridge>, token: String) -> Result<(), String> {
    if !valid_token(&token) {
        return Err("Invalid token".into());
    }
    let mut tokens = state.shared.tokens.lock().map_err(|e| e.to_string())?;
    if tokens.len() >= MAX_TOKENS && !tokens.contains(&token) {
        return Err("Too many tokens".into());
    }
    tokens.insert(token);
    Ok(())
}

/// The webview's answer to a `device-bridge-request`.
#[tauri::command]
pub fn device_bridge_reply(
    state: State<'_, DeviceBridge>,
    id: u64,
    ok: bool,
    text: String,
    image: Option<String>,
) -> Result<(), String> {
    let text: String = text.chars().take(100_000).collect();
    if state.shared.deliver(id, Reply { ok, text, image }) {
        Ok(())
    } else {
        Err("No request is waiting for this answer".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    fn token() -> String {
        "a".repeat(40)
    }

    #[test]
    fn form_args_keep_order_and_decode() {
        let args = |b| parse_form(b).0;
        assert_eq!(
            args("a=fill&a=%40e19&a=h%C3%A9llo%20w%C3%B6rld%20%26%20100%25&a=-x&b=1"),
            vec!["fill", "@e19", "héllo wörld & 100%", "-x"]
        );
        assert_eq!(args("a=a+b&a=%0Aline"), vec!["a b", "\nline"]);
        assert_eq!(args("a=100%&a=%zz&a=%4"), vec!["100%", "%zz", "%4"]);
        assert!(args("").is_empty());
        assert!(args("b=1").is_empty());
    }

    #[test]
    fn form_input_is_the_first_i_field() {
        let (args, input) = parse_form("a=delegate&a=-&i=%7B%22tasks%22%3A%5B%5D%7D&i=second");
        assert_eq!(args, vec!["delegate", "-"]);
        assert_eq!(input.as_deref(), Some("{\"tasks\":[]}"));
        assert_eq!(parse_form("a=list").1, None);
    }

    #[test]
    fn requests_name_a_known_command() {
        assert_eq!(command_of("/v1/device"), Some("device"));
        assert_eq!(command_of("/v1/agent"), Some("agent"));
        assert_eq!(command_of("/v1/other"), None);
        assert_eq!(command_of("/v1/agent/x"), None);
        assert_eq!(command_of("/v1/"), None);
        assert_eq!(command_of("/other"), None);
    }

    #[test]
    fn bearer_and_token_rules() {
        assert_eq!(bearer(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("Basic abc")), None);
        assert_eq!(bearer(None), None);
        assert!(valid_token(&token()));
        assert!(!valid_token("short"));
        assert!(!valid_token(&format!("{}!", "a".repeat(40))));
        assert!(!valid_token(&"a".repeat(300)));
    }

    #[test]
    fn tokens_are_checked_against_the_registered_set() {
        let s = Shared::default();
        s.tokens.lock().unwrap().insert(token());
        assert!(s.token_ok(&token()));
        assert!(!s.token_ok(&"b".repeat(40)));
        assert!(!s.token_ok(""));
        assert!(!s.token_ok(&"a".repeat(39)));
    }

    #[test]
    fn the_launcher_is_embedded_and_a_posix_script() {
        assert!(SHIM.starts_with("#!/bin/sh\n"));
        assert!(SHIM.contains("GUSTAF_BRIDGE_TOKEN"));
    }

    #[test]
    fn install_writes_an_executable_launcher_per_command() {
        let dir = std::env::temp_dir().join(format!("gustaf-bridge-{}", std::process::id()));
        let bin = dir.join("bin");
        install_shim(&bin).unwrap();
        install_shim(&bin).unwrap();
        for command in COMMANDS {
            let path = bin.join(shim_name(command));
            assert_eq!(std::fs::read_to_string(&path).unwrap(), SHIM);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&path).unwrap().permissions().mode();
                assert_eq!(mode & 0o111, 0o111);
            }
        }
        assert!(bin.join("gustaf-agent").exists() && bin.join("gustaf-device").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Sends a raw HTTP request and returns (status, body).
    fn http(port: u16, head: &str, body: &str) -> (u16, String) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let req = format!(
            "{head}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        s.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        let status = out.split(' ').nth(1).unwrap().parse().unwrap();
        let body = out.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (status, body)
    }

    fn start(
        wait: Duration,
        answer: impl Fn(u64, &str, &[String], Option<&str>) -> Option<Reply> + Send + Sync + 'static,
    ) -> (u16, Arc<Shared>, PathBuf) {
        let shared = Arc::new(Shared::default());
        shared.tokens.lock().unwrap().insert(token());
        let shots = std::env::temp_dir().join(format!(
            "gustaf-shots-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let s2 = shared.clone();
        let answer = Arc::new(answer);
        let emit: Emit = Arc::new(move |id, command, _token, argv, input| {
            if let Some(reply) = answer(id, command, argv, input) {
                // The webview answers from another thread, after the request started waiting.
                let s3 = s2.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(30));
                    s3.deliver(id, reply);
                });
            }
        });
        let port = serve(shared.clone(), shots.clone(), wait, emit).unwrap();
        (port, shared, shots)
    }

    fn post(port: u16, auth: &str, body: &str) -> (u16, String) {
        post_to(port, "device", auth, body)
    }

    fn post_to(port: u16, command: &str, auth: &str, body: &str) -> (u16, String) {
        http(
            port,
            &format!(
                "POST /v1/{command} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {auth}\r\nContent-Type: application/x-www-form-urlencoded"
            ),
            body,
        )
    }

    #[test]
    fn serves_authenticated_requests_and_relays_the_answer() {
        let (port, _s, _d) = start(Duration::from_secs(5), |_, _, argv, _| {
            Some(Reply {
                ok: argv[0] != "fail",
                text: format!("got {}", argv.join("|")),
                image: None,
            })
        });
        let bearer = format!("Bearer {}", token());
        assert_eq!(
            post(port, &bearer, "a=tap&a=%40e7"),
            (200, "got tap|@e7".into())
        );
        assert_eq!(post(port, &bearer, "a=fail"), (422, "got fail".into()));
        assert_eq!(post(port, "Bearer nope", "a=list").0, 401);
        assert_eq!(post(port, "Basic x", "a=list").0, 401);
        let many = (0..20)
            .map(|i| format!("a={i}"))
            .collect::<Vec<_>>()
            .join("&");
        assert_eq!(post(port, &bearer, &many).0, 400);
        let huge = format!("a={}", "x".repeat(MAX_BODY + 10));
        assert_eq!(post(port, &bearer, &huge).0, 413);
    }

    #[test]
    fn routes_each_command_with_its_name_and_input() {
        let (port, _s, _d) = start(Duration::from_secs(5), |_, command, argv, input| {
            Some(Reply {
                ok: true,
                text: format!("{command}:{}:{}", argv.join("|"), input.unwrap_or("-")),
                image: None,
            })
        });
        let bearer = format!("Bearer {}", token());
        assert_eq!(
            post_to(port, "agent", &bearer, "a=delegate&a=-&i=%7B%7D"),
            (200, "agent:delegate|-:{}".into())
        );
        assert_eq!(
            post_to(port, "device", &bearer, "a=list"),
            (200, "device:list:-".into())
        );
        assert_eq!(post_to(port, "unknown", &bearer, "a=list").0, 404);
        assert_eq!(post_to(port, "agent", "Bearer nope", "a=list").0, 401);
    }

    #[test]
    fn refuses_browsers_foreign_hosts_and_other_paths() {
        let (port, _s, _d) = start(Duration::from_secs(5), |_, _, _, _| {
            Some(Reply {
                ok: true,
                text: "x".into(),
                image: None,
            })
        });
        let auth = format!("Authorization: Bearer {}", token());
        let with_origin = format!(
            "POST /v1/device HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://evil.example\r\n{auth}"
        );
        assert_eq!(http(port, &with_origin, "a=list").0, 403);
        let foreign = format!("POST /v1/device HTTP/1.1\r\nHost: evil.example\r\n{auth}");
        assert_eq!(http(port, &foreign, "a=list").0, 403);
        let get = format!("GET /v1/device HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}");
        assert_eq!(http(port, &get, "").0, 404);
        let other = format!("POST /other HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}");
        assert_eq!(http(port, &other, "a=list").0, 404);
        let local = format!("POST /v1/device HTTP/1.1\r\nHost: localhost:{port}\r\n{auth}");
        assert_eq!(http(port, &local, "a=list").0, 200);
    }

    #[test]
    fn times_out_when_the_webview_never_answers() {
        let (port, s, _d) = start(Duration::from_millis(150), |_, _, _, _| None);
        let (status, _) = post(port, &format!("Bearer {}", token()), "a=list");
        assert_eq!(status, 504);
        assert!(s.pending.lock().unwrap().is_empty());
        assert!(!s.deliver(
            1,
            Reply {
                ok: true,
                text: String::new(),
                image: None
            }
        ));
    }

    #[test]
    fn saves_screenshots_and_names_the_file() {
        let png = "iVBORw0KGgo=";
        let (port, _s, shots) = start(Duration::from_secs(5), move |_, _, _, _| {
            Some(Reply {
                ok: true,
                text: "snap".into(),
                image: Some(png.into()),
            })
        });
        let (status, body) = post(
            port,
            &format!("Bearer {}", token()),
            "a=snapshot&a=--screenshot",
        );
        assert_eq!(status, 200);
        let path = body
            .split("Screenshot saved: ")
            .nth(1)
            .unwrap()
            .split(" (")
            .next()
            .unwrap();
        assert!(Path::new(path).starts_with(&shots));
        assert_eq!(
            std::fs::read(path).unwrap(),
            vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
        );
        for _ in 0..12 {
            post(port, &format!("Bearer {}", token()), "a=snapshot");
        }
        assert_eq!(std::fs::read_dir(&shots).unwrap().count(), KEEP_SHOTS);
        let _ = std::fs::remove_dir_all(shots);
    }

    #[test]
    fn a_bad_screenshot_does_not_fail_the_answer() {
        let (port, _s, shots) = start(Duration::from_secs(5), |_, _, _, _| {
            Some(Reply {
                ok: true,
                text: "snap".into(),
                image: Some("%%%".into()),
            })
        });
        let (status, body) = post(port, &format!("Bearer {}", token()), "a=snapshot");
        assert_eq!(status, 200);
        assert!(body.starts_with("snap\n(The screenshot could not be saved"));
        let _ = std::fs::remove_dir_all(shots);
    }
}
