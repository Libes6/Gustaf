//! What the web app cannot do from inside a system web view.
//!
//! The window shows the server's web app, which was written for a desktop bridge
//! and for browsers. A system web view is neither: it has no `Notification`, hides
//! the path of a dropped folder, drops downloads, and cannot follow editor links.
//! The script below installs `window.desktopBridge` (so the page treats Gustaf as
//! the desktop app) and keeps `window.gustafShell` for shell-only helpers.

use std::path::{Path, PathBuf};
use tauri::Manager;

/// Runs in the main frame before the page's own code.
const INIT_SCRIPT: &str = r#"(() => {
  if (window.top !== window || window.gustafShell) return;
  // The script runs on every page the window loads. Only the local server's page may
  // get the bridge: it carries the token that signs this window in.
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)) return;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);

  // WKWebView does not implement Electron's -webkit-app-region CSS.
  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (!event.target.closest(".drag-region")) return;
    if (event.target.closest("button, a, input, textarea, select, [role=button], [contenteditable=true]")) return;
    event.preventDefault();
    invoke("drag_window", { doubleClick: event.detail === 2 }).catch(console.error);
  });

  // The shell pushes each update state here (`publish` in updater.rs).
  const updateListeners = new Set();
  window.__gustafUpdateState = (state) => {
    for (const listener of updateListeners) listener(state);
  };

  const updater = Object.freeze({
    getUpdateState: () => invoke("update_state"),
    onUpdateState: (listener) => {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    checkForUpdate: () => invoke("update_check"),
    downloadUpdate: () => invoke("update_download"),
    installUpdate: (expectedVersion) =>
      invoke("update_install", { expectedVersion: expectedVersion ?? null }),
    openExternal: async (url) => {
      window.open(url, "_blank");
      return true;
    },
  });

  const pickFolder = async (options) => {
    const picked = await invoke("plugin:dialog|open", {
      options: {
        directory: true,
        multiple: false,
        ...(options?.initialPath ? { defaultPath: options.initialPath } : {}),
      },
    });
    return typeof picked === "string" && picked.length > 0 ? picked : null;
  };

  const droppedPaths = async () => {
    const paths = await invoke("dropped_paths");
    return Array.isArray(paths) ? paths.filter((path) => typeof path === "string") : [];
  };

  const fullscreenListeners = new Set();
  let fullscreen = false;
  window.__gustafFullscreenState = (value) => {
    if (fullscreen === value) return;
    fullscreen = value;
    for (const listener of fullscreenListeners) listener(value);
  };
  let fullscreenRequest = 0;
  const refreshFullscreen = async () => {
    const request = ++fullscreenRequest;
    try {
      const value = await invoke("window_fullscreen_state");
      if (request === fullscreenRequest) window.__gustafFullscreenState(value);
    } catch (error) {
      console.error(error);
    }
  };
  window.addEventListener("resize", refreshFullscreen);
  refreshFullscreen();

  // Migrate the previous, port-specific browser settings only after saving succeeds.
  const getClientSettings = async () => {
    const saved = await invoke("read_client_settings");
    if (saved !== null) return saved;
    const raw = window.localStorage.getItem("gustaf.clientSettings");
    if (!raw) return null;
    const settings = JSON.parse(raw);
    await invoke("write_client_settings", { settings });
    window.localStorage.removeItem("gustaf.clientSettings");
    return settings;
  };

  // A migration must finish before a newer catalog can be saved.
  let catalogQueue = Promise.resolve();
  const withCatalog = (operation) => {
    const result = catalogQueue.then(operation);
    catalogQueue = result.catch(() => {});
    return result;
  };

  window.gustafShell = Object.freeze({
    version: __GUSTAF_VERSION__,
    updater,
    pickFolder,
    droppedPaths,
  });

  // Same surface the web client expects from Electron's preload. Methods we have
  // not ported yet stay absent; callers use optional chaining. `preview` is omitted
  // on purpose (in-app browser is a separate project).
  window.desktopBridge = {
    getPathForFile: () => null,
    revealWindow: () => invoke("reveal_window"),
    setNotificationBadge: async () => {},
    onNotificationBadgeClear: () => () => {},
    onTrackpadScrollBegin: () => () => {},
    onTrackpadScrollEnd: () => () => {},
    getWindowFullscreenState: () => fullscreen,
    onWindowFullscreenStateChange: (listener) => {
      fullscreenListeners.add(listener);
      return () => fullscreenListeners.delete(listener);
    },
    getWindowZoomFactor: () => 1,
    onQuitShortcut: () => () => {},
    // SSH environments are not ported; the page subscribes while it starts.
    onSshPasswordPrompt: () => () => {},
    resolveSshPasswordPrompt: async () => {},
    getSystemLocale: () => navigator.language || "en-US",
    getPreferredSystemLanguages: () => Array.from(navigator.languages || []),
    // Sync, like Electron's preload: the shell bakes the launch bootstraps into this script.
    getLocalEnvironmentBootstraps: () => __GUSTAF_BOOTSTRAPS__.map((entry) => ({ ...entry })),
    // No setLocalEnvironmentEnabled: the shell cannot run without its server, and the
    // Settings row hides itself when the call is absent.
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBearerToken: () => invoke("local_environment_bearer_token"),
    getClientSettings,
    setClientSettings: (settings) => invoke("write_client_settings", { settings }),
    getConnectionCatalog: () => withCatalog(async () => {
      const saved = await invoke("read_connection_catalog");
      if (saved !== null) {
        window.localStorage.removeItem("gustaf.connectionCatalog");
        return saved;
      }
      const legacy = window.localStorage.getItem("gustaf.connectionCatalog");
      if (legacy === null) return null;
      await invoke("write_connection_catalog", { catalog: legacy });
      window.localStorage.removeItem("gustaf.connectionCatalog");
      return legacy;
    }),
    setConnectionCatalog: (catalog) => withCatalog(async () => {
      if (typeof catalog !== "string") return false;
      await invoke("write_connection_catalog", { catalog });
      window.localStorage.removeItem("gustaf.connectionCatalog");
      return true;
    }),
    ...(__GUSTAF_PLATFORM__ === "darwin" ? {
      getPreventSleep: () => invoke("get_prevent_sleep"),
      setPreventSleep: (enabled) => invoke("set_prevent_sleep", { enabled }),
    } : {}),
    getServerExposureState: () => invoke("server_exposure_state"),
    setServerExposureMode: (mode) => invoke("set_server_exposure_mode", { mode }),
    setTailscaleServeEnabled: (input) =>
      invoke("set_tailscale_serve_enabled", {
        enabled: Boolean(input?.enabled),
        port: input?.port ?? null,
      }),
    getAdvertisedEndpoints: () => invoke("advertised_endpoints"),
    pickFolder,
    // Context menus: the page draws its own (see localApi.ts); there is no native one yet.
    showContextMenu: async () => null,
    cancelProviderAuthCallback: async () => {},
    readMedia: async () => null,
    // No pickThemeFiles: the theme dialog then uses the page's own file input.
    onMenuAction: () => () => {},
    pasteAsText: async () => false,
    setTheme: (theme) => invoke("set_window_theme", { theme }),
    openExternal: updater.openExternal,
    openSystemSettings: async () => false,
    checkSystemPermission: async () => false,
    getWslState: async () => ({
      enabled: false,
      distro: null,
      available: false,
      wslOnly: false,
      distros: [],
      preflightError: null,
    }),
    setWslBackendEnabled: async () => ({
      enabled: false,
      distro: null,
      available: false,
      wslOnly: false,
      distros: [],
      preflightError: null,
    }),
    setWslDistro: async () => ({
      enabled: false,
      distro: null,
      available: false,
      wslOnly: false,
      distros: [],
      preflightError: null,
    }),
    setWslOnly: async () => ({
      enabled: false,
      distro: null,
      available: false,
      wslOnly: false,
      distros: [],
      preflightError: null,
    }),
    getUpdateState: updater.getUpdateState,
    setUpdateChannel: async () => updater.getUpdateState(),
    checkForUpdate: updater.checkForUpdate,
    downloadUpdate: updater.downloadUpdate,
    installUpdate: updater.installUpdate,
    onUpdateState: updater.onUpdateState,
    getClientPlatform: () => __GUSTAF_PLATFORM__,
    getAppBranding: () => ({
      baseName: "Gustaf",
      stageLabel: "Beta",
      displayName: "Gustaf",
    }),
    getRelayTelemetryEnabled: () => false,
    cliCommand: {
      getState: async () => ({
        supported: false,
        installedPath: null,
        onPath: false,
        launcherPath: null,
      }),
      install: async () => {
        throw new Error("CLI install is not available in this Gustaf build yet.");
      },
      uninstall: async () => {
        throw new Error("CLI uninstall is not available in this Gustaf build yet.");
      },
      addToPath: async () => {
        throw new Error("Adding the CLI to PATH is not available in this Gustaf build yet.");
      },
    },
    webLinks: {
      setReady: async () => {},
      onOpen: () => () => {},
    },
    appActivation: {
      setReady: async () => {},
      complete: async () => {},
      onRequest: () => () => {},
    },
  };

  // A system web view has no Notification. The system shows these itself, and a click
  // on one brings the app forward, so there is no click event to deliver.
  class ShellNotification extends EventTarget {
    static get permission() {
      return "granted";
    }
    static set permission(_value) {}
    static requestPermission() {
      return Promise.resolve("granted");
    }
    constructor(title, options = {}) {
      super();
      this.title = String(title);
      this.body = typeof options.body === "string" ? options.body : "";
      this.tag = typeof options.tag === "string" ? options.tag : "";
      this.onclick = null;
      this.onclose = null;
      this.onerror = null;
      this.onshow = null;
      invoke("plugin:notification|notify", {
        options: { title: this.title, ...(this.body ? { body: this.body } : {}) },
      }).catch(() => this.dispatchEvent(new Event("error")));
    }
    close() {}
  }
  Object.defineProperty(window, "Notification", {
    value: ShellNotification,
    writable: false,
    configurable: false,
  });
})();
"#;

