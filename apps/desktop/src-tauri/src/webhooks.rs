//! Webhook triggers for scheduled prompts (T12). A small HTTP server on 127.0.0.1 only (reach it from outside through
//! your own tunnel), started by the UI when a webhook is switched on. `POST /hooks/<id>` with a GitHub-style
//! `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body>` made with that hook's secret is accepted (202) and reported
//! to the UI as a `webhook-delivery` event; the UI decides whether the schedule runs. Unknown ids are 404, a bad
//! signature 401, other methods 405, bodies over 256 KB 413. Nothing is run here.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Emitter, State};

const MAX_BODY: usize = 256 * 1024;
const PREVIEW: usize = 4000;

#[derive(Deserialize, Clone)]
pub struct Hook {
    id: String,
    secret: String,
}

#[derive(Serialize, Clone)]
pub struct Delivery {
    id: String,
    at: u64,
    status: u16,
    event: String,
    delivery: String,
    preview: String,
}

#[derive(Default)]
pub struct Webhooks(Mutex<Option<Running>>);

struct Running {
    port: u16,
    server: Arc<tiny_http::Server>,
    hooks: Arc<Mutex<HashMap<String, String>>>,
}

pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let (mut ipad, mut opad) = ([0x36u8; 64], [0x5cu8; 64]);
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let inner = Sha256::new().chain_update(ipad).chain_update(msg).finalize();
    Sha256::new().chain_update(opad).chain_update(inner).finalize().into()
}

/// `sha256=<64 hex>` made with `secret` over `body`, compared in constant time.
pub fn signature_ok(secret: &str, body: &[u8], header: Option<&str>) -> bool {
    let Some(hex) = header.and_then(|h| h.trim().strip_prefix("sha256=")) else { return false };
    if hex.len() != 64 || secret.is_empty() {
        return false;
    }
    let expected: String = hmac_sha256(secret.as_bytes(), body).iter().map(|b| format!("{b:02x}")).collect();
    expected.as_bytes().ct_eq(hex.to_ascii_lowercase().as_bytes()).into()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn header(req: &tiny_http::Request, name: &str) -> Option<String> {
    req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str().chars().take(200).collect())
}

fn handle(mut req: tiny_http::Request, hooks: &Mutex<HashMap<String, String>>, emit: &dyn Fn(Delivery)) {
    let respond = |req: tiny_http::Request, code: u16, text: &str| { let _ = req.respond(tiny_http::Response::from_string(text).with_status_code(code)); };
    let path = req.url().split('?').next().unwrap_or("").to_string();
    let Some(id) = path.strip_prefix("/hooks/").filter(|id| !id.is_empty() && id.len() <= 100 && !id.contains('/')) else { return respond(req, 404, "not found") };
    let id = id.to_string();
    let secret = hooks.lock().ok().and_then(|h| h.get(&id).cloned());
    let Some(secret) = secret else { return respond(req, 404, "not found") };
    if req.method() != &tiny_http::Method::Post {
        return respond(req, 405, "POST only");
    }
    if req.body_length().unwrap_or(0) > MAX_BODY {
        return respond(req, 413, "too large");
    }
    let mut body = Vec::new();
    if req.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut body).is_err() || body.len() > MAX_BODY {
        return respond(req, 413, "too large");
    }
    let ok = signature_ok(&secret, &body, header(&req, "X-Hub-Signature-256").as_deref());
    let delivery = Delivery {
        id: id.clone(),
        at: now_ms(),
        status: if ok { 202 } else { 401 },
        event: header(&req, "X-GitHub-Event").unwrap_or_default(),
        delivery: header(&req, "X-GitHub-Delivery").unwrap_or_default(),
        preview: if ok { String::from_utf8_lossy(&body).chars().take(PREVIEW).collect() } else { String::new() },
    };
    emit(delivery);
    respond(req, if ok { 202 } else { 401 }, if ok { "accepted" } else { "bad signature" });
}

