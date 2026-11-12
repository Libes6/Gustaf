//! Sign-in to the Gustaf cloud account.
//!
//! The page is served by the local server, cannot reach the cloud API (no CORS), and
//! must never hold the session token. So the shell runs the whole flow: an OAuth-style
//! PKCE hand-off through the system browser to a one-shot loopback listener (RFC 8252),
//! then keeps the token in the encrypted store and answers the page with state only.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chacha20poly1305::aead::{rand_core::RngCore, OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::cloud_api::{self, ApiError, CloudDevice, CloudUser};
use crate::connection_storage::{lock_catalog, read_catalog, write_catalog};

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REQUEST_HEAD: usize = 8 * 1024;
const ACCOUNT_FILE: &str = "account.encrypted.json";
const ACCOUNT_KEY_ENTRY: &str = "account-key";

#[derive(Default)]
pub(crate) struct AccountStore {
    file: Mutex<()>,
    /// Bumped by every sign-in and cancel; a waiting listener whose number is stale gives up.
    sign_in: AtomicU64,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredAccount {
    session: Option<StoredSession>,
    device: Option<StoredDevice>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    token: String,
    expires_at: String,
    user: CloudUser,
}

/// This computer's own credential. It outlives an expired session of the same user.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDevice {
    id: String,
    token: String,
    user_id: String,
}

/// What the page may see: never a token.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountState {
    signed_in: bool,
    user: Option<CloudUser>,
    expires_at: Option<String>,
    device_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountDevice {
    #[serde(flatten)]
    device: CloudDevice,
    current: bool,
}

impl StoredAccount {
    fn state(&self) -> AccountState {
        let session = self.session.as_ref();
        AccountState {
            signed_in: session.is_some(),
            user: session.map(|session| session.user.clone()),
            expires_at: session.map(|session| session.expires_at.clone()),
            device_id: self.device.as_ref().map(|device| device.id.clone()),
        }
    }
}

// --- PKCE (RFC 7636) ---

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

// --- Loopback callback ---

#[derive(Debug, PartialEq)]
enum Callback {
    Code(String),
    Denied(String),
    StateMismatch,
    /// Anything that is not our callback: another path, a probe, garbage.
    Other,
}

/// Reads up to the end of the request head; `None` for oversized or cut-off requests.
fn read_request_head(stream: &mut impl Read) -> Option<Vec<u8>> {
    let mut head = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if head.len() > MAX_REQUEST_HEAD {
            return None;
        }
        if head.windows(4).any(|window| window == b"\r\n\r\n") {
            return Some(head);
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return None,
            Ok(read) => head.extend_from_slice(&chunk[..read]),
        }
    }
}

fn parse_callback(head: &[u8], expected_state: &str) -> Callback {
    let Ok(text) = std::str::from_utf8(head) else {
        return Callback::Other;
    };
    let mut request_line = text.lines().next().unwrap_or_default().split(' ');
    let (Some("GET"), Some(target), Some(version)) = (
        request_line.next(),
        request_line.next(),
        request_line.next(),
    ) else {
        return Callback::Other;
    };
    if !target.starts_with('/') || !version.starts_with("HTTP/") {
        return Callback::Other;
    }
    let Ok(url) = tauri::Url::parse(&format!("http://127.0.0.1{target}")) else {
        return Callback::Other;
    };
    if url.path() != "/callback" {
        return Callback::Other;
    }
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    if param("state").as_deref() != Some(expected_state) {
        return Callback::StateMismatch;
    }
    match (param("code"), param("error")) {
        (_, Some(error)) => Callback::Denied(error),
        (Some(code), None) if !code.is_empty() => Callback::Code(code),
        _ => Callback::Denied("invalid_response".to_owned()),
    }
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Gustaf</title>\
<body style=\"font:16px system-ui;margin:4rem;text-align:center\">\
<h1>Signed in</h1><p>You can close this tab and return to Gustaf.</p>";
const FAILED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Gustaf</title>\
<body style=\"font:16px system-ui;margin:4rem;text-align:center\">\
<h1>Sign-in did not finish</h1><p>You can close this tab and return to Gustaf.</p>";

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
Cache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn denied_message(error: &str) -> String {
    match error {
        "access_denied" => "Sign-in was cancelled in the browser.".to_owned(),
        // The value comes from the browser's address bar: show only a short, plain code.
        code if !code.is_empty()
            && code.len() <= 64
            && code
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_') =>
        {
            format!("Sign-in failed ({code}).")
        }
        _ => "Sign-in failed.".to_owned(),
    }
}

fn wait_for_code(
    listener: &TcpListener,
    expected_state: &str,
    cancelled: impl Fn() -> bool,
) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + SIGN_IN_TIMEOUT;
    loop {
        if cancelled() {
            return Err("Sign-in was cancelled.".to_owned());
        }
        if Instant::now() > deadline {
            return Err("Sign-in timed out. Try again.".to_owned());
        }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            Err(error) => return Err(format!("The sign-in listener failed: {error}")),
        };
        // Accepted sockets inherit non-blocking mode on some systems.
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(CALLBACK_READ_TIMEOUT));
        let callback = read_request_head(&mut stream)
            .map(|head| parse_callback(&head, expected_state))
            .unwrap_or(Callback::Other);
        match callback {
            Callback::Code(code) => {
                respond(&mut stream, "200 OK", DONE_PAGE);
                return Ok(code);
            }
            Callback::Denied(error) => {
                respond(&mut stream, "200 OK", FAILED_PAGE);
                return Err(denied_message(&error));
            }
            Callback::StateMismatch => {
                respond(&mut stream, "400 Bad Request", FAILED_PAGE);
                return Err(
                    "Sign-in was rejected: the browser answered for another attempt.".to_owned(),
                );
            }
            Callback::Other => respond(&mut stream, "404 Not Found", ""),
        }
    }
}

