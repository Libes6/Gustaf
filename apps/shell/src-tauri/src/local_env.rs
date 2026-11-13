//! Local environment hand-off for the Tauri shell.
//!
//! The server still prints a one-shot pairing URL on startup. The shell exchanges
//! that credential for a bearer token and opens the app root without `/pair`, so
//! the page never flashes the pairing form.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tauri::Manager;

use crate::network;
use crate::shell_settings::{self, ExposureMode, ShellSettings, DEFAULT_TAILSCALE_SERVE_PORT};

const OAUTH_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const OAUTH_BOOTSTRAP_TOKEN_TYPE: &str = "urn:t3:params:oauth:token-type:environment-bootstrap";
const OAUTH_ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";

#[derive(Clone, Debug)]
pub(crate) struct LocalEnvironment {
    pub http_base_url: String,
    pub ws_base_url: String,
    pub bootstrap_token: String,
    pub bearer_token: String,
    pub app_url: tauri::Url,
}

pub(crate) struct LocalEnvironmentState {
    inner: Mutex<Option<LocalEnvironment>>,
}

impl LocalEnvironmentState {
    pub(crate) fn new(env: LocalEnvironment) -> Self {
        Self {
            inner: Mutex::new(Some(env)),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&LocalEnvironment) -> T) -> Result<T, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "local environment lock poisoned".to_owned())?;
        let env = guard
            .as_ref()
            .ok_or_else(|| "local environment is not ready".to_owned())?;
        Ok(f(env))
    }

    pub(crate) fn bootstraps_json(&self) -> Result<Value, String> {
        self.with(|env| {
            serde_json::json!([{
                "id": "primary",
                "label": machine_label(),
                "httpBaseUrl": env.http_base_url,
                "wsBaseUrl": env.ws_base_url,
                "bootstrapToken": env.bootstrap_token,
            }])
        })
    }

    pub(crate) fn bearer_token(&self) -> Result<String, String> {
        self.with(|env| env.bearer_token.clone())
    }

    pub(crate) fn http_base_url(&self) -> Result<String, String> {
        self.with(|env| env.http_base_url.clone())
    }
}

pub(crate) fn parse_pairing_url(pairing_url: &tauri::Url) -> Result<(tauri::Url, String), String> {
    let token = pairing_url
        .fragment()
        .and_then(|fragment| {
            fragment.split('&').find_map(|part| {
                let (key, value) = part.split_once('=')?;
                (key == "token" && !value.is_empty()).then(|| value.to_owned())
            })
        })
        .or_else(|| {
            pairing_url.query_pairs().find_map(|(key, value)| {
                (key == "token" && !value.is_empty()).then(|| value.into_owned())
            })
        })
        .ok_or_else(|| "pairing URL has no token".to_owned())?;

    let mut app_url = pairing_url.clone();
    app_url.set_path("/");
    app_url.set_query(None);
    app_url.set_fragment(None);
    Ok((app_url, token))
}

pub(crate) fn ws_base_url_from_http(http_base: &str) -> Result<String, String> {
    let mut url: tauri::Url = http_base
        .parse()
        .map_err(|error| format!("invalid http base URL: {error}"))?;
    match url.scheme() {
        "http" => url
            .set_scheme("ws")
            .map_err(|_| "cannot set ws scheme".to_owned())?,
        "https" => url
            .set_scheme("wss")
            .map_err(|_| "cannot set wss scheme".to_owned())?,
        other => return Err(format!("unsupported http scheme: {other}")),
    }
    Ok(url.to_string())
}

pub(crate) fn exchange_bootstrap_for_bearer(
    http_base_url: &str,
    bootstrap_token: &str,
) -> Result<String, String> {
    let endpoint = format!("{}/oauth/token", http_base_url.trim_end_matches('/'));
    let body = [
        ("grant_type", OAUTH_GRANT_TYPE),
        ("subject_token", bootstrap_token),
        ("subject_token_type", OAUTH_BOOTSTRAP_TOKEN_TYPE),
        ("requested_token_type", OAUTH_ACCESS_TOKEN_TYPE),
        ("client_label", "Gustaf"),
        ("client_device_type", "desktop"),
    ]
    .into_iter()
    .map(|(key, value)| format!("{}={}", key, urlencoding_encode(value)))
    .collect::<Vec<_>>()
    .join("&");

    let response = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(20))
        .build()
        .post(&endpoint)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .set("Accept", "application/json")
        .send_string(&body)
        .map_err(|error| format!("oauth token exchange failed: {error}"))?;

    if !(200..300).contains(&response.status()) {
        let status = response.status();
        let text = response.into_string().unwrap_or_default();
        return Err(format!("oauth token exchange HTTP {status}: {text}"));
    }

    let payload: Value = response
        .into_json()
        .map_err(|error| format!("oauth token response is not JSON: {error}"))?;
    payload
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "oauth token response has no access_token".to_owned())
}

pub(crate) fn build_local_environment(
    pairing_url: &tauri::Url,
) -> Result<LocalEnvironment, String> {
    let (app_url, bootstrap_token) = parse_pairing_url(pairing_url)?;
    let http_base_url = format!(
        "{}://{}{}",
        app_url.scheme(),
        app_url
            .host_str()
            .ok_or_else(|| "pairing URL has no host".to_owned())?,
        app_url
            .port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default()
    );
    let ws_base_url = ws_base_url_from_http(&http_base_url)?;
    let bearer_token = exchange_bootstrap_for_bearer(&http_base_url, &bootstrap_token)?;
    Ok(LocalEnvironment {
        http_base_url,
        ws_base_url,
        bootstrap_token,
        bearer_token,
        app_url,
    })
}

fn machine_label() -> String {
    "This computer".to_owned()
}

