//! HTTPS requests and the event WebSocket. Authentication, limits and routing live here; the data comes from `data.rs`,
//! the pairing rules from `pairing.rs`.
//!
//! Routes (all JSON; protocol version 1):
//! * `POST /v1/pair`                      no token: trade a pairing code for a device token (rate limited)
//! * `GET  /v1/info`                      protocol and app version
//! * `GET  /v1/projects`                  `ProjectSummary[]`
//! * `GET  /v1/chats?project=&archived=&limit=`            `ChatSummary[]`
//! * `GET  /v1/chats/:id/messages?limit=&before=`          `ChatMessage[]`, oldest first
//! * `GET  /v1/events` (WebSocket)        `ServerEvent` frames
//!
//! Everything except `/v1/pair` needs `Authorization: Bearer <device token>`; a missing, malformed, unknown or revoked token
//! gets the same 401 body, and authentication is checked BEFORE the route is looked up, so an unauthenticated client cannot
//! learn which paths exist.

use super::{
    data::{self, Store, DEFAULT_CHATS, DEFAULT_MESSAGES, MAX_ACTIVE_DEVICES, MAX_CHATS, MAX_MESSAGES},
    events::{self, Detector, StatusBoard},
    net,
    commands::{BusError, CommandBus},
    pairing::{self, PairError, PairingState, RateLimiter},
    PROTOCOL_VERSION,
};
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    body::{Bytes, Incoming},
    header::{self, HeaderMap, HeaderValue},
    service::service_fn,
    Method, Request, Response, StatusCode,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    convert::Infallible,
    net::IpAddr,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpListener,
    sync::{broadcast, watch, Semaphore},
    time::{interval, timeout, MissedTickBehavior},
};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::{
    tungstenite::{
        handshake::derive_accept_key,
        protocol::{frame::coding::CloseCode, CloseFrame, Role, WebSocketConfig},
        Message,
    },
    WebSocketStream,
};

const MAX_CONNECTIONS: usize = 64;
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PAIR_BODY: usize = 4 * 1024;
/// A message from the phone: text up to `MAX_SEND_CHARS` characters, so up to 4 bytes each plus the JSON around it.
const MAX_COMMAND_BODY: usize = 96 * 1024;
const MAX_SEND_CHARS: usize = 20_000;
/// How long a command waits for the webview to accept it (the run itself continues afterwards).
const COMMAND_WAIT: Duration = Duration::from_secs(10);
const MAX_SOCKETS: usize = 32;
const MAX_SOCKETS_PER_DEVICE: usize = 4;
/// Keep-alive ping interval; a socket that sent nothing (not even a pong) for `SOCKET_IDLE` is dropped.
const PING_EVERY: Duration = Duration::from_secs(20);
const SOCKET_IDLE: Duration = Duration::from_secs(75);
const POLL_EVERY: Duration = Duration::from_millis(750);
/// `last_seen_at` is written at most this often per device.
const TOUCH_EVERY: Duration = Duration::from_secs(15);

pub struct Ctx {
    pub store: Arc<Store>,
    pub board: Arc<StatusBoard>,
    pub bus: Arc<CommandBus>,
    pub pairing: Mutex<PairingState>,
    /// Failed bearer-token checks per address (a token is 256 random bits, so this only stops pointless hammering).
    auth_limiter: Mutex<RateLimiter>,
    pub events: broadcast::Sender<Arc<str>>,
    pub revoked: broadcast::Sender<String>,
    pub shutdown: watch::Receiver<bool>,
    pub desktop_name: String,
    pub app_version: String,
    pub allow_loopback: bool,
    last_touch: Mutex<HashMap<String, Instant>>,
    subscribers: AtomicUsize,
    sockets: Mutex<HashMap<String, usize>>,
    total_sockets: AtomicUsize,
}

