//! Loopback redirect receiver for the MCP OAuth sign-in (authorization code flow with PKCE, RFC 8252 section 7.3).
//!
//! `oauth_loopback_start` binds `127.0.0.1` on a random port and returns it; the TS side builds the redirect URI
//! `http://127.0.0.1:<port>/callback`, opens the system browser and calls `oauth_loopback_wait`. The listener accepts
//! only `GET /callback` with a `Host` header naming exactly this address and port (a DNS-rebinding guard), compares
//! `state` with the value the caller chose, and ends after the first usable request: the authorization code, an
//! authorization error, a state mismatch (fail closed), the deadline or `oauth_loopback_cancel`. Other paths (a
//! favicon request, say) are answered 404 and ignored. The code itself is returned to the caller and never logged; the
//! pages served contain no request data.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

const MAX_LISTENERS: usize = 4;
const MIN_STATE_LEN: usize = 16;
const MAX_HEAD: usize = 8 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 5 * 60_000;
const MAX_TIMEOUT_MS: u64 = 10 * 60_000;

type Outcome = Result<String, String>;

struct Entry {
    result: Mutex<Option<Outcome>>,
    done: Condvar,
    cancel: AtomicBool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Started {
    pub id: String,
    pub port: u16,
}

#[derive(Default)]
pub struct Loopback {
    entries: Mutex<HashMap<String, Arc<Entry>>>,
    next: Mutex<u64>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn finish(e: &Entry, r: Outcome) {
    let mut slot = lock(&e.result);
    if slot.is_none() {
        *slot = Some(r);
    }
    e.done.notify_all();
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() && hex(b[i + 1]).is_some() && hex(b[i + 2]).is_some() => {
                out.push(hex(b[i + 1]).unwrap() * 16 + hex(b[i + 2]).unwrap());
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(query: &str, name: &str) -> Option<String> {
    query
        .split('&')
        .map(|kv| kv.split_once('=').unwrap_or((kv, "")))
        .find(|(k, _)| percent_decode(k) == name)
        .map(|(_, v)| percent_decode(v))
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let msg = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(msg.as_bytes());
    let _ = stream.flush();
}

fn page(title: &str, text: &str) -> String {
    format!("<!doctype html><meta charset=utf-8><title>{title}</title><body style=\"font:16px system-ui;margin:3em auto;max-width:28em\"><h3>{title}</h3><p>{text}</p>")
}

enum Verdict {
    /// Not our request: ignore and keep listening.
    Ignore,
    Done(Outcome),
}

/// Reads one request head (bounded, with a short read deadline) and decides what it means.
fn handle(stream: &mut TcpStream, port: u16, expected_state: &str) -> Verdict {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < MAX_HEAD {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let head = String::from_utf8_lossy(&buf).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let host = lines.find_map(|l| {
        l.split_once(':')
            .filter(|(k, _)| k.eq_ignore_ascii_case("host"))
            .map(|(_, v)| v.trim().to_string())
    });
    let mut parts = request_line.split(' ');
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if method != "GET" || host.as_deref() != Some(&format!("127.0.0.1:{port}")) {
        respond(
            stream,
            "400 Bad Request",
            &page(
                "Bad request",
                "This address only receives the sign-in redirect.",
            ),
        );
        return Verdict::Ignore;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/callback" {
        respond(stream, "404 Not Found", &page("Not found", "Nothing here."));
        return Verdict::Ignore;
    }
    // Compare the state before anything else is trusted; a mismatch ends the attempt.
    let state = query_param(query, "state").unwrap_or_default();
    if state.len() != expected_state.len()
        || state
            .bytes()
            .zip(expected_state.bytes())
            .fold(0u8, |a, (x, y)| a | (x ^ y))
            != 0
    {
        respond(stream, "400 Bad Request", &page("Sign-in failed", "The response did not match this sign-in attempt. Close this tab and try again from Gustaf."));
        return Verdict::Done(Err(
            "state mismatch: the redirect did not belong to this sign-in".into(),
        ));
    }
    if let Some(err) = query_param(query, "error") {
        respond(
            stream,
            "400 Bad Request",
            &page(
                "Sign-in was not completed",
                "You can close this tab and return to Gustaf.",
            ),
        );
        let err: String = err
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
            .take(64)
            .collect();
        return Verdict::Done(Err(format!("authorization denied: {err}")));
    }
    match query_param(query, "code").filter(|c| !c.is_empty() && c.len() <= 4096) {
        Some(code) => {
            respond(
                stream,
                "200 OK",
                &page("Signed in", "You can close this tab and return to Gustaf."),
            );
            Verdict::Done(Ok(code))
        }
        None => {
            respond(
                stream,
                "400 Bad Request",
                &page(
                    "Sign-in failed",
                    "The redirect carried no authorization code.",
                ),
            );
            Verdict::Done(Err("the redirect carried no authorization code".into()))
        }
    }
}

impl Loopback {
    /// Binds a listener and starts waiting for the redirect in the background.
    pub fn start(&self, state: &str, timeout: Duration) -> Result<Started, String> {
        if state.len() < MIN_STATE_LEN || state.len() > 512 || !state.is_ascii() {
            return Err("invalid OAuth state".into());
        }
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("could not open the local redirect listener: {e}"))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let entry = Arc::new(Entry {
            result: Mutex::new(None),
            done: Condvar::new(),
            cancel: AtomicBool::new(false),
        });
        let id = {
            let mut entries = lock(&self.entries);
            if entries.len() >= MAX_LISTENERS {
                return Err("too many sign-ins in progress".into());
            }
            let mut n = lock(&self.next);
            *n += 1;
            let id = format!("oauth{}", *n);
            entries.insert(id.clone(), entry.clone());
            id
        };
        let state = state.to_string();
        std::thread::spawn(move || {
            let deadline = Instant::now() + timeout;
            let outcome = loop {
                if entry.cancel.load(Ordering::SeqCst) {
                    break Err("sign-in cancelled".into());
                }
                if Instant::now() >= deadline {
                    break Err("timed out waiting for the browser sign-in".into());
                }
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if let Verdict::Done(r) = handle(&mut stream, port, &state) {
                            break r;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(25))
                    }
                    Err(e) => break Err(format!("redirect listener failed: {e}")),
                }
            };
            // wait() must not return while the redirect port is still open.
            drop(listener);
            finish(&entry, outcome);
        });
        Ok(Started { id, port })
    }

    /// Blocks until the listener finished and returns the authorization code (or why there is none).
    pub fn wait(&self, id: &str) -> Outcome {
        let entry = lock(&self.entries)
            .get(id)
            .cloned()
            .ok_or("unknown sign-in")?;
        let mut slot = lock(&entry.result);
        while slot.is_none() {
            slot = entry.done.wait(slot).unwrap_or_else(|e| e.into_inner());
        }
        let r = slot.take().unwrap();
        drop(slot);
        lock(&self.entries).remove(id);
        r
    }

    pub fn cancel(&self, id: &str) {
        if let Some(e) = lock(&self.entries).get(id) {
            e.cancel.store(true, Ordering::SeqCst);
        }
    }
}

fn global() -> &'static Loopback {
    static G: OnceLock<Loopback> = OnceLock::new();
    G.get_or_init(Loopback::default)
}

#[tauri::command]
pub fn oauth_loopback_start(state: String, timeout_ms: Option<u64>) -> Result<Started, String> {
    global().start(
        &state,
        Duration::from_millis(
            timeout_ms
                .unwrap_or(DEFAULT_TIMEOUT_MS)
                .clamp(1_000, MAX_TIMEOUT_MS),
        ),
    )
}

#[tauri::command]
pub async fn oauth_loopback_wait(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || global().wait(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn oauth_loopback_cancel(id: String) {
    global().cancel(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE: &str = "state-0123456789abcdef";

    fn get(port: u16, target: &str, host: Option<&str>) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let host = host
            .map(str::to_string)
            .unwrap_or(format!("127.0.0.1:{port}"));
        write!(
            s,
            "GET {target} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    #[test]
    fn success_returns_the_code_and_ignores_other_requests() {
        let lb = Loopback::default();
        let st = lb.start(STATE, Duration::from_secs(10)).unwrap();
        assert!(get(st.port, "/favicon.ico", None).starts_with("HTTP/1.1 404"));
        // A rebinding-style request with a foreign Host header is refused and does not end the attempt.
        assert!(get(
            st.port,
            &format!("/callback?code=evil&state={STATE}"),
            Some("evil.example")
        )
        .starts_with("HTTP/1.1 400"));
        let reply = get(
            st.port,
            &format!("/callback?code=a%2Fb+c&state={STATE}"),
            None,
        );
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(
            !reply.contains("a/b"),
            "the page must not echo request data"
        );
        assert_eq!(lb.wait(&st.id).unwrap(), "a/b c");
        assert!(lb.wait(&st.id).is_err(), "a finished sign-in is forgotten");
    }

    #[test]
    fn state_mismatch_fails_closed() {
        let lb = Loopback::default();
        let st = lb.start(STATE, Duration::from_secs(10)).unwrap();
        assert!(get(
            st.port,
            "/callback?code=abc&state=other-state-0123456789",
            None
        )
        .starts_with("HTTP/1.1 400"));
        let err = lb.wait(&st.id).unwrap_err();
        assert!(err.contains("state mismatch"), "{err}");
        let st2 = lb.start(STATE, Duration::from_secs(10)).unwrap();
        get(st2.port, "/callback?code=abc", None);
        assert!(lb.wait(&st2.id).unwrap_err().contains("state mismatch"));
    }

    #[test]
    fn authorization_errors_and_missing_codes() {
        let lb = Loopback::default();
        let st = lb.start(STATE, Duration::from_secs(10)).unwrap();
        get(
            st.port,
            &format!("/callback?error=access_denied&error_description=no&state={STATE}"),
            None,
        );
        assert_eq!(
            lb.wait(&st.id).unwrap_err(),
            "authorization denied: access_denied"
        );
        let st = lb.start(STATE, Duration::from_secs(10)).unwrap();
        get(st.port, &format!("/callback?state={STATE}"), None);
        assert!(lb
            .wait(&st.id)
            .unwrap_err()
            .contains("no authorization code"));
    }

    #[test]
    fn times_out_and_cancels() {
        let lb = Loopback::default();
        let st = lb.start(STATE, Duration::from_millis(200)).unwrap();
        let t = Instant::now();
        assert!(lb.wait(&st.id).unwrap_err().contains("timed out"));
        assert!(t.elapsed() < Duration::from_secs(3));
        // The port is released after the end. Tests run in parallel and the OS may hand the same ephemeral port to another
        // test's short-lived listener, so allow a moment for it to go before calling the port still held.
        let released = (0..40).any(|_| {
            if TcpStream::connect(("127.0.0.1", st.port)).is_err() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
            false
        });
        assert!(released);
        let st = lb.start(STATE, Duration::from_secs(30)).unwrap();
        lb.cancel(&st.id);
        assert!(lb.wait(&st.id).unwrap_err().contains("cancelled"));
    }

    #[test]
    fn binds_loopback_only_and_validates_state() {
        let lb = Loopback::default();
        assert!(lb.start("short", Duration::from_secs(1)).is_err());
        let st = lb.start(STATE, Duration::from_millis(300)).unwrap();
        // Different sign-ins get different ports, and the port is taken while waiting.
        let st2 = lb.start(STATE, Duration::from_millis(300)).unwrap();
        assert_ne!(st.port, st2.port);
        assert!(TcpListener::bind(("127.0.0.1", st.port)).is_err());
        let _ = lb.wait(&st.id);
        let _ = lb.wait(&st2.id);
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("a%2Fb+c%zz%4"), "a/b c%zz%4");
        assert_eq!(query_param("x=1&state=a%20b", "state").unwrap(), "a b");
        assert!(query_param("x=1", "state").is_none());
    }
}