/// Starts the server (or updates its hooks when it already runs on the same port); returns the port.
#[tauri::command]
pub fn webhook_serve(app: AppHandle, state: State<'_, Webhooks>, port: u16, hooks: Vec<Hook>) -> Result<u16, String> {
    let map: HashMap<String, String> = hooks.into_iter().filter(|h| h.secret.len() >= 16).map(|h| (h.id, h.secret)).collect();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(r) = guard.as_ref() {
        if r.port == port || port == 0 {
            *r.hooks.lock().map_err(|e| e.to_string())? = map;
            return Ok(r.port);
        }
        r.server.unblock();
        *guard = None;
    }
    let server = Arc::new(tiny_http::Server::http(("127.0.0.1", port)).map_err(|e| format!("Port {port}: {e}"))?);
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("no port")?;
    let hooks = Arc::new(Mutex::new(map));
    let (s, h) = (server.clone(), hooks.clone());
    std::thread::spawn(move || loop {
        match s.recv_timeout(Duration::from_millis(500)) {
            Ok(Some(req)) => handle(req, &h, &|d| { let _ = app.emit("webhook-delivery", d); }),
            Ok(None) => {}
            Err(_) => break,
        }
        if Arc::strong_count(&s) == 1 {
            break;
        }
    });
    *guard = Some(Running { port, server, hooks });
    Ok(port)
}

#[tauri::command]
pub fn webhook_stop(state: State<'_, Webhooks>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(r) = guard.take() {
        r.server.unblock();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc4231_and_github_signatures_are_checked() {
        let mac: String = hmac_sha256(b"key", b"The quick brown fox jumps over the lazy dog").iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(mac, "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
        let body = b"{\"zen\":\"x\"}";
        let sig = format!("sha256={}", hmac_sha256(b"s3cret-0123456789", body).iter().map(|b| format!("{b:02x}")).collect::<String>());
        assert!(signature_ok("s3cret-0123456789", body, Some(&sig)));
        assert!(signature_ok("s3cret-0123456789", body, Some(&sig.to_uppercase().replace("SHA256=", "sha256="))));
        assert!(!signature_ok("other-secret-0000", body, Some(&sig)));
        assert!(!signature_ok("s3cret-0123456789", b"{}", Some(&sig)));
        assert!(!signature_ok("s3cret-0123456789", body, None));
        assert!(!signature_ok("s3cret-0123456789", body, Some("sha1=abc")));
        assert!(!signature_ok("", body, Some(&sig)));
    }

    #[test]
    fn server_accepts_signed_posts_only() {
        use std::io::Write;
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let hooks = Mutex::new(HashMap::from([("abc".to_string(), "s3cret-0123456789".to_string())]));
        let send = |raw: String| {
            let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            c.write_all(raw.as_bytes()).unwrap();
            c
        };
        let body = "{\"action\":\"opened\"}";
        let sig = format!("sha256={}", hmac_sha256(b"s3cret-0123456789", body.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>());
        let cases = [
            (format!("POST /hooks/abc HTTP/1.1\r\nHost: x\r\nConnection: close\r\nX-Hub-Signature-256: {sig}\r\nX-GitHub-Event: pull_request\r\nContent-Length: {}\r\n\r\n{body}", body.len()), 202),
            (format!("POST /hooks/abc HTTP/1.1\r\nHost: x\r\nConnection: close\r\nX-Hub-Signature-256: sha256={}\r\nContent-Length: {}\r\n\r\n{body}", "0".repeat(64), body.len()), 401),
            (format!("POST /hooks/nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()), 404),
            ("GET /hooks/abc HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".to_string(), 405),
        ];
        let delivered = Mutex::new(Vec::new());
        for (raw, want) in cases {
            let mut c = send(raw);
            let req = server.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
            handle(req, &hooks, &|d| delivered.lock().unwrap().push(d));
            let mut resp = String::new();
            c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            c.read_to_string(&mut resp).ok();
            assert!(resp.starts_with(&format!("HTTP/1.1 {want}")), "{want}: {resp}");
        }
        let d = delivered.lock().unwrap();
        assert_eq!(d.iter().map(|d| d.status).collect::<Vec<_>>(), vec![202, 401], "unknown ids and wrong methods are not reported");
        assert_eq!((d[0].event.as_str(), d[0].preview.as_str()), ("pull_request", body));
        assert_eq!(d[1].preview, "", "a rejected body is never passed on");
    }
}

