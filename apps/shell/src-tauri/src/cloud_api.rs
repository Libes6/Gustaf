//! The Gustaf cloud API as the shell sees it. Every URL, field name and status the
//! account feature depends on lives here, so a contract change touches one file.
//! Errors never carry the bearer token or a response body that could echo it.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const API_BASE: &str = "https://api.libes6.ru";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(crate) struct CloudUser {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenGrant {
    pub token: String,
    pub expires_at: String,
    pub user: CloudUser,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudDevice {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub created_at: String,
    #[serde(default)]
    pub last_seen_at: Option<String>,
}

#[derive(Deserialize)]
struct DeviceList {
    devices: Vec<CloudDevice>,
}

#[derive(Deserialize)]
struct RegisteredDevice {
    device: CloudDevice,
    token: String,
}

#[derive(Debug, PartialEq)]
pub(crate) enum ApiError {
    /// The session token is missing, expired or revoked.
    Unauthorized,
    Failed(String),
}

impl From<ApiError> for String {
    fn from(error: ApiError) -> Self {
        match error {
            ApiError::Unauthorized => "Your Gustaf account session has expired.".to_owned(),
            ApiError::Failed(message) => message,
        }
    }
}

pub(crate) fn sign_in_url(
    redirect_uri: &str,
    code_challenge: &str,
    state: &str,
) -> Result<tauri::Url, String> {
    tauri::Url::parse_with_params(
        &format!("{API_BASE}/v1/auth/app/start"),
        [
            ("redirect_uri", redirect_uri),
            ("code_challenge", code_challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
        ],
    )
    .map_err(|error| format!("Cannot build the sign-in address: {error}"))
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(20))
        .build()
}

fn request(method: &str, path: &str, token: Option<&str>) -> ureq::Request {
    let request = agent()
        .request(method, &format!("{API_BASE}{path}"))
        .set("Accept", "application/json");
    match token {
        Some(token) => request.set("Authorization", &format!("Bearer {token}")),
        None => request,
    }
}

fn send(request: ureq::Request, body: Option<Value>) -> Result<ureq::Response, ApiError> {
    let result = match body {
        Some(body) => request.send_json(body),
        None => request.call(),
    };
    match result {
        Ok(response) => Ok(response),
        Err(ureq::Error::Status(401, _)) => Err(ApiError::Unauthorized),
        Err(ureq::Error::Status(status, _)) => Err(ApiError::Failed(format!(
            "The Gustaf cloud answered with HTTP {status}."
        ))),
        Err(ureq::Error::Transport(error)) => Err(ApiError::Failed(format!(
            "Cannot reach the Gustaf cloud: {}",
            error.kind()
        ))),
    }
}

fn read_json<T: serde::de::DeserializeOwned>(response: ureq::Response) -> Result<T, ApiError> {
    response
        .into_json()
        .map_err(|_| ApiError::Failed("The Gustaf cloud sent an unexpected answer.".to_owned()))
}

pub(crate) fn exchange_code(
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<TokenGrant, ApiError> {
    let response = send(
        request("POST", "/v1/auth/app/token", None),
        Some(json!({
            "code": code,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
        })),
    )?;
    let grant: TokenGrant = read_json(response)?;
    if grant.token.is_empty() {
        return Err(ApiError::Failed(
            "The Gustaf cloud did not return a session.".to_owned(),
        ));
    }
    Ok(grant)
}

pub(crate) fn sign_out(token: &str) -> Result<(), ApiError> {
    send(
        request("POST", "/v1/auth/sign-out", Some(token)),
        Some(json!({})),
    )
    .map(drop)
}

pub(crate) fn list_devices(token: &str) -> Result<Vec<CloudDevice>, ApiError> {
    let response = send(request("GET", "/v1/devices", Some(token)), None)?;
    Ok(read_json::<DeviceList>(response)?.devices)
}

/// Returns the new device and its own credential, which the cloud shows only once.
pub(crate) fn register_computer(
    token: &str,
    name: &str,
) -> Result<(CloudDevice, String), ApiError> {
    let response = send(
        request("POST", "/v1/devices", Some(token)),
        Some(json!({ "name": name, "kind": "computer" })),
    )?;
    let registered: RegisteredDevice = read_json(response)?;
    Ok((registered.device, registered.token))
}

pub(crate) fn revoke_device(token: &str, device_id: &str) -> Result<(), ApiError> {
    send(
        request("DELETE", &format!("/v1/devices/{device_id}"), Some(token)),
        None,
    )
    .map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_in_url_carries_the_pkce_challenge_and_state() {
        let url = sign_in_url(
            "http://127.0.0.1:51234/callback",
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            "st&ate",
        )
        .unwrap();
        assert_eq!(url.path(), "/v1/auth/app/start");
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert_eq!(
            pairs,
            [
                ("redirect_uri", "http://127.0.0.1:51234/callback"),
                (
                    "code_challenge",
                    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
                ),
                ("code_challenge_method", "S256"),
                ("state", "st&ate"),
            ]
            .map(|(key, value)| (key.to_owned(), value.to_owned()))
        );
    }

    #[test]
    fn reads_the_token_grant() {
        let grant: TokenGrant = serde_json::from_value(json!({
            "token": "abc",
            "expiresAt": "2026-12-01T00:00:00.000Z",
            "user": { "id": "u1", "name": "Max", "email": "max@example.com", "image": null },
        }))
        .unwrap();
        assert_eq!(grant.token, "abc");
        assert_eq!(grant.user.image, None);
        assert_eq!(grant.user.name.as_deref(), Some("Max"));
    }
}
