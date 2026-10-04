//! Mobile companion server (slice 1: read-only). A local HTTPS + WebSocket server the phone app talks to over the LAN.
//! OFF by default; Settings > Mobile turns it on. Design, threat model and limits: `docs/features/mobile-server.md`.
//!
//! * `net`      private-LAN address rules (never 0.0.0.0, never a public address) and interface detection
//! * `tls`      self-signed certificate in the app data directory; the phone pins its SHA-256 fingerprint
//! * `pairing`  one-time codes, device tokens (only hashes are stored), failure limiter (pure, unit-tested)
//! * `data`     read-only access to chats/projects/messages, protocol shaping, limits, redaction
//! * `redact`   secret redaction (port of `redactSecrets` in `src/lib/exportChats.ts`)
//! * `events`   run-status board fed by the webview, change detector behind the WebSocket
//! * `http`     routing, authentication, the WebSocket and the accept loop
//!
//! This file is the lifecycle (`start`, `Handle`) and the Tauri commands the Settings page uses.

mod data;
mod events;
mod http;
mod net;
mod pairing;
mod redact;
mod tls;

#[cfg(test)]
mod tests;

use crate::db::Db;
use events::StatusBoard;
use http::Ctx;
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tokio::sync::watch;
use tokio_rustls::TlsAcceptor;

/// Wire protocol version (`PROTOCOL_VERSION` in `packages/protocol/src/index.ts`; a node test keeps the two equal).
pub const PROTOCOL_VERSION: u32 = 1;
/// Row in `settings` (JSON `{enabled, port}`).
const SETTINGS_KEY: &str = "mobileServer";

pub struct Config {
    /// The private LAN address to listen on; detected when `None`.
    pub bind: Option<Ipv4Addr>,
    /// 0 picks a free port.
    pub port: u16,
    /// Tests only: allow 127.0.0.1 as bind address and peer. The Tauri commands never set this.
    pub allow_loopback: bool,
    pub desktop_name: String,
    pub app_version: String,
}

/// A running server. Dropping it (or `stop`) closes the listener and every connection.
pub struct Handle {
    runtime: Option<tokio::runtime::Runtime>,
    shutdown: watch::Sender<bool>,
    ctx: Arc<Ctx>,
    addr: SocketAddr,
    fingerprint: String,
}

pub struct IssuedCode {
    pub code: String,
    pub expires_at: i64,
}

fn io_err(what: &str, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::AddrInUse {
        format!("port in use: {what}")
    } else {
        format!("{what}: {e}")
    }
}

/// Starts the server. Errors (not private, port busy, no LAN address, files unusable) come back as messages.
pub fn start(cfg: &Config, db_path: &Path, data_dir: &Path, board: Arc<StatusBoard>) -> Result<Handle, String> {
    let ip = match cfg.bind {
        Some(ip) => net::validate_bind(IpAddr::V4(ip), cfg.allow_loopback)?,
        None => net::detect_lan_ip().ok_or("no private LAN address found; connect to a Wi-Fi or Ethernet network first")?,
    };
    let identity = tls::load_or_create(data_dir)?;
    let tls_config = tls::server_config(&identity)?;
    let store = Arc::new(data::Store::open(db_path)?);
    let std_listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(ip), cfg.port)).map_err(|e| io_err(&format!("{ip}:{}", cfg.port), e))?;
    std_listener.set_nonblocking(true).map_err(|e| io_err("listener", e))?;
    let addr = std_listener.local_addr().map_err(|e| io_err("listener", e))?;

    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_name("mobile-server").enable_all().build().map_err(|e| io_err("runtime", e))?;
    let (shutdown, shutdown_rx) = watch::channel(false);
    let ctx = Arc::new(Ctx::new(store, board, shutdown_rx, cfg.desktop_name.clone(), cfg.app_version.clone(), cfg.allow_loopback));
    {
        let _enter = runtime.enter();
        let listener = tokio::net::TcpListener::from_std(std_listener).map_err(|e| io_err("listener", e))?;
        runtime.spawn(http::serve(listener, TlsAcceptor::from(tls_config), ctx.clone()));
        runtime.spawn(http::poller(ctx.clone()));
    }
    Ok(Handle { runtime: Some(runtime), shutdown, ctx, addr, fingerprint: identity.fingerprint })
}

impl Handle {
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    /// A fresh pairing code (the previous one stops working).
    pub fn issue_code(&self) -> IssuedCode {
        let (code, expires) = self.ctx.pairing.lock().unwrap_or_else(|p| p.into_inner()).issue(Instant::now());
        IssuedCode { code, expires_at: expiry_ms(expires) }
    }