pub(crate) fn init_script(
    version: &str,
    bootstraps_json: &serde_json::Value,
    platform: &str,
) -> String {
    let version = serde_json::to_string(version).unwrap_or_else(|_| "null".to_owned());
    let bootstraps = serde_json::to_string(bootstraps_json).unwrap_or_else(|_| "[]".to_owned());
    let platform = serde_json::to_string(platform).unwrap_or_else(|_| "\"darwin\"".to_owned());
    INIT_SCRIPT
        .replace("__GUSTAF_VERSION__", &version)
        .replace("__GUSTAF_BOOTSTRAPS__", &bootstraps)
        .replace("__GUSTAF_PLATFORM__", &platform)
}

#[tauri::command]
pub(crate) fn reveal_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn window_fullscreen_state(window: tauri::WebviewWindow) -> Result<bool, String> {
    window.is_fullscreen().map_err(|error| error.to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WindowTheme {
    Light,
    Dark,
    System,
}

#[tauri::command]
pub(crate) fn set_window_theme(
    window: tauri::WebviewWindow,
    theme: WindowTheme,
) -> Result<(), String> {
    let theme = match theme {
        WindowTheme::Light => Some(tauri::Theme::Light),
        WindowTheme::Dark => Some(tauri::Theme::Dark),
        WindowTheme::System => None,
    };
    window.set_theme(theme).map_err(|error| error.to_string())
}

// Serialize writes so a rapid series of settings changes cannot share a temp file.
pub(crate) struct ClientSettingsFile(pub std::sync::Mutex<()>);

fn client_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join("client-settings.json"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn read_client_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, ClientSettingsFile>,
) -> Result<Option<serde_json::Value>, String> {
    let _guard = state.0.lock().map_err(|error| error.to_string())?;
    match std::fs::read(client_settings_path(&app)?) {
        Ok(raw) => serde_json::from_slice(&raw)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub(crate) fn write_client_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, ClientSettingsFile>,
    settings: serde_json::Value,
) -> Result<(), String> {
    if !settings.is_object() {
        return Err("Client settings must be an object".to_owned());
    }
    let _guard = state.0.lock().map_err(|error| error.to_string())?;
    let path = client_settings_path(&app)?;
    let parent = path.parent().ok_or("Missing settings directory")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let raw = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, raw).map_err(|error| error.to_string())?;
    std::fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn drag_window(window: tauri::WebviewWindow, double_click: bool) -> Result<(), String> {
    if double_click {
        if window.is_maximized().map_err(|error| error.to_string())? {
            window.unmaximize().map_err(|error| error.to_string())
        } else {
            window.maximize().map_err(|error| error.to_string())
        }
    } else {
        window.start_dragging().map_err(|error| error.to_string())
    }
}

/// Schemes that belong to another app: editors opened on a remote path, and mail.
const HANDOFF_SCHEMES: [&str; 7] = [
    "cursor",
    "vscode",
    "vscode-insiders",
    "vscodium",
    "zed",
    "jetbrains",
    "mailto",
];

/// A web view cannot load these, so a link to them did nothing.
pub(crate) fn is_handoff_url(url: &tauri::Url) -> bool {
    HANDOFF_SCHEMES.contains(&url.scheme())
}

/// A download must not replace a file the user already has.
pub(crate) fn free_destination(wanted: &Path) -> PathBuf {
    let (Some(parent), Some(stem)) = (wanted.parent(), wanted.file_stem()) else {
        return wanted.to_owned();
    };
    let extension = wanted.extension();
    let mut candidate = wanted.to_owned();
    let mut copy = 1;
    while candidate.exists() && copy < 1000 {
        let mut name = stem.to_owned();
        name.push(format!(" ({copy})"));
        if let Some(extension) = extension {
            name.push(".");
            name.push(extension);
        }
        candidate = parent.join(name);
        copy += 1;
    }
    candidate
}

/// The page gets a dropped folder as a `File` without a path. The drag
/// pasteboard still names what the last drag carried, so the page asks here.
#[cfg(target_os = "macos")]
fn drag_pasteboard_paths() -> Vec<String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag, NSPasteboardTypeFileURL};
    use objc2_foundation::NSURL;

    let mut paths = Vec::new();
    #[allow(unused_unsafe)]
    unsafe {
        let pasteboard = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);
        let Some(items) = pasteboard.pasteboardItems() else {
            return paths;
        };
        for item in items.iter() {
            let Some(text) = item.stringForType(NSPasteboardTypeFileURL) else {
                continue;
            };
            // Finder hands out file reference URLs (`file:///.file/id=…`); only NSURL resolves them.
            let path = NSURL::URLWithString(&text)
                .and_then(|url| url.filePathURL())
                .and_then(|url| url.path());
            if let Some(path) = path {
                paths.push(path.to_string());
            }
        }
    }
    paths
}