impl Ctx {
    pub fn new(store: Arc<Store>, board: Arc<StatusBoard>, bus: Arc<CommandBus>, shutdown: watch::Receiver<bool>, desktop_name: String, app_version: String, allow_loopback: bool) -> Ctx {
        Ctx {
            store,
            board,
            bus,
            pairing: Mutex::new(PairingState::default()),
            auth_limiter: Mutex::new(RateLimiter::new(20, Duration::from_secs(60), Duration::from_secs(60))),
            events: broadcast::channel(256).0,
            revoked: broadcast::channel(16).0,
            shutdown,
            desktop_name,
            app_version,
            allow_loopback,
            last_touch: Mutex::new(HashMap::new()),
            subscribers: AtomicUsize::new(0),
            sockets: Mutex::new(HashMap::new()),
            total_sockets: AtomicUsize::new(0),
        }
    }

    /// Called after a device was revoked: its live sockets close, its `last_seen_at` bookkeeping is dropped.
    pub fn device_revoked(&self, id: &str) {
        self.last_touch.lock().unwrap_or_else(|p| p.into_inner()).remove(id);
        let _ = self.revoked.send(id.to_string());
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn unix_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ---- Responses --------------------------------------------------------------------------------------------------------

type Resp = Response<Full<Bytes>>;

fn respond(status: StatusCode, body: Vec<u8>) -> Resp {
    let mut res = Response::new(Full::new(Bytes::from(body)));
    *res.status_mut() = status;
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    res
}

fn json<T: Serialize>(status: StatusCode, value: &T) -> Resp {
    match serde_json::to_vec(value) {
        Ok(body) => respond(status, body),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Internal error"),
    }
}

fn error(status: StatusCode, code: &str, message: &str) -> Resp {
    respond(status, serde_json::to_vec(&serde_json::json!({ "code": code, "message": message })).unwrap_or_default())
}

/// The one response for every authentication failure.
fn unauthorized() -> Resp {
    let mut res = error(StatusCode::UNAUTHORIZED, "unauthorized", "Unauthorized");
    res.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    res
}

fn too_many(wait: Duration) -> Resp {
    let mut res = error(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "Too many attempts; try again later");
    if let Ok(v) = HeaderValue::from_str(&wait.as_secs().max(1).to_string()) {
        res.headers_mut().insert(header::RETRY_AFTER, v);
    }
    res
}

fn bad_request(message: &str) -> Resp {
    error(StatusCode::BAD_REQUEST, "bad_request", message)
}

fn internal() -> Resp {
    error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "Internal error")
}

/// Runs a blocking database call off the async threads. Any failure is a generic 500 (database messages never leave).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, Resp> {
    match tokio::task::spawn_blocking(f).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => {
            eprintln!("mobile server: {e}");
            Err(internal())
        }
        Err(_) => Err(internal()),
    }
}

// ---- Authentication ---------------------------------------------------------------------------------------------------

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

async fn authenticate(ctx: &Arc<Ctx>, peer: IpAddr, headers: &HeaderMap) -> Result<String, Resp> {
    if let Err(wait) = lock(&ctx.auth_limiter).check(peer, Instant::now()) {
        return Err(too_many(wait));
    }
    let fail = |ctx: &Ctx| {
        lock(&ctx.auth_limiter).record_failure(peer, Instant::now());
        unauthorized()
    };
    let Some(token) = bearer(headers).filter(|t| pairing::token_shape_ok(t)) else { return Err(fail(ctx)) };
    let presented = pairing::hash_token(token);
    let store = ctx.store.clone();
    let devices = blocking(move || store.active_devices()).await?;
    let Some(id) = pairing::find_device(&devices, &presented).map(str::to_owned) else { return Err(fail(ctx)) };
    let due = {
        let mut touched = lock(&ctx.last_touch);
        let due = touched.get(&id).is_none_or(|t| t.elapsed() >= TOUCH_EVERY);
        if due {
            touched.insert(id.clone(), Instant::now());
        }
        due
    };
    if due {
        let (store, id) = (ctx.store.clone(), id.clone());
        blocking(move || store.touch_device(&id, unix_ms())).await?;
    }
    Ok(id)
}

// ---- Routing ----------------------------------------------------------------------------------------------------------