// --- Storage ---

fn account_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join(ACCOUNT_FILE))
        .map_err(|error| error.to_string())
}

/// Runs `work` with the account file under the process and file locks.
fn locked<T>(
    app: &tauri::AppHandle,
    work: impl FnOnce(&std::path::Path, &keyring::Entry) -> Result<T, String>,
) -> Result<T, String> {
    let store = app.state::<AccountStore>();
    let _guard = store
        .file
        .lock()
        .map_err(|_| "Account storage is unavailable")?;
    let path = account_path(app)?;
    let _file_lock = lock_catalog(&path)?;
    let entry = keyring::Entry::new(&app.config().identifier, ACCOUNT_KEY_ENTRY)
        .map_err(|_| "Cannot open the system keyring for the account")?;
    work(&path, &entry)
}

fn read_account<T>(
    app: &tauri::AppHandle,
    read: impl FnOnce(&StoredAccount) -> T,
) -> Result<T, String> {
    locked(app, |path, entry| Ok(read(&load(path, entry)?)))
}

fn change_account<T>(
    app: &tauri::AppHandle,
    change: impl FnOnce(&mut StoredAccount) -> T,
) -> Result<T, String> {
    locked(app, |path, entry| {
        let mut account = load(path, entry)?;
        let result = change(&mut account);
        save(path, entry, &account)?;
        Ok(result)
    })
}

fn load(path: &std::path::Path, entry: &keyring::Entry) -> Result<StoredAccount, String> {
    match read_catalog(path, entry)? {
        Some(raw) => serde_json::from_str(&raw).map_err(|_| "Saved account is unreadable".into()),
        None => Ok(StoredAccount::default()),
    }
}

fn save(
    path: &std::path::Path,
    entry: &keyring::Entry,
    account: &StoredAccount,
) -> Result<(), String> {
    if account.session.is_none() && account.device.is_none() {
        return match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        };
    }
    let raw = serde_json::to_string(account).map_err(|_| "Cannot encode the account")?;
    write_catalog(path, entry, &raw)
}

fn session_token(app: &tauri::AppHandle) -> Result<String, String> {
    read_account(app, |account| {
        account
            .session
            .as_ref()
            .map(|session| session.token.clone())
    })?
    .ok_or_else(|| "Sign in to your Gustaf account first.".to_owned())
}

/// An expired or revoked session is forgotten so the page shows the sign-in button again.
fn forget_rejected_session<T>(
    app: &tauri::AppHandle,
    result: Result<T, ApiError>,
) -> Result<T, String> {
    if matches!(result, Err(ApiError::Unauthorized)) {
        let _ = change_account(app, |account| account.session = None);
    }
    result.map_err(String::from)
}

fn computer_name() -> String {
    #[cfg(windows)]
    let name = std::env::var("COMPUTERNAME").ok();
    #[cfg(not(windows))]
    let name = {
        let (program, args): (&str, &[&str]) = if cfg!(target_os = "macos") {
            ("scutil", &["--get", "ComputerName"])
        } else {
            ("hostname", &[])
        };
        std::process::Command::new(program)
            .args(args)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
    };
    name.map(|name| name.trim().chars().take(100).collect::<String>())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Gustaf computer".to_owned())
}

