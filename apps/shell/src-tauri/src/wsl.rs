//! The optional Linux environment owns its server; Windows stays the default primary.

use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::Manager;

use crate::local_env::{build_local_environment, LocalEnvironment};
use crate::server_process::Server;
use crate::shell_settings::{self, ShellSettings};
use crate::wsl_support::{self, Distro};

pub(crate) struct WslRuntime {
    server: Mutex<Option<Server>>,
    local: Option<LocalEnvironment>,
    error: Option<String>,
    primary_url: Option<tauri::Url>,
    backend_id: String,
    pub(crate) running_distro: Option<String>,
}

fn command(distro: Option<&str>) -> Command {
    let windir = std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into());
    let mut command = Command::new(std::path::PathBuf::from(windir).join("System32/wsl.exe"));
    command.args(wsl_support::distro_args(distro));
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x08000000);
    command
}

fn output(mut command: Command) -> Result<Vec<u8>, String> {
    use std::io::Read;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|e| format!("WSL: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("WSL stdout is missing")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                return reader
                    .join()
                    .map_err(|_| "WSL reader failed")?
                    .map_err(|e| e.to_string())
            }
            Ok(Some(status)) => return Err(format!("WSL exited with {status}")),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
            _ if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("WSL timed out".into());
            }
            _ => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

fn distros() -> Result<Vec<Distro>, String> {
    if !cfg!(windows) {
        return Ok(Vec::new());
    }
    let mut cmd = command(None);
    cmd.args(["--list", "--verbose"]);
    let list = wsl_support::parse_distros(&output(cmd)?);
    if list.is_empty() {
        return Err("No installed WSL distributions".into());
    }
    Ok(list)
}

impl WslRuntime {
    pub(crate) fn start(settings: &ShellSettings) -> Self {
        let mut state = Self {
            server: Mutex::new(None),
            local: None,
            error: None,
            primary_url: None,
            backend_id: wsl_support::backend_id(settings.wsl_distro.as_deref()),
            running_distro: None,
        };
        if !cfg!(windows) || !settings.wsl_backend_enabled {
            return state;
        }
        let result = (|| {
            let list = distros()?;
            if let Some(name) = &settings.wsl_distro {
                if !list.iter().any(|d| &d.name == name) {
                    return Err(format!("WSL distribution is not installed: {name}"));
                }
            }
            let selected = settings
                .wsl_distro
                .clone()
                .or_else(|| list.iter().find(|d| d.is_default).map(|d| d.name.clone()))
                .ok_or("No default WSL distribution")?;
            // Reserve a Windows loopback candidate; WSL's localhost forwarding uses this port.
            let listener =
                std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            drop(listener);
            let mut cmd = command(Some(&selected));
            cmd.args(["--exec", "bash", "-l", "-s"]);
            let (server, url) = crate::spawn_server(
                cmd,
                Some(&wsl_support::server_script(
                    port,
                    settings.wsl_only
                        && settings.exposure_mode
                            == crate::shell_settings::ExposureMode::NetworkAccessible,
                    (settings.wsl_only && settings.tailscale_serve_enabled)
                        .then_some(settings.tailscale_serve_port),
                )),
            )?;
            let local = if settings.wsl_only {
                None
            } else {
                Some(build_local_environment(&url)?)
            };
            Ok((server, url, local, selected))
        })();
        match result {
            Ok((server, url, local, selected)) => {
                *state.server.get_mut().unwrap() = Some(server);
                state.local = local;
                state.running_distro = Some(selected);
                if settings.wsl_only {
                    state.primary_url = Some(url);
                }
            }
            Err(error) => state.error = Some(error),
        }
        state
    }

    pub(crate) fn ready(&self) -> bool {
        self.local.is_some() || self.primary_url.is_some()
    }
    pub(crate) fn error(&self) -> Option<String> {
        if let Ok(mut server) = self.server.lock() {
            if let Some(server) = server.as_mut() {
                if let Ok(Some(status)) = server.try_wait() {
                    return Some(format!("WSL server stopped: {status}"));
                }
            }
        }
        self.error.clone()
    }
    pub(crate) fn stop(&self) {
        if let Ok(mut server) = self.server.lock() {
            server.take();
        }
    }
    pub(crate) fn take_primary(
        &mut self,
        settings: &ShellSettings,
    ) -> Option<Result<(Server, tauri::Url), String>> {
        if !settings.wsl_backend_enabled || !settings.wsl_only {
            return None;
        }
        let url = self.primary_url.take()?;
        let server = self.server.get_mut().ok()?.take()?;
        Some(Ok((server, url)))
    }
    pub(crate) fn bootstrap(&self) -> Option<Value> {
        self.local.as_ref().map(|env| {
            json!({
                "id": self.backend_id, "label": "WSL", "runningDistro": self.running_distro, "httpBaseUrl": env.http_base_url,
                "wsBaseUrl": env.ws_base_url, "bootstrapToken": env.bootstrap_token,
            })
        })
    }
}