async fn handle(ctx: Arc<Ctx>, peer: IpAddr, req: Request<Incoming>) -> Result<Resp, Infallible> {
    Ok(match timeout(REQUEST_TIMEOUT, dispatch(ctx, peer, req)).await {
        Ok(res) => res,
        Err(_) => error(StatusCode::GATEWAY_TIMEOUT, "internal", "Timed out"),
    })
}

async fn dispatch(ctx: Arc<Ctx>, peer: IpAddr, req: Request<Incoming>) -> Resp {
    let path = req.uri().path().to_string();
    if path == "/v1/pair" {
        return if req.method() == Method::POST { pair(&ctx, peer, req).await } else { method_not_allowed("POST") };
    }
    let device = match authenticate(&ctx, peer, req.headers()).await {
        Ok(id) => id,
        Err(res) => return res,
    };
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let get = req.method() == Method::GET;
    match (segments.as_slice(), get) {
        (["v1", "info"], true) => json(
            StatusCode::OK,
            &serde_json::json!({ "protocol": PROTOCOL_VERSION, "app": "Gustaf", "appVersion": ctx.app_version, "desktopName": ctx.desktop_name }),
        ),
        (["v1", "projects"], true) => match blocking({
            let store = ctx.store.clone();
            move || store.projects()
        })
        .await
        {
            Ok(rows) => json(StatusCode::OK, &rows),
            Err(res) => res,
        },
        (["v1", "chats"], true) => list_chats(&ctx, req.uri().query()).await,
        (["v1", "chats", id, "messages"], true) => list_messages(&ctx, id, req.uri().query()).await,
        (["v1", "events"], true) => events_socket(ctx, device, req),
        (["v1", "chats"], false) if req.method() == Method::POST => new_chat(&ctx, req).await,
        (["v1", "chats", id, "messages"], false) if req.method() == Method::POST => send_message(&ctx, id, req).await,
        (["v1", "chats", id, "stop"], false) if req.method() == Method::POST => stop_chat(&ctx, id).await,
        (["v1", "chats", _, "messages"], false) => method_not_allowed("GET, POST"),
        (["v1", "chats", _, "stop"], _) => method_not_allowed("POST"),
        (["v1", "chats"], false) => method_not_allowed("GET, POST"),
        (["v1", "info" | "projects" | "events"], false) => method_not_allowed("GET"),
        _ => error(StatusCode::NOT_FOUND, "not_found", "Not found"),
    }
}

fn method_not_allowed(allow: &'static str) -> Resp {
    let mut res = error(StatusCode::METHOD_NOT_ALLOWED, "bad_request", "Method not allowed");
    res.headers_mut().insert(header::ALLOW, HeaderValue::from_static(allow));
    res
}

/// Query string into pairs; values are never percent-decoded because every accepted parameter is a plain number or flag.
fn query(q: Option<&str>) -> HashMap<&str, &str> {
    q.unwrap_or("").split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').unwrap_or((p, ""))).collect()
}

/// A non-negative integer made of ASCII digits only.
fn number(v: &str) -> Option<i64> {
    (!v.is_empty() && v.len() <= 15 && v.bytes().all(|b| b.is_ascii_digit())).then(|| v.parse().ok()).flatten()
}

async fn list_chats(ctx: &Arc<Ctx>, q: Option<&str>) -> Resp {
    let q = query(q);
    let project = match q.get("project") {
        None => None,
        Some(v) => match number(v) {
            Some(n) => Some(n),
            None => return bad_request("project must be a number"),
        },
    };
    let archived = match q.get("archived").copied() {
        None | Some("0") | Some("false") => false,
        Some("1") | Some("true") => true,
        Some(_) => return bad_request("archived must be 0 or 1"),
    };
    let limit = match q.get("limit") {
        None => DEFAULT_CHATS,
        Some(v) => match number(v) {
            Some(n) if n >= 1 => (n as usize).min(MAX_CHATS),
            _ => return bad_request("limit must be a positive number"),
        },
    };
    let store = ctx.store.clone();
    match blocking(move || store.chats(project, archived, limit)).await {
        Ok(rows) => {
            let out: Vec<_> = rows.iter().map(|r| data::chat_summary(r, ctx.board.get(r.id))).collect();
            json(StatusCode::OK, &out)
        }
        Err(res) => res,
    }
}