fn is_device_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

// --- Commands ---

/// Keyring prompts, the browser wait and HTTP all block; sync commands would freeze the window.
async fn off_main_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "Account task failed".to_owned())?
}

#[tauri::command]
pub(crate) async fn account_state(app: tauri::AppHandle) -> Result<AccountState, String> {
    off_main_thread(move || read_account(&app, StoredAccount::state)).await
}

#[tauri::command]
pub(crate) async fn account_sign_in(app: tauri::AppHandle) -> Result<AccountState, String> {
    let attempt = app
        .state::<AccountStore>()
        .sign_in
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    off_main_thread(move || {
        let verifier = random_token();
        let state = random_token();
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("Cannot listen for the sign-in answer: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{port}/callback");
        crate::open_external_url(&cloud_api::sign_in_url(
            &redirect_uri,
            &code_challenge(&verifier),
            &state,
        )?);
        let code = wait_for_code(&listener, &state, || {
            app.state::<AccountStore>().sign_in.load(Ordering::SeqCst) != attempt
        })?;
        drop(listener);
        let grant = cloud_api::exchange_code(&code, &verifier, &redirect_uri)?;
        change_account(&app, |account| {
            if account
                .device
                .as_ref()
                .is_some_and(|device| device.user_id != grant.user.id)
            {
                account.device = None;
            }
            account.session = Some(StoredSession {
                token: grant.token,
                expires_at: grant.expires_at,
                user: grant.user,
            });
            account.state()
        })
    })
    .await
}

