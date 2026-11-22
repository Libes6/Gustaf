//! The browser tabs the page shows, drawn by Chromium (`cef/`) over their slots.
//!
//! The page measures each tab's slot and asks for the view to be placed over it, or hidden while
//! something the page draws (a menu, a dialog) has to cover it. A server tab is also driven by
//! the server, so an agent works in the page the user sees. Pages loaded here never reach the
//! shell's commands: the IPC grant names only the main web view (`ipc_scope.rs`).
//!
//! Without Chromium (other platforms, or the module removed) the page gets no `nativeBrowser`
//! bridge and every tab streams from the server's own browser; these commands then refuse.

use serde::Deserialize;
use tauri::AppHandle;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ColorScheme {
    System,
    Light,
    Dark,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DataKind {
    Cookies,
    Cache,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(all(target_os = "macos", feature = "cef-browser")), allow(dead_code))]
pub(crate) struct CreateInput {
    tab_id: String,
    url: Option<String>,
    profile_id: Option<String>,
    /// The owning environment’s preview session key for the desktop browser channel.
    server_tab: Option<ServerTabKey>,
}

#[derive(Clone, Copy, Deserialize)]
#[cfg_attr(not(all(target_os = "macos", feature = "cef-browser")), allow(dead_code))]
pub(crate) struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(all(target_os = "macos", feature = "cef-browser"))]
type ServerTabKey = crate::cef::ServerTab;
#[cfg(not(all(target_os = "macos", feature = "cef-browser")))]
type ServerTabKey = serde::de::IgnoredAny;

/// A tab may load the web and pages the user picks; anything else would hand a URL to the system.
fn is_page_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "about" | "blob" | "data")
}

fn parse_page_url(raw: &str) -> Result<tauri::Url, String> {
    let url: tauri::Url = raw.parse().map_err(|error| format!("{error}"))?;
    if is_page_url(&url) {
        Ok(url)
    } else {
        Err(format!("A browser tab cannot open {} links", url.scheme()))
    }
}

#[cfg(all(target_os = "macos", feature = "cef-browser"))]
mod engine {
    use super::{parse_page_url, AppHandle, CreateInput, DataKind, Rect};
    use crate::cef;

    fn running() -> Result<(), String> {
        if cef::running() {
            Ok(())
        } else {
            Err("The built-in browser is not installed".to_owned())
        }
    }

    pub(super) async fn create(app: &AppHandle, input: CreateInput) -> Result<(), String> {
        running()?;
        let url = input
            .url
            .as_deref()
            .and_then(|raw| parse_page_url(raw).ok())
            .map_or_else(|| "about:blank".to_owned(), |url| url.to_string());
        let profile = input.profile_id.unwrap_or_else(|| "default".to_owned());
        cef::create(app, input.tab_id, url, profile, input.server_tab).await
    }

    pub(super) async fn close(app: &AppHandle, tab_id: String) -> Result<(), String> {
        running()?;
        cef::close(app, tab_id).await
    }

    pub(super) async fn close_all(app: &AppHandle) -> Result<(), String> {
        running()?;
        cef::close_all(app).await
    }

    pub(super) async fn present(
        app: &AppHandle,
        tab_id: String,
        rect: Option<Rect>,
        corner_radius: f64,
    ) -> Result<(), String> {
        running()?;
        let rect = rect
            .filter(|rect| rect.width >= 1.0 && rect.height >= 1.0)
            .map(|rect| (rect.x, rect.y, rect.width, rect.height));
        cef::present(app, tab_id, rect, corner_radius).await
    }

    pub(super) async fn with_tab(
        app: &AppHandle,
        tab_id: String,
        work: impl FnOnce(&str) + Send + 'static,
    ) -> Result<(), String> {
        running()?;
        cef::with_tab(app, tab_id, work).await
    }

    pub(super) async fn clear_data(
        app: &AppHandle,
        profile_id: Option<String>,
        kind: DataKind,
    ) -> Result<(), String> {
        running()?;
        cef::clear_data(app, profile_id, matches!(kind, DataKind::Cookies)).await
    }

    pub(super) use cef::{history, navigate, open_devtools, reload, set_zoom};
}

#[cfg(not(all(target_os = "macos", feature = "cef-browser")))]
mod engine {
    use super::{AppHandle, CreateInput, DataKind, Rect};

    const UNAVAILABLE: &str = "This app has no built-in browser";