async fn list_messages(ctx: &Arc<Ctx>, id: &str, q: Option<&str>) -> Resp {
    let Some(chat_id) = number(id) else { return error(StatusCode::NOT_FOUND, "not_found", "Not found") };
    let q = query(q);
    let limit = match q.get("limit") {
        None => DEFAULT_MESSAGES,
        Some(v) => match number(v) {
            Some(n) if n >= 1 => (n as usize).min(MAX_MESSAGES),
            _ => return bad_request("limit must be a positive number"),
        },
    };
    let before = match q.get("before") {
        None => None,
        Some(v) => match number(v) {
            Some(n) => Some(n),
            None => return bad_request("before must be a message id"),
        },
    };
    let store = ctx.store.clone();
    match blocking(move || Ok(if store.chat_exists(chat_id)? { Some(store.messages(chat_id, limit, before)?) } else { None })).await {
        Ok(Some(rows)) => json(StatusCode::OK, &data::shape_messages(&rows)),
        Ok(None) => error(StatusCode::NOT_FOUND, "not_found", "Not found"),
        Err(res) => res,
    }
}

// ---- Commands (phone to desktop) ---------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendBody {
    text: String,
    provider_id: Option<String>,
    model: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewChatBody {
    project_id: i64,
    text: String,
    title: Option<String>,
}

async fn read_body<T: serde::de::DeserializeOwned>(req: Request<Incoming>) -> Result<T, Resp> {
    let body = match Limited::new(req.into_body(), MAX_COMMAND_BODY).collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => return Err(bad_request("Request body too large or unreadable")),
    };
    serde_json::from_slice::<T>(&body).map_err(|_| bad_request("Invalid JSON body"))
}

fn clean_text(raw: &str) -> Result<String, Resp> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(bad_request("text must not be empty"));
    }
    if text.chars().count() > MAX_SEND_CHARS {
        return Err(bad_request("text is too long"));
    }
    Ok(text.to_string())
}

/// Forwards a command to the webview and shapes its answer: accepted (202), or the webview's refusal.
async fn forward(ctx: &Arc<Ctx>, kind: &str, payload: Value) -> Resp {
    match ctx.bus.request(kind, payload, COMMAND_WAIT).await {
        Ok(reply) if reply.ok => {
            let mut body = match reply.data {
                Value::Object(m) => m,
                _ => serde_json::Map::new(),
            };
            body.insert("ok".into(), Value::Bool(true));
            json(StatusCode::ACCEPTED, &Value::Object(body))
        }
        Ok(reply) => {
            let message = data::clip_chars(&reply.message, 200);
            match reply.code.as_str() {
                "busy" => error(StatusCode::CONFLICT, "bad_request", if message.is_empty() { "The chat is busy" } else { &message }),
                "not_found" => error(StatusCode::NOT_FOUND, "not_found", "Not found"),
                "bad_request" => bad_request(if message.is_empty() { "Rejected" } else { &message }),
                _ => error(StatusCode::INTERNAL_SERVER_ERROR, "internal", if message.is_empty() { "The desktop could not run this" } else { &message }),
            }
        }
        Err(BusError::Timeout) => error(StatusCode::GATEWAY_TIMEOUT, "internal", "The desktop app did not answer. Is its window open?"),
        Err(BusError::Unavailable) => error(StatusCode::SERVICE_UNAVAILABLE, "internal", "The desktop app is not ready"),
    }
}

async fn chat_exists(ctx: &Arc<Ctx>, id: i64) -> Result<(), Resp> {
    let store = ctx.store.clone();
    if blocking(move || store.chat_exists(id)).await? { Ok(()) } else { Err(error(StatusCode::NOT_FOUND, "not_found", "Not found")) }
}