#[tauri::command]
pub(crate) fn account_cancel_sign_in(app: tauri::AppHandle) {
    app.state::<AccountStore>()
        .sign_in
        .fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
pub(crate) async fn account_sign_out(app: tauri::AppHandle) -> Result<AccountState, String> {
    off_main_thread(move || {
        let token = read_account(&app, |account| {
            account
                .session
                .as_ref()
                .map(|session| session.token.clone())
        })?;
        if let Some(token) = token {
            // Best effort: an offline sign-out must still forget the account here.
            let _ = cloud_api::sign_out(&token);
        }
        change_account(&app, |account| {
            *account = StoredAccount::default();
            account.state()
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn account_devices(app: tauri::AppHandle) -> Result<Vec<AccountDevice>, String> {
    off_main_thread(move || {
        let token = session_token(&app)?;
        let devices = forget_rejected_session(&app, cloud_api::list_devices(&token))?;
        let current = read_account(&app, |account| {
            account.device.as_ref().map(|device| device.id.clone())
        })?;
        Ok(devices
            .into_iter()
            .map(|device| AccountDevice {
                current: current.as_deref() == Some(device.id.as_str()),
                device,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub(crate) async fn account_register_device(app: tauri::AppHandle) -> Result<AccountState, String> {
    off_main_thread(move || {
        let token = session_token(&app)?;
        let (device, device_token) =
            forget_rejected_session(&app, cloud_api::register_computer(&token, &computer_name()))?;
        change_account(&app, |account| {
            if let Some(session) = &account.session {
                account.device = Some(StoredDevice {
                    id: device.id,
                    token: device_token,
                    user_id: session.user.id.clone(),
                });
            }
            account.state()
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn account_revoke_device(
    app: tauri::AppHandle,
    device_id: String,
) -> Result<AccountState, String> {
    if !is_device_id(&device_id) {
        return Err("Unknown device".to_owned());
    }
    off_main_thread(move || {
        let token = session_token(&app)?;
        forget_rejected_session(&app, cloud_api::revoke_device(&token, &device_id))?;
        change_account(&app, |account| {
            if account
                .device
                .as_ref()
                .is_some_and(|device| device.id == device_id)
            {
                account.device = None;
            }
            account.state()
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn pkce_challenge_matches_rfc_7636_appendix_b() {
        assert_eq!(
            code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let verifier = random_token();
        // 32 random bytes: within RFC 7636's 43-128 characters, unreserved alphabet only.
        assert_eq!(verifier.len(), 43);
        assert!(verifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
        assert_ne!(verifier, random_token());
    }

    fn request(target: &str) -> Vec<u8> {
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:5000\r\n\r\n").into_bytes()
    }

    #[test]
    fn parses_the_callback_request() {
        assert_eq!(
            parse_callback(&request("/callback?code=a%2Bb&state=s1"), "s1"),
            Callback::Code("a+b".to_owned())
        );
        assert_eq!(
            parse_callback(&request("/callback?error=access_denied&state=s1"), "s1"),
            Callback::Denied("access_denied".to_owned())
        );
        assert_eq!(
            parse_callback(&request("/callback?state=s1"), "s1"),
            Callback::Denied("invalid_response".to_owned())
        );
        for target in [
            "/callback?code=a&state=other",
            "/callback?code=a",
            "/callback?error=access_denied&state=s2",
        ] {
            assert_eq!(
                parse_callback(&request(target), "s1"),
                Callback::StateMismatch,
                "{target}"
            );
        }
        for head in [
            request("/favicon.ico"),
            request("/callbackx?code=a&state=s1"),
            request("http://evil/callback?code=a&state=s1"),
            b"POST /callback?code=a&state=s1 HTTP/1.1\r\n\r\n".to_vec(),
            b"GET /callback?code=a&state=s1\r\n\r\n".to_vec(),
            b"\xff\xfe garbage\r\n\r\n".to_vec(),
            Vec::new(),
        ] {
            assert_eq!(parse_callback(&head, "s1"), Callback::Other);
        }
    }

    #[test]
    fn reads_only_bounded_complete_request_heads() {
        let head = request("/callback?code=a&state=s1");
        assert_eq!(
            read_request_head(&mut Cursor::new(head.clone())),
            Some(head)
        );
        assert_eq!(
            read_request_head(&mut Cursor::new(b"GET /callback HTTP/1.1\r\n".to_vec())),
            None
        );
        let oversized = format!("GET /{} HTTP/1.1\r\n\r\n", "a".repeat(MAX_REQUEST_HEAD + 1));
        assert_eq!(
            read_request_head(&mut Cursor::new(oversized.into_bytes())),
            None
        );
    }

    #[test]
    fn shows_only_plain_error_codes_from_the_browser() {
        assert_eq!(
            denied_message("access_denied"),
            "Sign-in was cancelled in the browser."
        );
        assert_eq!(
            denied_message("server_error"),
            "Sign-in failed (server_error)."
        );
        assert_eq!(denied_message("<script>"), "Sign-in failed.");
    }

    #[test]
    fn the_account_round_trips_encrypted_and_empty_removes_the_file() {
        let entry = keyring::Entry::new_with_credential(
            keyring::mock::default_credential_builder()
                .build(None, "test", "account")
                .unwrap(),
        );
        let dir = std::env::temp_dir().join(format!("gustaf-account-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(ACCOUNT_FILE);
        assert!(load(&path, &entry).unwrap().session.is_none());
        let account = StoredAccount {
            session: Some(StoredSession {
                token: "secret-session-token".to_owned(),
                expires_at: "2026-12-01T00:00:00.000Z".to_owned(),
                user: CloudUser {
                    id: "u1".to_owned(),
                    name: Some("Max".to_owned()),
                    email: None,
                    image: None,
                },
            }),
            device: Some(StoredDevice {
                id: "d1".to_owned(),
                token: "gdt_secret-device-token".to_owned(),
                user_id: "u1".to_owned(),
            }),
        };
        save(&path, &entry, &account).unwrap();
        let raw = String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned();
        assert!(!raw.contains("secret-session-token") && !raw.contains("secret-device-token"));
        let loaded = load(&path, &entry).unwrap();
        assert_eq!(
            loaded.session.as_ref().unwrap().token,
            "secret-session-token"
        );
        assert_eq!(
            loaded.device.as_ref().unwrap().token,
            "gdt_secret-device-token"
        );
        let state = serde_json::to_value(loaded.state()).unwrap();
        assert!(!state.to_string().contains("secret"));
        assert_eq!(state["signedIn"], true);
        assert_eq!(state["deviceId"], "d1");
        save(&path, &entry, &StoredAccount::default()).unwrap();
        assert!(!path.exists());
        assert!(load(&path, &entry).unwrap().session.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_plain_device_ids_reach_the_url() {
        assert!(is_device_id("3f2b9c1e-0b7a-4d4e-9a55-0c1d2e3f4a5b"));
        for id in ["", "../me", "a/b", "a?b", "a b"] {
            assert!(!is_device_id(id), "{id}");
        }
    }
}