fn urlencoding_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn exposure_state_value(settings: &ShellSettings, http_base_url: &str) -> Value {
    let advertised_host = if settings.exposure_mode == ExposureMode::NetworkAccessible {
        network::network_snapshot().lan.into_iter().next()
    } else {
        None
    };
    let endpoint_url = advertised_host.as_ref().map(|host| {
        let port = http_base_url
            .rsplit_once(':')
            .and_then(|(_, port)| port.trim_end_matches('/').parse::<u16>().ok())
            .unwrap_or(3773);
        format!("http://{host}:{port}")
    });
    serde_json::json!({
        "mode": settings.exposure_mode.as_bridge_str(),
        "endpointUrl": endpoint_url,
        "advertisedHost": advertised_host,
        "tailscaleServeEnabled": settings.tailscale_serve_enabled,
        "tailscaleServePort": settings.tailscale_serve_port,
    })
}

fn schedule_relaunch(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        crate::stop_server(&app);
        app.restart();
    });
}

/// Declining leaves the setting as it was and answers with the unchanged state, which the
/// page shows like any other result.
fn apply_with_relaunch(
    app: tauri::AppHandle,
    settings: ShellSettings,
    endpoint: &str,
) -> Result<Value, String> {
    if !crate::exit_guard::confirm(&app, crate::exit_guard::Exit::Restart) {
        return Ok(exposure_state_value(&read_settings(&app), endpoint));
    }
    write_settings(&app, &settings)?;
    let value = exposure_state_value(&settings, endpoint);
    schedule_relaunch(app);
    Ok(value)
}

fn read_settings(app: &tauri::AppHandle) -> ShellSettings {
    if let Some(managed) = app.try_state::<Mutex<ShellSettings>>() {
        if let Ok(guard) = managed.lock() {
            return guard.clone();
        }
    }
    shell_settings::load(app)
}

fn write_settings(app: &tauri::AppHandle, settings: &ShellSettings) -> Result<(), String> {
    shell_settings::save(app, settings)?;
    if let Some(managed) = app.try_state::<Mutex<ShellSettings>>() {
        if let Ok(mut guard) = managed.lock() {
            *guard = settings.clone();
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn local_environment_bootstraps(
    state: tauri::State<'_, LocalEnvironmentState>,
) -> Result<Value, String> {
    state.bootstraps_json()
}

#[tauri::command]
pub(crate) fn local_environment_bearer_token(
    state: tauri::State<'_, LocalEnvironmentState>,
) -> Result<String, String> {
    state.bearer_token()
}

#[tauri::command]
pub(crate) fn local_environment_enabled() -> bool {
    true
}

#[tauri::command]
pub(crate) fn set_local_environment_enabled(_enabled: bool) -> Result<(), String> {
    Err("Disabling the local environment is not supported in this Gustaf build yet.".into())
}

/// The network helpers shell out (`ifconfig`, `tailscale`); sync commands would
/// run them on the main thread and freeze the window.
async fn off_main_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("background task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn server_exposure_state(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalEnvironmentState>,
) -> Result<Value, String> {
    let endpoint = state.http_base_url()?;
    off_main_thread(move || Ok(exposure_state_value(&read_settings(&app), &endpoint))).await
}

#[tauri::command]
pub(crate) async fn set_server_exposure_mode(
    mode: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalEnvironmentState>,
) -> Result<Value, String> {
    let parsed =
        ExposureMode::parse(&mode).ok_or_else(|| format!("unknown exposure mode: {mode}"))?;
    let endpoint = state.http_base_url()?;
    off_main_thread(move || {
        let mut settings = read_settings(&app);
        settings.exposure_mode = parsed;
        apply_with_relaunch(app, settings, &endpoint)
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_tailscale_serve_enabled(
    enabled: bool,
    port: Option<u16>,
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalEnvironmentState>,
) -> Result<Value, String> {
    let endpoint = state.http_base_url()?;
    off_main_thread(move || {
        let mut settings = read_settings(&app);
        settings.tailscale_serve_enabled = enabled;
        if let Some(port) = port {
            settings.tailscale_serve_port = port;
        } else if settings.tailscale_serve_port == 0 {
            settings.tailscale_serve_port = DEFAULT_TAILSCALE_SERVE_PORT;
        }
        apply_with_relaunch(app, settings, &endpoint)
    })
    .await
}

#[tauri::command]
pub(crate) async fn advertised_endpoints(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalEnvironmentState>,
) -> Result<Value, String> {
    let http_base = state.http_base_url()?;
    off_main_thread(move || {
        let settings = read_settings(&app);
        Ok(network::advertised_endpoints_json(
            &http_base,
            settings.exposure_mode.as_bridge_str(),
            settings.tailscale_serve_enabled,
            settings.tailscale_serve_port,
            &network::network_snapshot(),
        ))
    })
    .await
}

#[tauri::command]
pub(crate) fn client_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

#[tauri::command]
pub(crate) fn app_branding() -> Value {
    serde_json::json!({
        "baseName": "Gustaf",
        "stageLabel": "Beta",
        "displayName": "Gustaf",
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_pairing_url, ws_base_url_from_http};

    #[test]
    fn reads_token_from_pairing_fragment() {
        let url = "http://127.0.0.1:7445/pair#token=abc123".parse().unwrap();
        let (app_url, token) = parse_pairing_url(&url).unwrap();
        assert_eq!(token, "abc123");
        assert_eq!(app_url.as_str(), "http://127.0.0.1:7445/");
    }

    #[test]
    fn builds_ws_url_from_http() {
        assert_eq!(
            ws_base_url_from_http("http://127.0.0.1:7445/").unwrap(),
            "ws://127.0.0.1:7445/"
        );
    }
}
