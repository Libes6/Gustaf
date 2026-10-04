//! End-to-end tests: a real server on 127.0.0.1 (loopback allowed only through the test-only config flag), a real
//! TLS client that pins the certificate fingerprint exactly as the phone does, and a real SQLite file.

use super::data::fixtures::{msg, seed, text};
use super::pairing::hash_token;
use super::*;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    runtime::Runtime,
};
use tokio_rustls::{
    client::TlsStream,
    rustls::{
        self,
        client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
        pki_types::{CertificateDer, ServerName, UnixTime},
        DigitallySignedStruct, SignatureScheme,
    },
    TlsConnector,
};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

/// Accepts exactly one certificate: the one whose SHA-256 fingerprint was in the QR code.
#[derive(Debug)]
struct Pinned {
    fingerprint: String,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(&self, end_entity: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        if tls::fingerprint(end_entity) == self.fingerprint {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("fingerprint mismatch".into()))
        }
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

fn connector(fingerprint: &str) -> TlsConnector {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned { fingerprint: fingerprint.to_string(), provider }))
        .with_no_client_auth();
    TlsConnector::from(Arc::new(config))
}

struct Fixture {
    _dir: tempfile::TempDir,
    handle: Option<Handle>,
    conn: Connection,
    rt: Runtime,
    db_path: PathBuf,
    board: Arc<StatusBoard>,
}

struct Reply {
    status: u16,
    head: String,
    body: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.body))
    }
    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_string()))
    }
}

fn config(bind: Option<Ipv4Addr>) -> Config {
    Config { bind, port: 0, allow_loopback: true, desktop_name: "Test Mac".into(), app_version: "9.9.9".into() }
}

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("app.db");
        let conn = crate::db::open(&db_path).unwrap();
        seed(&conn);
        let board = Arc::new(StatusBoard::default());
        let handle = start(&config(Some(Ipv4Addr::LOCALHOST)), &db_path, dir.path(), board.clone()).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        Fixture { _dir: dir, handle: Some(handle), conn, rt, db_path, board }
    }

    fn handle(&self) -> &Handle {
        self.handle.as_ref().unwrap()
    }

    fn fp(&self) -> String {
        self.handle().fingerprint().to_string()
    }

    async fn tls(&self, fp: &str) -> std::io::Result<TlsStream<TcpStream>> {
        let tcp = TcpStream::connect(self.handle().addr()).await?;
        connector(fp).connect(ServerName::try_from("gustaf.local").unwrap(), tcp).await
    }

    fn request(&self, method: &str, path: &str, token: Option<&str>, body: Option<&str>) -> Reply {
        self.request_raw(method, path, token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default(), body)
    }

    fn request_raw(&self, method: &str, path: &str, extra_headers: String, body: Option<&str>) -> Reply {
        self.rt.block_on(async {
            let mut tls = self.tls(&self.fp()).await.expect("TLS with the pinned fingerprint");
            let body = body.unwrap_or("");
            let req = format!("{method} {path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n{extra_headers}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
            tls.write_all(req.as_bytes()).await.unwrap();
            let mut raw = Vec::new();
            let _ = tls.read_to_end(&mut raw).await; // a peer that closes without close_notify is fine here
            let raw = String::from_utf8(raw).unwrap();
            let (head, body) = raw.split_once("\r\n\r\n").expect("a complete response");
            let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
            Reply { status, head: head.to_string(), body: body.to_string() }
        })
    }

    /// Issues a code and pairs; returns `(device id, token)`.
    fn pair(&self, name: &str) -> (String, String) {
        let code = self.handle().issue_code().code;
        let r = self.request("POST", "/v1/pair", None, Some(&json!({ "code": code, "deviceName": name, "protocol": 1 }).to_string()));
        assert_eq!(r.status, 200, "{}", r.body);
        let v = r.json();
        (v["deviceId"].as_str().unwrap().to_string(), v["token"].as_str().unwrap().to_string())
    }

    fn pair_attempt(&self, code: &str) -> Reply {
        self.request("POST", "/v1/pair", None, Some(&json!({ "code": code, "deviceName": "X" }).to_string()))
    }
}