async fn send_message(ctx: &Arc<Ctx>, id: &str, req: Request<Incoming>) -> Resp {
    let Some(chat_id) = number(id) else { return error(StatusCode::NOT_FOUND, "not_found", "Not found") };
    let body: SendBody = match read_body(req).await {
        Ok(b) => b,
        Err(res) => return res,
    };
    let text = match clean_text(&body.text) {
        Ok(t) => t,
        Err(res) => return res,
    };
    if let Err(res) = chat_exists(ctx, chat_id).await {
        return res;
    }
    let clip = |v: Option<String>| v.map(|s| data::clip_chars(s.trim(), 200)).filter(|s| !s.is_empty());
    forward(ctx, "send", serde_json::json!({ "chatId": chat_id, "text": text, "providerId": clip(body.provider_id), "model": clip(body.model) })).await
}

async fn stop_chat(ctx: &Arc<Ctx>, id: &str) -> Resp {
    let Some(chat_id) = number(id) else { return error(StatusCode::NOT_FOUND, "not_found", "Not found") };
    if let Err(res) = chat_exists(ctx, chat_id).await {
        return res;
    }
    forward(ctx, "stop", serde_json::json!({ "chatId": chat_id })).await
}

async fn new_chat(ctx: &Arc<Ctx>, req: Request<Incoming>) -> Resp {
    let body: NewChatBody = match read_body(req).await {
        Ok(b) => b,
        Err(res) => return res,
    };
    let text = match clean_text(&body.text) {
        Ok(t) => t,
        Err(res) => return res,
    };
    let store = ctx.store.clone();
    let projects = match blocking(move || store.projects()).await {
        Ok(p) => p,
        Err(res) => return res,
    };
    if !projects.iter().any(|p| p.id == body.project_id) {
        return error(StatusCode::NOT_FOUND, "not_found", "Not found");
    }
    let title = body.title.map(|t| data::clip_chars(t.trim(), 200)).filter(|t| !t.is_empty());
    forward(ctx, "newChat", serde_json::json!({ "projectId": body.project_id, "text": text, "title": title })).await
}

// ---- Pairing ----------------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairBody {
    code: String,
    device_name: String,
    protocol: Option<i64>,
    /// Descriptive data from the phone (platform, model, app version). Validated and bounded, then not stored: the
    /// device list shows only the name.
    public_info: Option<Value>,
}

fn clean_device_name(raw: &str) -> String {
    let name: String = raw.chars().filter(|c| !c.is_control()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    let name = data::clip_chars(&name, 64);
    if name.is_empty() { "Phone".to_string() } else { name }
}

async fn pair(ctx: &Arc<Ctx>, peer: IpAddr, req: Request<Incoming>) -> Resp {
    if let Err(wait) = lock(&ctx.pairing).check_locked(peer, Instant::now()) {
        return too_many(wait);
    }
    let bad = |ctx: &Ctx, message: &str| {
        lock(&ctx.pairing).record_bad_request(peer, Instant::now());
        bad_request(message)
    };
    let body = match Limited::new(req.into_body(), MAX_PAIR_BODY).collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => return bad(ctx, "Request body too large or unreadable"),
    };
    let Ok(parsed) = serde_json::from_slice::<PairBody>(&body) else { return bad(ctx, "Expected {code, deviceName}") };
    if parsed.code.is_empty() || parsed.code.chars().count() > 64 {
        return bad(ctx, "Invalid code");
    }
    if let Some(info) = &parsed.public_info {
        if !info.is_object() || info.as_object().is_some_and(|o| o.len() > 16) || info.to_string().len() > 2048 {
            return bad(ctx, "publicInfo must be a small object");
        }
    }
    if parsed.protocol.is_some_and(|p| p != i64::from(PROTOCOL_VERSION)) {
        return error(StatusCode::BAD_REQUEST, "version_mismatch", "Unsupported protocol version");
    }
    let store = ctx.store.clone();
    match blocking(move || store.active_devices().map(|d| d.len())).await {
        Ok(n) if n >= MAX_ACTIVE_DEVICES => return error(StatusCode::CONFLICT, "bad_request", "Too many paired devices; revoke one first"),
        Ok(_) => {}
        Err(res) => return res,
    }
    match lock(&ctx.pairing).attempt(peer, &parsed.code, Instant::now()) {
        Ok(()) => {}
        Err(PairError::Locked(wait)) => return too_many(wait),
        Err(PairError::Invalid) => return error(StatusCode::UNAUTHORIZED, "unauthorized", "Invalid or expired pairing code"),
    }
    let token = pairing::new_token();
    let device_id = uuid::Uuid::new_v4().to_string();
    let name = clean_device_name(&parsed.device_name);
    let (store, hash, id, n) = (ctx.store.clone(), pairing::hash_token(&token), device_id.clone(), name);
    if let Err(res) = blocking(move || store.insert_device(&id, &n, &hash, unix_ms())).await {
        return res;
    }
    json(StatusCode::OK, &serde_json::json!({ "protocol": PROTOCOL_VERSION, "deviceId": device_id, "token": token, "desktopName": ctx.desktop_name }))
}