    pub(super) async fn create(_: &AppHandle, _: CreateInput) -> Result<(), String> {
        Err(UNAVAILABLE.to_owned())
    }
    pub(super) async fn close(_: &AppHandle, _: String) -> Result<(), String> {
        Ok(())
    }
    pub(super) async fn close_all(_: &AppHandle) -> Result<(), String> {
        Ok(())
    }
    pub(super) async fn present(
        _: &AppHandle,
        _: String,
        _: Option<Rect>,
        _: f64,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.to_owned())
    }
    pub(super) async fn with_tab(
        _: &AppHandle,
        _: String,
        _: impl FnOnce(&str) + Send + 'static,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.to_owned())
    }
    pub(super) async fn clear_data(
        _: &AppHandle,
        _: Option<String>,
        _: DataKind,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.to_owned())
    }
    pub(super) fn navigate(_: &str, _: &str) {}
    pub(super) fn history(_: &str, _: i32) {}
    pub(super) fn reload(_: &str, _: bool) {}
    pub(super) fn set_zoom(_: &str, _: f64) {}
    pub(super) fn open_devtools(_: &str) {}
}

// Commands are async on purpose: Chromium is driven on the main thread, and a synchronous
// command already runs there, so waiting for it would deadlock.

#[tauri::command]
pub(crate) async fn native_browser_create(
    app: AppHandle,
    input: CreateInput,
) -> Result<(), String> {
    engine::create(&app, input).await
}

#[tauri::command]
pub(crate) async fn native_browser_close(app: AppHandle, tab_id: String) -> Result<(), String> {
    engine::close(&app, tab_id).await
}

/// A page load starts from no tabs; the web app creates the ones its threads still have.
#[tauri::command]
pub(crate) async fn native_browser_close_all(app: AppHandle) -> Result<(), String> {
    engine::close_all(&app).await
}

#[tauri::command]
pub(crate) async fn native_browser_present(
    app: AppHandle,
    tab_id: String,
    rect: Option<Rect>,
    corner_radius: Option<f64>,
) -> Result<(), String> {
    engine::present(&app, tab_id, rect, corner_radius.unwrap_or(0.0).max(0.0)).await
}

#[tauri::command]
pub(crate) async fn native_browser_navigate(
    app: AppHandle,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    let url = parse_page_url(&url)?.to_string();
    engine::with_tab(&app, tab_id, move |tab| engine::navigate(tab, &url)).await
}

#[tauri::command]
pub(crate) async fn native_browser_history(
    app: AppHandle,
    tab_id: String,
    delta: i32,
) -> Result<(), String> {
    engine::with_tab(&app, tab_id, move |tab| engine::history(tab, delta)).await
}

#[tauri::command]
pub(crate) async fn native_browser_reload(
    app: AppHandle,
    tab_id: String,
    hard: bool,
) -> Result<(), String> {
    engine::with_tab(&app, tab_id, move |tab| engine::reload(tab, hard)).await
}

#[tauri::command]
pub(crate) async fn native_browser_set_zoom(
    app: AppHandle,
    tab_id: String,
    zoom_factor: f64,
) -> Result<(), String> {
    if !(zoom_factor > 0.0 && zoom_factor <= 5.0) {
        return Err("Zoom must be between 0 and 5".to_owned());
    }
    engine::with_tab(&app, tab_id, move |tab| engine::set_zoom(tab, zoom_factor)).await
}

/// Chromium tabs follow the system appearance for now.
#[tauri::command]
pub(crate) async fn native_browser_set_color_scheme(
    tab_id: String,
    color_scheme: ColorScheme,
) -> Result<(), String> {
    let _ = (tab_id, color_scheme);
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_browser_open_devtools(
    app: AppHandle,
    tab_id: String,
) -> Result<(), String> {
    engine::with_tab(&app, tab_id, engine::open_devtools).await
}

/// Without a profile, clears every profile.
#[tauri::command]
pub(crate) async fn native_browser_clear_data(
    app: AppHandle,
    profile_id: Option<String>,
    kind: DataKind,
) -> Result<(), String> {
    engine::clear_data(&app, profile_id, kind).await
}

#[cfg(test)]
mod tests {
    use super::{is_page_url, parse_page_url};

    #[test]
    fn tabs_load_only_pages() {
        for url in [
            "https://example.com/",
            "http://localhost:5173/",
            "about:blank",
        ] {
            assert!(is_page_url(&url.parse().unwrap()), "{url}");
        }
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:a@b.c",
            "tauri://localhost",
        ] {
            assert!(!is_page_url(&url.parse().unwrap()), "{url}");
        }
        assert!(parse_page_url("file:///etc/passwd").is_err());
    }
}