fn state_value(
    settings: &ShellSettings,
    list: Result<Vec<Distro>, String>,
    error: Option<String>,
) -> Value {
    let available = list.is_ok() && cfg!(windows);
    let list_error = list.as_ref().err().cloned();
    let list = list.unwrap_or_default();
    json!({
        "enabled": cfg!(windows) && settings.wsl_backend_enabled,
        "distro": settings.wsl_distro,
        "wslOnly": cfg!(windows) && settings.wsl_only,
        "available": available,
        "distros": list.iter().map(|d| json!({"name": d.name, "isDefault": d.is_default, "version": d.version})).collect::<Vec<_>>(),
        "preflightError": if settings.wsl_only || !cfg!(windows) { None } else { error.or(list_error) },
    })
}

async fn change(
    app: tauri::AppHandle,
    update: impl FnOnce(&mut ShellSettings) -> Result<(), String> + Send + 'static,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let managed = app.state::<Mutex<ShellSettings>>();
        let mut guard = managed.lock().map_err(|_| "settings lock poisoned")?;
        let mut next = guard.clone();
        update(&mut next)?;
        let changed =
            serde_json::to_value(&*guard).unwrap() != serde_json::to_value(&next).unwrap();
        if changed {
            shell_settings::save(&app, &next)?;
            *guard = next.clone();
        }
        drop(guard);
        let error = app.state::<WslRuntime>().error();
        let value = state_value(&next, distros(), error);
        if changed {
            crate::local_env::schedule_relaunch(app);
        }
        Ok(value)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn wsl_state(app: tauri::AppHandle) -> Result<Value, String> {
    change(app, |_| Ok(())).await
}

#[tauri::command]
pub(crate) async fn set_wsl_backend_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<Value, String> {
    change(app, move |s| {
        if enabled {
            distros()?;
            if !cfg!(windows) {
                return Err("WSL is only available on Windows".into());
            }
        }
        s.wsl_backend_enabled = enabled;
        if !enabled {
            s.wsl_only = false;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_wsl_distro(
    app: tauri::AppHandle,
    distro: Option<String>,
) -> Result<Value, String> {
    change(app, move |s| {
        if let Some(name) = &distro {
            if !distros()?.iter().any(|d| &d.name == name) {
                return Err("WSL distribution is not installed".into());
            }
        }
        s.wsl_distro = distro;
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_wsl_only(app: tauri::AppHandle, enabled: bool) -> Result<Value, String> {
    change(app, move |s| {
        if enabled && !cfg!(windows) {
            return Err("WSL is only available on Windows".into());
        }
        s.wsl_only = enabled;
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn wsl_path(
    app: tauri::AppHandle,
    path: String,
    to_windows: bool,
    target_environment_id: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = shell_settings::load(&app);
        if !cfg!(windows)
            || !wsl_support::uses_wsl_path(
                settings.wsl_backend_enabled,
                settings.wsl_only,
                settings.wsl_distro.as_deref(),
                target_environment_id.as_deref(),
            )
        {
            return Ok(path);
        }
        let distro = app
            .state::<WslRuntime>()
            .running_distro
            .clone()
            .or(settings.wsl_distro)
            .or_else(|| {
                distros()
                    .ok()?
                    .into_iter()
                    .find(|d| d.is_default)
                    .map(|d| d.name)
            })
            .ok_or("No default WSL distribution")?;
        if to_windows {
            let path = if path.is_empty() || path == "~" || path.starts_with("~/") {
                let mut cmd = command(Some(&distro));
                cmd.args(["--exec", "printenv", "HOME"]);
                let home = String::from_utf8(output(cmd)?).map_err(|e| e.to_string())?;
                let home = home.trim();
                if !home.starts_with('/') {
                    return Err("WSL returned an invalid home path".into());
                }
                format!("{home}{}", path.strip_prefix('~').unwrap_or_default())
            } else {
                path
            };
            return Ok(if path.starts_with('/') {
                format!("\\\\wsl.localhost\\{distro}{}", path.replace('/', "\\"))
            } else {
                path
            });
        }
        if let Some((owner, linux)) = wsl_support::unc_path(&path) {
            if !owner.eq_ignore_ascii_case(&distro) {
                return Err("The folder belongs to another WSL distribution".into());
            }
            return Ok(linux);
        }
        if path.starts_with('/') {
            return Ok(path);
        }
        let mut cmd = command(Some(&distro));
        cmd.args(["--exec", "wslpath", "-u", &path.replace('\\', "/")]);
        let converted = String::from_utf8(output(cmd)?).map_err(|e| e.to_string())?;
        let converted = converted.trim();
        if !converted.starts_with('/') {
            return Err("WSL returned an invalid Linux path".into());
        }
        Ok(converted.into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_state_keeps_saved_selection_and_only_mode_hides_preflight_error() {
        let mut settings = ShellSettings::default();
        settings.wsl_distro = Some("Ubuntu Dev".into());
        let value = state_value(&settings, Err("not installed".into()), None);
        assert_eq!(value["available"], false);
        assert_eq!(value["distro"], "Ubuntu Dev");
        settings.wsl_only = true;
        assert!(state_value(
            &settings,
            Err("not installed".into()),
            Some("failed".into())
        )["preflightError"]
            .is_null());
    }
}