#[cfg(not(target_os = "macos"))]
fn drag_pasteboard_paths() -> Vec<String> {
    Vec::new()
}

#[tauri::command]
pub(crate) fn dropped_paths(app: tauri::AppHandle) -> Vec<String> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let asked = app.run_on_main_thread(move || {
        let _ = send.send(drag_pasteboard_paths());
    });
    if asked.is_err() {
        return Vec::new();
    }
    receive
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{free_destination, init_script, is_handoff_url};

    #[test]
    fn the_page_is_told_the_app_version_as_a_string() {
        let script = init_script("0.8.3\"; alert(1); \"", &serde_json::json!([]), "darwin");
        assert!(script.contains(r#"version: "0.8.3\"; alert(1); \"","#));
        assert!(!script.contains("__GUSTAF_VERSION__"));
    }

    #[test]
    fn installs_desktop_bridge_without_preview() {
        let script = init_script(
            "0.8.4",
            &serde_json::json!([{
                "id": "primary",
                "label": "This computer",
                "httpBaseUrl": "http://127.0.0.1:3773",
                "wsBaseUrl": "ws://127.0.0.1:3773",
                "bootstrapToken": "tok",
            }]),
            "darwin",
        );
        assert!(script.contains("window.desktopBridge = {"));
        assert!(!script.contains("preview:"));
        assert!(script.contains("getLocalEnvironmentBootstraps"));
        assert!(script.contains("http://127.0.0.1:3773"));
        assert!(!script.contains("__GUSTAF_BOOTSTRAPS__"));
    }

    #[test]
    fn editor_and_mail_links_go_to_their_app() {
        for url in [
            "vscode://vscode-remote/ssh-remote+host/home/me/app",
            "cursor://vscode-remote/ssh-remote+host/home/me/app",
            "mailto:someone@example.com",
        ] {
            assert!(is_handoff_url(&url.parse().unwrap()), "{url}");
        }
        for url in [
            "http://127.0.0.1:3773/",
            "https://example.com/",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "about:blank",
        ] {
            assert!(!is_handoff_url(&url.parse().unwrap()), "{url}");
        }
    }

    #[test]
    fn a_download_never_replaces_an_existing_file() {
        let dir = std::env::temp_dir().join(format!("gustaf-download-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wanted = dir.join("report.tar.gz");
        assert_eq!(free_destination(&wanted), wanted);
        std::fs::write(&wanted, b"").unwrap();
        assert_eq!(free_destination(&wanted), dir.join("report.tar (1).gz"));
        std::fs::write(dir.join("report.tar (1).gz"), b"").unwrap();
        assert_eq!(free_destination(&wanted), dir.join("report.tar (2).gz"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