#[test]
fn refuses_to_bind_a_non_private_address() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("app.db");
    crate::db::open(&db_path).unwrap();
    for ip in [Ipv4Addr::UNSPECIFIED, Ipv4Addr::new(8, 8, 8, 8), Ipv4Addr::new(100, 64, 0, 1), Ipv4Addr::new(172, 32, 0, 1)] {
        let r = start(&config(Some(ip)), &db_path, dir.path(), Arc::default());
        assert!(r.is_err(), "{ip} must be refused");
    }
    // Without the test flag even loopback is refused.
    let strict = Config { allow_loopback: false, ..config(Some(Ipv4Addr::LOCALHOST)) };
    assert!(start(&strict, &db_path, dir.path(), Arc::default()).is_err());
}

#[test]
fn a_busy_port_is_reported_not_taken() {
    let fx = Fixture::new();
    let busy = fx.handle().addr().port();
    let r = start(&Config { port: busy, ..config(Some(Ipv4Addr::LOCALHOST)) }, &fx.db_path, fx._dir.path(), Arc::default());
    assert!(r.err().unwrap().starts_with("port in use"));
}

#[test]
fn pairing_gives_a_token_and_only_its_hash_is_stored() {
    let fx = Fixture::new();
    let (id, token) = fx.pair("Pixel 9");
    assert_eq!(token.len(), 43);
    let (name, stored, last_seen): (String, String, Option<i64>) =
        fx.conn.query_row("select name, token_hash, last_seen_at from paired_devices where id = ?", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!(name, "Pixel 9");
    assert_eq!(stored, hash_token(&token));
    assert_ne!(stored, token);
    assert!(last_seen.is_some());
    let dump: String = fx.conn.query_row("select group_concat(id || name || token_hash || created_at, '|') from paired_devices", [], |r| r.get(0)).unwrap();
    assert!(!dump.contains(&token), "the token itself is never stored");

    let info = fx.request("GET", "/v1/info", Some(&token), None);
    assert_eq!(info.status, 200);
    assert_eq!(info.json(), json!({ "protocol": 1, "app": "Gustaf", "appVersion": "9.9.9", "desktopName": "Test Mac" }));
    assert_eq!(info.header("cache-control").as_deref(), Some("no-store"));
    assert_eq!(fx.handle().devices().unwrap().len(), 1);
}

#[test]
fn pairing_response_has_the_protocol_shape_and_accepts_the_code_in_any_case() {
    let fx = Fixture::new();
    let code = fx.handle().issue_code().code;
    let typed = format!("{}-{}", &code[..4], &code[4..]).to_lowercase();
    let r = fx.request("POST", "/v1/pair", None, Some(&json!({ "code": typed, "deviceName": "  Ph\u{7}one \n 2  ", "publicInfo": { "platform": "ios" } }).to_string()));
    assert_eq!(r.status, 200);
    let v = r.json();
    let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["desktopName", "deviceId", "protocol", "token"]);
    assert_eq!(v["desktopName"], "Test Mac");
    assert_eq!(fx.handle().devices().unwrap()[0].name, "Phone 2", "control characters and extra spaces are dropped");
}

#[test]
fn wrong_reused_and_missing_codes_are_all_the_same_401() {
    let fx = Fixture::new();
    let none = fx.pair_attempt("AAAAAAAA");
    assert_eq!(none.status, 401, "no code was issued");
    let code = fx.handle().issue_code().code;
    let wrong = fx.pair_attempt("ZZZZZZZZ");
    assert_eq!(wrong.status, 401);
    let ok = fx.pair_attempt(&code);
    assert_eq!(ok.status, 200);
    let reused = fx.pair_attempt(&code);
    assert_eq!(reused.status, 401, "single use");
    assert_eq!(none.json(), wrong.json());
    assert_eq!(wrong.json(), reused.json());
}