// ---- WebSocket --------------------------------------------------------------------------------------------------------

struct SocketGuard {
    ctx: Arc<Ctx>,
    device: String,
}

impl SocketGuard {
    fn acquire(ctx: &Arc<Ctx>, device: &str) -> Option<SocketGuard> {
        let mut per_device = lock(&ctx.sockets);
        let mine = per_device.entry(device.to_string()).or_insert(0);
        if *mine >= MAX_SOCKETS_PER_DEVICE || ctx.total_sockets.load(Ordering::SeqCst) >= MAX_SOCKETS {
            return None;
        }
        *mine += 1;
        ctx.total_sockets.fetch_add(1, Ordering::SeqCst);
        ctx.subscribers.fetch_add(1, Ordering::SeqCst);
        Some(SocketGuard { ctx: ctx.clone(), device: device.to_string() })
    }
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        let mut per_device = lock(&self.ctx.sockets);
        if let Some(n) = per_device.get_mut(&self.device) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                per_device.remove(&self.device);
            }
        }
        self.ctx.total_sockets.fetch_sub(1, Ordering::SeqCst);
        self.ctx.subscribers.fetch_sub(1, Ordering::SeqCst);
    }
}

fn events_socket(ctx: Arc<Ctx>, device: String, mut req: Request<Incoming>) -> Resp {
    let h = req.headers();
    let has = |name: header::HeaderName, token: &str| h.get_all(name).iter().filter_map(|v| v.to_str().ok()).any(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case(token)));
    let key = h.get("sec-websocket-key").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let version_ok = h.get("sec-websocket-version").and_then(|v| v.to_str().ok()) == Some("13");
    let Some(key) = key.filter(|_| has(header::UPGRADE, "websocket") && has(header::CONNECTION, "upgrade") && version_ok) else {
        return bad_request("WebSocket upgrade expected");
    };
    let Some(guard) = SocketGuard::acquire(&ctx, &device) else { return too_many(Duration::from_secs(5)) };
    let on_upgrade = hyper::upgrade::on(&mut req);
    let accept = derive_accept_key(key.as_bytes());
    tokio::spawn(async move {
        let Ok(upgraded) = on_upgrade.await else { return };
        let config = WebSocketConfig::default().max_message_size(Some(16 * 1024)).max_frame_size(Some(16 * 1024));
        let ws = WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config)).await;
        socket_loop(ctx, device, ws, guard).await;
    });
    let mut res = Response::new(Full::new(Bytes::new()));
    *res.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    let h = res.headers_mut();
    h.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
    h.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    if let Ok(v) = HeaderValue::from_str(&accept) {
        h.insert("sec-websocket-accept", v);
    }
    res
}

async fn close<S>(ws: &mut WebSocketStream<S>, code: CloseCode, reason: &str)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let _ = ws.send(Message::Close(Some(CloseFrame { code, reason: reason.to_string().into() }))).await;
}