    pub fn active_code(&self) -> Option<IssuedCode> {
        let pairing = self.ctx.pairing.lock().unwrap_or_else(|p| p.into_inner());
        pairing.active(Instant::now()).map(|(code, expires)| IssuedCode { code: code.to_string(), expires_at: expiry_ms(expires) })
    }

    pub fn cancel_code(&self) {
        self.ctx.pairing.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }

    pub fn devices(&self) -> Result<Vec<data::Device>, String> {
        self.ctx.store.list_devices()
    }

    /// Revokes a device: its next request gets 401 and its sockets close.
    pub fn revoke(&self, id: &str) -> Result<bool, String> {
        let revoked = self.ctx.store.revoke_device(id, http::unix_ms())?;
        if revoked {
            self.ctx.device_revoked(id);
        }
        Ok(revoked)
    }

    /// Closes the listener and every connection and waits (briefly) for the threads to finish.
    pub fn stop(mut self) {
        self.close(Some(Duration::from_secs(2)));
    }

    fn close(&mut self, wait: Option<Duration>) {
        let _ = self.shutdown.send(true);
        if let Some(rt) = self.runtime.take() {
            match wait {
                Some(w) => rt.shutdown_timeout(w),
                None => rt.shutdown_background(),
            }
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.close(None);
    }
}

fn expiry_ms(expires: Instant) -> i64 {
    http::unix_ms() + expires.saturating_duration_since(Instant::now()).as_millis() as i64
}

// ---- Tauri side -------------------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct MobileServer {
    handle: Mutex<Option<Handle>>,
    board: Arc<StatusBoard>,
    last_error: Mutex<Option<String>>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct Saved {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    code: String,
    expires_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The saved switch: the server starts with the app while this is on.
    enabled: bool,
    running: bool,
    host: Option<String>,
    port: Option<u16>,
    /// Port remembered for the next start.
    saved_port: u16,
    fingerprint: Option<String>,
    protocol: u32,
    devices: usize,
    pairing: Option<PairingInfo>,
    error: Option<String>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn load_saved(db: &Db) -> Saved {
    let conn = lock(&db.0);
    conn.query_row("select value from settings where key = ?", [SETTINGS_KEY], |r| r.get::<_, String>(0)).ok().and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

fn save(db: &Db, saved: &Saved) {
    let conn = lock(&db.0);
    let value = serde_json::to_string(saved).unwrap_or_default();
    if let Err(e) = conn.execute("insert into settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", rusqlite::params![SETTINGS_KEY, value]) {
        eprintln!("mobile server: cannot save settings: {e}");
    }
}

fn desktop_name() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer is valid for its length and gethostname writes at most that many bytes.
        let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
        if ok {
            let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
            let name = String::from_utf8_lossy(&buf[..end]).trim().to_string();
            if !name.is_empty() {
                return data::clip_chars(&name, 64);
            }
        }
    }
    #[cfg(windows)]
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        if !name.trim().is_empty() {
            return data::clip_chars(name.trim(), 64);
        }
    }
    "Gustaf".to_string()
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn status_of(server: &MobileServer, db: &Db) -> Status {
    let saved = load_saved(db);
    let guard = lock(&server.handle);
    let error = lock(&server.last_error).clone();
    match guard.as_ref() {
        Some(h) => Status {
            enabled: saved.enabled,
            running: true,
            host: Some(h.addr().ip().to_string()),
            port: Some(h.addr().port()),
            saved_port: saved.port,
            fingerprint: Some(h.fingerprint().to_string()),
            protocol: PROTOCOL_VERSION,
            devices: h.devices().map(|d| d.len()).unwrap_or(0),
            pairing: h.active_code().map(|c| PairingInfo { code: c.code, expires_at: c.expires_at }),
            error,
        },
        None => Status {
            enabled: saved.enabled,
            running: false,
            host: None,
            port: None,
            saved_port: saved.port,
            fingerprint: None,
            protocol: PROTOCOL_VERSION,
            devices: count_devices(db),
            pairing: None,
            error,
        },
    }
}

fn count_devices(db: &Db) -> usize {
    lock(&db.0).query_row("select count(*) from paired_devices where revoked_at is null", [], |r| r.get::<_, i64>(0)).unwrap_or(0) as usize
}

fn start_with(app: &AppHandle, server: &MobileServer, db: &Db, port: u16, explicit: bool) -> Result<(), String> {
    let dir = data_dir(app)?;
    let board = server.board.clone();
    let mk = |port: u16| Config { bind: None, port, allow_loopback: false, desktop_name: desktop_name(), app_version: app.package_info().version.to_string() };
    let handle = match start(&mk(port), &dir.join("app.db"), &dir, board.clone()) {
        // A remembered port that is taken now is not an error: pick another and remember that one.
        Err(e) if !explicit && port != 0 && e.starts_with("port in use") => start(&mk(0), &dir.join("app.db"), &dir, board)?,
        other => other?,
    };
    let _ = db; // saved by the caller once the actual port is known
    *lock(&server.handle) = Some(handle);
    Ok(())
}

/// `port`: `None` = the remembered one (or a random free one the first time), `Some(0)` = a new random one, `Some(n)` = exactly n.
#[tauri::command]
pub fn mobile_server_start(app: AppHandle, server: State<MobileServer>, db: State<Db>, port: Option<u16>) -> Result<Status, String> {
    if lock(&server.handle).is_none() {
        let saved = load_saved(&db);
        let (want, explicit) = match port {
            Some(p) => (p, p != 0),
            None => (saved.port, false),
        };
        match start_with(&app, &server, &db, want, explicit) {
            Ok(()) => {
                *lock(&server.last_error) = None;
                let actual = lock(&server.handle).as_ref().map(|h| h.addr().port()).unwrap_or(0);
                save(&db, &Saved { enabled: true, port: actual });
            }
            Err(e) => {
                *lock(&server.last_error) = Some(e.clone());
                return Err(e);
            }
        }
    }
    Ok(status_of(&server, &db))
}

#[tauri::command]
pub fn mobile_server_stop(server: State<MobileServer>, db: State<Db>) -> Status {
    let handle = lock(&server.handle).take();
    if let Some(h) = handle {
        h.stop();
    }
    *lock(&server.last_error) = None;
    let mut saved = load_saved(&db);
    saved.enabled = false;
    save(&db, &saved);
    status_of(&server, &db)
}

#[tauri::command]
pub fn mobile_server_status(server: State<MobileServer>, db: State<Db>) -> Status {
    status_of(&server, &db)
}

/// Issues a pairing code (replacing any earlier one). Only while the server runs.
#[tauri::command]
pub fn mobile_pairing_start(server: State<MobileServer>, db: State<Db>) -> Result<Status, String> {
    match lock(&server.handle).as_ref() {
        Some(h) => {
            h.issue_code();
        }
        None => return Err("The mobile server is not running".to_string()),
    }
    Ok(status_of(&server, &db))
}

#[tauri::command]
pub fn mobile_pairing_cancel(server: State<MobileServer>, db: State<Db>) -> Status {
    if let Some(h) = lock(&server.handle).as_ref() {
        h.cancel_code();
    }
    status_of(&server, &db)
}

#[tauri::command]
pub fn mobile_devices(server: State<MobileServer>, db: State<Db>) -> Result<Vec<data::Device>, String> {
    if let Some(h) = lock(&server.handle).as_ref() {
        return h.devices();
    }
    let conn = lock(&db.0);
    let mut stmt = conn
        .prepare("select id, name, created_at, last_seen_at from paired_devices where revoked_at is null order by created_at desc, rowid desc")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(data::Device { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, last_seen_at: r.get(3)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Revokes a device (also while the server is stopped; then it simply cannot connect when the server starts again).
#[tauri::command]
pub fn mobile_device_revoke(server: State<MobileServer>, db: State<Db>, id: String) -> Result<bool, String> {
    if let Some(h) = lock(&server.handle).as_ref() {
        return h.revoke(&id);
    }
    let conn = lock(&db.0);
    conn.execute("update paired_devices set revoked_at = ? where id = ? and revoked_at is null", rusqlite::params![http::unix_ms(), id])
        .map(|n| n > 0)
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    chat_id: i64,
    status: String,
}

/// The webview reports which chats are running / waiting for approval / failed / finished unseen (see `events.rs`).
/// Replaces the previous report. Cheap and safe to call whether or not the server runs.
#[tauri::command]
pub fn mobile_report_status(server: State<MobileServer>, statuses: Vec<StatusReport>) {
    server.board.replace(statuses.into_iter().map(|s| (s.chat_id, s.status)));
}

/// Called once at startup: when the switch was left on, the server comes back up.
pub fn init(app: &tauri::App) {
    let handle = app.handle().clone();
    let server = app.state::<MobileServer>();
    let db = app.state::<Db>();
    let saved = load_saved(&db);
    if !saved.enabled {
        return;
    }
    match start_with(&handle, &server, &db, saved.port, false) {
        Ok(()) => {
            let actual = lock(&server.handle).as_ref().map(|h| h.addr().port()).unwrap_or(0);
            save(&db, &Saved { enabled: true, port: actual });
        }
        Err(e) => {
            eprintln!("mobile server: cannot start: {e}");
            *lock(&server.last_error) = Some(e);
        }
    }
}

/// App exit: close the listener and every connection.
pub fn shutdown(app: &AppHandle) {
    if let Some(server) = app.try_state::<MobileServer>() {
        let handle = lock(&server.handle).take();
        if let Some(h) = handle {
            h.stop();
        }
    }
}