#[test]
fn malformed_pairing_requests_are_rejected() {
    let fx = Fixture::new();
    let code = fx.handle().issue_code().code;
    // Each rejected request counts as a failed attempt (5 lock the address out), so only four are sent here.
    for body in ["", "not json", "{}", &format!("{{\"code\":\"{code}\",\"deviceName\":\"x\",\"publicInfo\":[1]}}")] {
        assert_eq!(fx.request("POST", "/v1/pair", None, Some(body)).status, 400, "{body}");
    }
    let mismatch = fx.request("POST", "/v1/pair", None, Some(&json!({ "code": code, "deviceName": "x", "protocol": 99 }).to_string()));
    assert_eq!((mismatch.status, mismatch.json()["code"].clone()), (400, json!("version_mismatch")));
    assert_eq!(fx.request("GET", "/v1/pair", None, None).status, 405);
    assert_eq!(fx.pair_attempt(&code).status, 200, "the code survived the malformed requests that did not carry it");
}

#[test]
fn oversized_and_empty_code_pairing_requests_are_rejected() {
    let fx = Fixture::new();
    let code = fx.handle().issue_code().code;
    let huge = format!("{{\"code\":\"{}\",\"deviceName\":\"{}\"}}", code, "a".repeat(10_000));
    assert_eq!(fx.request("POST", "/v1/pair", None, Some(&huge)).status, 400);
    assert_eq!(fx.request("POST", "/v1/pair", None, Some(r#"{"code":"","deviceName":"x"}"#)).status, 400);
    assert_eq!(fx.request("POST", "/v1/pair", None, Some(r#"{"deviceName":"x"}"#)).status, 400);
}

#[test]
fn repeated_wrong_codes_lock_the_address_out_even_for_the_right_code() {
    let fx = Fixture::new();
    let code = fx.handle().issue_code().code;
    for _ in 0..5 {
        assert_eq!(fx.pair_attempt("ZZZZZZZZ").status, 401);
    }
    let locked = fx.pair_attempt(&code);
    assert_eq!(locked.status, 429);
    assert_eq!(locked.json()["code"], "rate_limited");
    let wait: u64 = locked.header("retry-after").unwrap().parse().unwrap();
    assert!((250..=300).contains(&wait), "{wait}");
    assert!(fx.handle().devices().unwrap().is_empty());
}

#[test]
fn every_other_endpoint_needs_a_valid_token_and_fails_the_same_way() {
    let fx = Fixture::new();
    let (_id, token) = fx.pair("P");
    let paths = ["/v1/info", "/v1/projects", "/v1/chats", "/v1/chats/1/messages", "/v1/events", "/v1/nope", "/"];
    let mut bodies = Vec::new();
    for path in paths {
        let flipped = format!("{}{}", if token.starts_with('A') { 'B' } else { 'A' }, &token[1..]);
        // (20 failed checks per minute are allowed before an address is throttled, see `repeated_bad_tokens_are_throttled`)
        let variants = if path == "/v1/info" { vec![None, Some("garbage".to_string()), Some("A".repeat(43)), Some(flipped.clone())] } else { vec![None, Some("garbage".to_string())] };
        for auth in variants {
            let r = fx.request("GET", path, auth.as_deref(), None);
            assert_eq!(r.status, 401, "{path} {auth:?}");
            assert_eq!(r.header("www-authenticate").as_deref(), Some("Bearer"));
            bodies.push(r.body);
        }
    }
    assert!(bodies.windows(2).all(|w| w[0] == w[1]), "one uniform 401 body");
    let r = fx.request_raw("GET", "/v1/info", "Authorization: Basic abc\r\n".into(), None);
    assert_eq!(r.status, 401);
    assert_eq!(fx.request("GET", "/v1/nope", Some(&token), None).status, 404);
    assert_eq!(fx.request("POST", "/v1/projects", Some(&token), Some("{}")).status, 405, "no write endpoints in this slice");
    assert_eq!(fx.request("POST", "/v1/chats/1/messages", Some(&token), Some("{}")).status, 405);
}

#[test]
fn repeated_bad_tokens_are_throttled() {
    let fx = Fixture::new();
    for _ in 0..20 {
        assert_eq!(fx.request("GET", "/v1/info", Some("wrong-token-wrong-token"), None).status, 401);
    }
    assert_eq!(fx.request("GET", "/v1/info", Some("wrong-token-wrong-token"), None).status, 429);
}

#[test]
fn revoking_a_device_rejects_it_at_once() {
    let fx = Fixture::new();
    let (id_a, token_a) = fx.pair("A");
    let (_id_b, token_b) = fx.pair("B");
    assert_eq!(fx.request("GET", "/v1/projects", Some(&token_a), None).status, 200);
    assert!(fx.handle().revoke(&id_a).unwrap());
    assert_eq!(fx.request("GET", "/v1/projects", Some(&token_a), None).status, 401);
    assert_eq!(fx.request("GET", "/v1/projects", Some(&token_b), None).status, 200, "other devices are unaffected");
    assert_eq!(fx.handle().devices().unwrap().len(), 1);
    // Revoked directly in the database (not through the server): rejected as well.
    fx.conn.execute("update paired_devices set revoked_at = 1", []).unwrap();
    assert_eq!(fx.request("GET", "/v1/projects", Some(&token_b), None).status, 401);
}

#[test]
fn read_endpoints_return_protocol_shaped_json() {
    let fx = Fixture::new();
    let (_id, token) = fx.pair("P");
    let get = |path: &str| fx.request("GET", path, Some(&token), None);

    let projects = get("/v1/projects");
    assert_eq!(projects.status, 200);
    assert_eq!(projects.json(), json!([{ "id": 1, "name": "Alpha", "pinned": true }, { "id": 2, "name": "Beta", "pinned": false }]));
    assert!(!projects.body.contains("secret/path"), "project paths stay on the desktop");

    let chats = get("/v1/chats").json();
    assert_eq!(chats.as_array().unwrap().iter().map(|c| c["id"].as_i64().unwrap()).collect::<Vec<_>>(), vec![3, 1]);
    assert_eq!(chats[1], json!({ "id": 1, "projectId": 1, "title": "First chat", "archived": false, "updatedAt": 100, "running": false, "status": "idle" }));
    assert_eq!(get("/v1/chats?project=1").json().as_array().unwrap().len(), 1);
    assert_eq!(get("/v1/chats?archived=1").json().as_array().unwrap().len(), 3);
    assert_eq!(get("/v1/chats?limit=1").json().as_array().unwrap().len(), 1);
    for bad in ["/v1/chats?project=x", "/v1/chats?limit=0", "/v1/chats?archived=maybe", "/v1/chats?project=-1"] {
        assert_eq!(get(bad).status, 400, "{bad}");
    }

    let messages = get("/v1/chats/1/messages").json();
    assert_eq!(messages.as_array().unwrap().len(), 2);
    assert_eq!(messages[0], json!({ "id": 1, "chatId": 1, "role": "user", "text": "hello there", "tools": [], "createdAt": 1_700_000_000_000i64 }));
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(get("/v1/chats/99/messages").status, 404);
    assert_eq!(get("/v1/chats/abc/messages").status, 404);
    assert_eq!(get("/v1/chats/1/messages?limit=0").status, 400);
    assert_eq!(get("/v1/chats/1/messages?before=x").status, 400);
}

#[test]
fn messages_are_paged_bounded_redacted_and_without_images_or_tool_output() {
    let fx = Fixture::new();
    let (_id, token) = fx.pair("P");
    let get = |path: &str| fx.request("GET", path, Some(&token), None);
    for i in 0..130 {
        msg(&fx.conn, 3, "user", vec![text(&format!("m{i}"))], json!({}));
    }
    // limit defaults to 50 and is capped at 100
    assert_eq!(get("/v1/chats/3/messages").json().as_array().unwrap().len(), 50);
    assert_eq!(get("/v1/chats/3/messages?limit=100000").json().as_array().unwrap().len(), 100);
    let page = get("/v1/chats/3/messages?limit=5").json();
    let texts = |v: &Value| v.as_array().unwrap().iter().map(|m| m["text"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(texts(&page), ["m125", "m126", "m127", "m128", "m129"]);
    let first = page[0]["id"].as_i64().unwrap();
    assert_eq!(texts(&get(&format!("/v1/chats/3/messages?limit=2&before={first}")).json()), ["m123", "m124"]);

    msg(&fx.conn, 1, "assistant", vec![
        text("your key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"),
        json!({ "type": "image", "data": "IMAGEBASE64DATA" }),
        json!({ "type": "activity", "id": "a", "name": "Bash", "args": { "command": "echo $TOKEN" }, "status": "success", "output": "PASSWORD=hunter2hunter2 TOOLOUTPUT" }),
        text(&"long ".repeat(10_000)),
    ], json!({}));
    let last = get("/v1/chats/1/messages?limit=1");
    assert!(!last.body.contains("sk-ant"), "secrets are redacted");
    assert!(!last.body.contains("IMAGEBASE64DATA") && !last.body.contains("TOOLOUTPUT") && !last.body.contains("hunter2"));
    let m = &last.json()[0];
    assert!(m["text"].as_str().unwrap().contains("[REDACTED]"));
    assert!(m["text"].as_str().unwrap().chars().count() <= 20_001 + 1 + "[image omitted]".len(), "text is clipped");
    assert_eq!(m["tools"][0], json!({ "id": "a", "tool": "Bash", "summary": "echo $TOKEN", "status": "done" }));
}

#[test]
fn run_status_reported_by_the_webview_shows_in_the_chat_list() {
    let fx = Fixture::new();
    let (_id, token) = fx.pair("P");
    fx.board.replace([(1, "waiting".to_string()), (3, "failed".to_string())]);
    let chats = fx.request("GET", "/v1/chats", Some(&token), None).json();
    assert_eq!((chats[0]["id"].as_i64(), chats[0]["status"].as_str(), chats[0]["running"].as_bool()), (Some(3), Some("failed"), Some(false)));
    assert_eq!((chats[1]["id"].as_i64(), chats[1]["status"].as_str(), chats[1]["running"].as_bool()), (Some(1), Some("waiting"), Some(true)));
}

#[test]
fn a_pinned_client_rejects_any_other_certificate() {
    let fx = Fixture::new();
    let wrong = "0".repeat(64);
    let r = fx.rt.block_on(fx.tls(&wrong));
    assert!(r.is_err(), "a wrong fingerprint must fail the handshake");
}

#[test]
fn plain_http_and_garbage_do_not_get_an_answer() {
    let fx = Fixture::new();
    let addr = fx.handle().addr();
    fx.rt.block_on(async {
        let mut tcp = TcpStream::connect(addr).await.unwrap();
        tcp.write_all(b"GET /v1/info HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
        let mut buf = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), tcp.read_to_end(&mut buf)).await;
        assert!(!String::from_utf8_lossy(&buf).contains("200 OK"));
    });
}

type Ws = tokio_tungstenite::WebSocketStream<TlsStream<TcpStream>>;

impl Fixture {
    async fn ws(&self, token: Option<&str>) -> Result<Ws, tokio_tungstenite::tungstenite::Error> {
        let tls = self.tls(&self.fp()).await.unwrap();
        let mut req = format!("wss://127.0.0.1:{}/v1/events", self.handle().addr().port()).into_client_request().unwrap();
        if let Some(t) = token {
            req.headers_mut().insert("authorization", format!("Bearer {t}").parse().unwrap());
        }
        tokio_tungstenite::client_async(req, tls).await.map(|(ws, _)| ws)
    }
}

async fn next_json(ws: &mut Ws) -> Value {
    use futures_util::StreamExt;
    loop {
        match tokio::time::timeout(Duration::from_secs(8), ws.next()).await.expect("an event within 8 s") {
            Some(Ok(Message::Text(t))) => return serde_json::from_str(t.as_str()).unwrap(),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            other => panic!("unexpected: {other:?}"),
        }
    }
}

#[test]
fn the_websocket_needs_a_token_and_pushes_events() {
    let fx = Fixture::new();
    let (_id, token) = fx.pair("P");
    fx.rt.block_on(async {
        assert!(fx.ws(None).await.is_err(), "no token, no socket");
        assert!(fx.ws(Some("A".repeat(43).as_str())).await.is_err());
        let mut ws = fx.ws(Some(&token)).await.expect("upgrade");
        assert_eq!(next_json(&mut ws).await, json!({ "type": "hello", "protocol": 1 }));
        // Give the poller a tick to take its baseline, then change the data the way the webview does.
        tokio::time::sleep(Duration::from_millis(1800)).await;
        let id = msg(&fx.conn, 1, "assistant", vec![text("pushed sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789")], json!({}));
        fx.conn.execute("update chats set updated_at = 5000 where id = 1", []).unwrap();
        let created = next_json(&mut ws).await;
        assert_eq!(created["type"], "message.created");
        assert_eq!(created["message"]["id"], id);
        assert_eq!(created["message"]["text"], "pushed [REDACTED]");
        let updated = next_json(&mut ws).await;
        assert_eq!((updated["type"].as_str(), updated["chat"]["id"].as_i64(), updated["chat"]["updatedAt"].as_i64()), (Some("chat.updated"), Some(1), Some(5000)));
        // A status report from the webview becomes an event too.
        fx.board.replace([(1, "running".to_string())]);
        let running = next_json(&mut ws).await;
        assert_eq!((running["chat"]["status"].as_str(), running["chat"]["running"].as_bool()), (Some("running"), Some(true)));
    });
}

#[test]
fn revoking_closes_the_devices_sockets() {
    use futures_util::StreamExt;
    let fx = Fixture::new();
    let (id, token) = fx.pair("P");
    fx.rt.block_on(async {
        let mut ws = fx.ws(Some(&token)).await.unwrap();
        next_json(&mut ws).await;
        fx.handle().revoke(&id).unwrap();
        let end = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match ws.next().await {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                    Some(Ok(_)) => continue,
                }
            }
        })
        .await;
        assert!(end.is_ok(), "the socket was closed after the revoke");
        assert!(fx.ws(Some(&token)).await.is_err(), "and cannot be reopened");
    });
}

#[test]
fn stopping_the_server_closes_the_port_and_a_new_code_is_needed_after_restart() {
    let mut fx = Fixture::new();
    let (_id, token) = fx.pair("P");
    let addr = fx.handle().addr();
    let fp = fx.fp();
    fx.handle.take().unwrap().stop();
    assert!(std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_err(), "nothing listens any more");
    // Restart: same certificate (the fingerprint on the phone stays valid), same paired device, no leftover code.
    let again = start(&config(Some(Ipv4Addr::LOCALHOST)), &fx.db_path, fx._dir.path(), fx.board.clone()).unwrap();
    assert_eq!(again.fingerprint(), fp);
    assert!(again.active_code().is_none());
    fx.handle = Some(again);
    assert_eq!(fx.request("GET", "/v1/info", Some(&token), None).status, 200);
}