async fn socket_loop<S>(ctx: Arc<Ctx>, device: String, mut ws: WebSocketStream<S>, _guard: SocketGuard)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    // Subscribe before the hello goes out so nothing published in between is missed.
    let mut rx = ctx.events.subscribe();
    let mut revoked = ctx.revoked.subscribe();
    let mut shutdown = ctx.shutdown.clone();
    if ws.send(Message::text(events::hello(PROTOCOL_VERSION))).await.is_err() {
        return;
    }
    let mut tick = interval(PING_EVERY);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last_rx = Instant::now();
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(frame) => {
                    if ws.send(Message::text(frame.to_string())).await.is_err() {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => return close(&mut ws, CloseCode::Again, "too slow, reconnect").await,
                Err(broadcast::error::RecvError::Closed) => return,
            },
            r = revoked.recv() => match r {
                Ok(id) if id != device => {}
                _ => {
                    // Either this device, or the notice channel lagged: the database decides.
                    let store = ctx.store.clone();
                    let id = device.clone();
                    if !matches!(blocking(move || store.device_active(&id)).await, Ok(true)) {
                        return close(&mut ws, CloseCode::Policy, "revoked").await;
                    }
                }
            },
            _ = shutdown.changed() => return close(&mut ws, CloseCode::Away, "server stopping").await,
            msg = ws.next() => match msg {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                // Pings are answered by the protocol layer; everything the phone sends only counts as a sign of life.
                Some(Ok(_)) => last_rx = Instant::now(),
            },
            _ = tick.tick() => {
                if last_rx.elapsed() > SOCKET_IDLE {
                    return close(&mut ws, CloseCode::Away, "idle").await;
                }
                let store = ctx.store.clone();
                let id = device.clone();
                if !matches!(blocking(move || store.device_active(&id)).await, Ok(true)) {
                    return close(&mut ws, CloseCode::Policy, "revoked").await;
                }
                if ws.send(Message::Ping(Bytes::new())).await.is_err() {
                    return;
                }
            }
        }
    }
}

/// Polls the database while somebody listens and publishes what changed.
pub async fn poller(ctx: Arc<Ctx>) {
    let mut shutdown = ctx.shutdown.clone();
    let mut tick = interval(POLL_EVERY);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut detector: Option<Detector> = None;
    loop {
        tokio::select! {
            _ = shutdown.changed() => return,
            _ = tick.tick() => {}
        }
        if ctx.subscribers.load(Ordering::SeqCst) == 0 {
            detector = None;
            continue;
        }
        let (store, board, previous) = (ctx.store.clone(), ctx.board.clone(), detector.take());
        let result = blocking(move || {
            let mut d = match previous {
                Some(d) => d,
                None => Detector::baseline(&store, &board)?,
            };
            let frames = d.poll(&store, &board)?;
            Ok((d, frames))
        })
        .await;
        if let Ok((d, frames)) = result {
            detector = Some(d);
            for frame in frames {
                let _ = ctx.events.send(Arc::from(frame));
            }
        }
    }
}

// ---- Listener ---------------------------------------------------------------------------------------------------------

pub async fn serve(listener: TcpListener, acceptor: TlsAcceptor, ctx: Arc<Ctx>) {
    let mut shutdown = ctx.shutdown.clone();
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let (tcp, peer) = tokio::select! {
            _ = shutdown.changed() => return,
            accepted = listener.accept() => match accepted {
                Ok(pair) => pair,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            },
        };
        // Outside the private ranges, or past the connection budget: dropped before any TLS work.
        if !net::peer_allowed(peer.ip(), ctx.allow_loopback) {
            continue;
        }
        let Ok(permit) = permits.clone().try_acquire_owned() else { continue };
        let (acceptor, ctx, mut shutdown) = (acceptor.clone(), ctx.clone(), ctx.shutdown.clone());
        tokio::spawn(async move {
            let _permit = permit;
            let Ok(Ok(tls)) = timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(tcp)).await else { return };
            let ip = peer.ip();
            let service = service_fn(move |req| handle(ctx.clone(), ip, req));
            let conn = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_READ_TIMEOUT)
                .max_buf_size(64 * 1024)
                .serve_connection(TokioIo::new(tls), service)
                .with_upgrades();
            tokio::select! {
                _ = conn => {}
                _ = shutdown.changed() => {}
            }
        });
    }
}
