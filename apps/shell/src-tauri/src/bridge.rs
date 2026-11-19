//! What the web app cannot do from inside a system web view.
//!
//! The window shows the server's web app, which was written for a desktop bridge
//! and for browsers. A system web view is neither: it has no `Notification`, hides
//! the path of a dropped folder, drops downloads, and cannot follow editor links.
//! The script below installs `window.desktopBridge` (so the page treats Gustaf as
//! the desktop app) and keeps `window.gustafShell` for shell-only helpers.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

/// Runs in the main frame before the page's own code.
const INIT_SCRIPT: &str = r#"(() => {
  if (window.top !== window || window.gustafShell) return;
  // The script runs on every page the window loads. Only the page of the server the shell
  // started may get the bridge: it carries the token that signs this window in. Another
  // local port (an app an agent runs) is a different origin and gets nothing.
  if (window.location.origin !== __GUSTAF_APP_ORIGIN__) return;
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

  const snapShotListeners = new Set();
  window.__gustafSnapShotEvent = (event) => {
    for (const listener of snapShotListeners) listener(event);
  };
  const snapShot = (action, input = {}) => invoke("snap_shot_command", { action, input });
  const configureSnapShot = (settings) => snapShot("configure", settings || {}).catch(console.error);

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
    openExternal: (url) => invoke("open_external", { url: String(url) }),
  });

  const invokeCli = (command) =>
    invoke(command).catch((error) => {
      throw error instanceof Error ? error : new Error(String(error));
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
  const setFullscreen = (value) => {
    if (fullscreen === value) return;
    fullscreen = value;
    for (const listener of fullscreenListeners) listener(value);
  };
  let fullscreenRequest = 0;
  // A push is newer than any seed answer still in flight, so that answer must not overwrite it.
  window.__gustafFullscreenState = (value) => {
    fullscreenRequest++;
    setFullscreen(value);
  };
  const refreshFullscreen = async () => {
    const request = ++fullscreenRequest;
    try {
      const value = await invoke("window_fullscreen_state");
      if (request === fullscreenRequest) setFullscreen(value);
    } catch (error) {
      console.error(error);
    }
  };
  // The shell pushes later changes (`push_fullscreen`); this only seeds a freshly loaded page.
  refreshFullscreen();

  // Migrate the previous, port-specific browser settings only after saving succeeds.
  const getClientSettings = async () => {
    const saved = await invoke("read_client_settings");
    if (saved !== null) {
      await configureSnapShot(saved);
      return saved;
    }
    const raw = window.localStorage.getItem("gustaf.clientSettings");
    if (!raw) return null;
    const settings = JSON.parse(raw);
    await invoke("write_client_settings", { settings });
    window.localStorage.removeItem("gustaf.clientSettings");
    await configureSnapShot(settings);
    return settings;
  };

  // A migration must finish before a newer catalog can be saved.
  let catalogQueue = Promise.resolve();
  const withCatalog = (operation) => {
    const result = catalogQueue.then(operation);
    catalogQueue = result.catch(() => {});
    return result;
  };

  // The cloud account lives in the shell; the page sees state, never the session token. Only the
  // relay client gets this computer's device token, to reach other computers through the relay.
  const relayClient = Object.freeze({
    credential: () => invoke("relay_client_credential"),
    getItem: (key) => invoke("relay_client_storage_get", { key: String(key) }),
    setItem: (key, value) =>
      invoke("relay_client_storage_set", { key: String(key), value: String(value) }),
  });
  const account = Object.freeze({
    getState: () => invoke("account_state"),
    signIn: () => invoke("account_sign_in"),
    cancelSignIn: () => invoke("account_cancel_sign_in"),
    signOut: () => invoke("account_sign_out"),
    listDevices: () => invoke("account_devices"),
    registerThisComputer: () => invoke("account_register_device"),
    revokeDevice: (deviceId) => invoke("account_revoke_device", { deviceId }),
    reportProblem: ({ message, attachLogs }) =>
      invoke("account_report_problem", { message, attachLogs }),
    relayClient,
  });

  window.gustafShell = Object.freeze({
    version: __GUSTAF_VERSION__,
    updater,
    account,
    pickFolder,
    droppedPaths,
    // The cloud's announcements, minimum version and flags; the shell adds any credential.
    clientConfig: () => invoke("client_config"),
  });

  // Same surface the web client expects from Electron's preload. Methods we have
  // not ported yet stay absent; callers use optional chaining. `preview` is omitted
  // on purpose: it is Electron's browser; this shell offers `nativeBrowser` instead.
  const sshPromptListeners = new Set();
  window.__gustafSshPasswordPrompt = (request) => {
    for (const listener of sshPromptListeners) listener(request);
  };
  const ssh = (method, input) => invoke("ssh_request", {
    method, input: input ?? null, locale: document.documentElement?.lang || navigator.language || "en",
  });

  // Browser tabs drawn by Chromium over the page (native_browser.rs), when the app has it.
  const nativeBrowser = (() => {
    if (!__GUSTAF_RENDERS_SERVER_TABS__) return undefined;
    const stateListeners = new Set();
    const linkListeners = new Set();
    window.__gustafNativeBrowserState = (state) => {
      for (const listener of stateListeners) listener(state);
    };
    window.__gustafNativeBrowserOpenLink = (event) => {
      for (const listener of linkListeners) listener(event);
    };
    // A reload leaves the views of the previous page behind; the app recreates the ones it still has.
    const ready = invoke("native_browser_close_all").catch(console.error);
    const call = (command, args) => ready.then(() => invoke(command, args));
    const listen = (listeners) => (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    return Object.freeze({
      createTab: (tabId, input) => call("native_browser_create", { input: { ...input, tabId } }),
      closeTab: (tabId) => call("native_browser_close", { tabId }),
      present: (tabId, presentation) =>
        call("native_browser_present", {
          tabId,
          rect: presentation?.rect ?? null,
          cornerRadius: presentation?.cornerRadius ?? 0,
        }),
      navigate: (tabId, url) => call("native_browser_navigate", { tabId, url }),
      goBack: (tabId) => call("native_browser_history", { tabId, delta: -1 }),
      goForward: (tabId) => call("native_browser_history", { tabId, delta: 1 }),
      refresh: (tabId) => call("native_browser_reload", { tabId, hard: false }),
      hardReload: (tabId) => call("native_browser_reload", { tabId, hard: true }),
      setZoomFactor: (tabId, zoomFactor) => call("native_browser_set_zoom", { tabId, zoomFactor }),
      setColorScheme: (tabId, colorScheme) =>
        call("native_browser_set_color_scheme", { tabId, colorScheme }),
      openDevTools: (tabId) => call("native_browser_open_devtools", { tabId }),
      clearCookies: (profileId) =>
        call("native_browser_clear_data", { profileId: profileId ?? null, kind: "cookies" }),
      clearCache: (profileId) =>
        call("native_browser_clear_data", { profileId: profileId ?? null, kind: "cache" }),
      onStateChange: listen(stateListeners),
      onOpenLink: listen(linkListeners),
    });
  })();

  // Remove or reinstall the built-in browser (browser_module.rs); each restarts the app.
  const builtInBrowser =
    __GUSTAF_PLATFORM__ === "darwin"
      ? Object.freeze({
          state: () => invoke("browser_module_state"),
          remove: () => invoke("browser_module_remove"),
          install: () => invoke("browser_module_install"),
        })
      : undefined;

  window.desktopBridge = {
    ...(nativeBrowser ? { nativeBrowser } : {}),
    ...(builtInBrowser ? { builtInBrowser } : {}),
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
    // The shell has no app zoom, so the page is always at 1.
    getWindowZoomFactor: () => 1,
    onQuitShortcut: () => () => {},
    discoverSshHosts: () => ssh("discover"),
    resolveSshHost: (alias) => ssh("resolve", alias),
    ensureSshEnvironment: async (target, options) => {
      const result = await ssh("ensure", { target, options });
      if (result.type === "ssh-password-prompt-cancelled") throw new Error(result.message);
      return result;
    },
    disconnectSshEnvironment: (target) => ssh("disconnect", target),
    fetchSshEnvironmentDescriptor: (httpBaseUrl) => ssh("descriptor", { httpBaseUrl }),
    bootstrapSshBearerSession: (httpBaseUrl, credential) => ssh("bootstrap", { httpBaseUrl, credential }),
    fetchSshSessionState: (httpBaseUrl, bearerToken) => ssh("session", { httpBaseUrl, bearerToken }),
    onSshPasswordPrompt: (listener) => {
      sshPromptListeners.add(listener);
      return () => sshPromptListeners.delete(listener);
    },
    resolveSshPasswordPrompt: (requestId, password) => ssh("resolve-password", { requestId, password }),
    getSystemLocale: () => navigator.language || "en-US",
    getPreferredSystemLanguages: () => Array.from(navigator.languages || []),
    // Sync, like Electron's preload: the shell bakes the launch bootstraps into this script.
    getLocalEnvironmentBootstraps: () => __GUSTAF_BOOTSTRAPS__.map((entry) => ({ ...entry })),
    // No setLocalEnvironmentEnabled: the shell cannot run without its server, and the
    // Settings row hides itself when the call is absent.
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBearerToken: () => invoke("local_environment_bearer_token"),
    getClientSettings,
    setClientSettings: async (settings) => {
      await invoke("write_client_settings", { settings });
      await configureSnapShot(settings);
    },
    getSnapShotState: () => snapShot("state"),
    requestSnapShotPermissions: (includeAccessibility) => snapShot("permissions", { includeAccessibility }),
    setupSnapShot: (action) => snapShot("setup", { action }),
    checkSnapShotShortcut: (shortcut) => snapShot("check", { shortcut }),
    setSnapShotShortcutSuppressed: (suppressed) => snapShot("suppress", { suppressed }),
    listPendingSnapShots: () => snapShot("list"),
    readSnapShot: (id) => snapShot("read", { id }),
    acknowledgeSnapShot: (id) => snapShot("acknowledge", { id }),
    setSnapShotAnimationDestination: () => snapShot("animation"),
    dismissSnapShotAnimation: () => snapShot("animation"),
    onSnapShotEvent: (listener) => {
      snapShotListeners.add(listener);
      return () => snapShotListeners.delete(listener);
    },
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
    openSystemSettings: (pane) => invoke("open_system_settings", { pane }),
    checkSystemPermission: (pane) => invoke("check_system_permission", { pane }),
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
    // The shell answers with a plain string on failure; Settings shows an Error's message.
    cliCommand: {
      getState: () => invoke("cli_command_state"),
      install: () => invokeCli("cli_command_install"),
      uninstall: () => invokeCli("cli_command_uninstall"),
      addToPath: () => invokeCli("cli_command_add_to_path"),
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
    app_origin: &str,
    version: &str,
    bootstraps_json: &serde_json::Value,
    platform: &str,
    renders_server_tabs: bool,
) -> String {
    let app_origin = serde_json::to_string(app_origin).unwrap_or_else(|_| "null".to_owned());
    let version = serde_json::to_string(version).unwrap_or_else(|_| "null".to_owned());
    let bootstraps = serde_json::to_string(bootstraps_json).unwrap_or_else(|_| "[]".to_owned());
    let platform = serde_json::to_string(platform).unwrap_or_else(|_| "\"darwin\"".to_owned());
    INIT_SCRIPT
        .replace("__GUSTAF_APP_ORIGIN__", &app_origin)
        .replace("__GUSTAF_VERSION__", &version)
        .replace("__GUSTAF_BOOTSTRAPS__", &bootstraps)
        .replace("__GUSTAF_PLATFORM__", &platform)
        .replace("__GUSTAF_RENDERS_SERVER_TABS__", &renders_server_tabs.to_string())
}

#[tauri::command]
pub(crate) fn reveal_window(window: tauri::Window) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn window_fullscreen_state(window: tauri::Window) -> Result<bool, String> {
    window.is_fullscreen().map_err(|error| error.to_string())
}

/// `SystemSettingsPane` in `packages/contracts/src/ipc.ts`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SystemSettingsPane {
    FullDiskAccess,
}

/// The page asks whether the system took the link, so the answer is the opener's real exit status.
#[tauri::command]
pub(crate) async fn open_external(url: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        url.parse::<tauri::Url>()
            .is_ok_and(|url| crate::open_external_url_checked(&url))
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
pub(crate) async fn open_system_settings(pane: SystemSettingsPane) -> bool {
    #[cfg(target_os = "macos")]
    {
        let SystemSettingsPane::FullDiskAccess = pane;
        tauri::async_runtime::spawn_blocking(|| {
            std::process::Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
                .spawn()
                .is_ok_and(|child| crate::opener_succeeded(child, crate::OPENER_GRACE))
        })
        .await
        .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let SystemSettingsPane::FullDiskAccess = pane;
        false
    }
}

/// Files only a process with Full Disk Access can open; the first that opens settles it.
#[cfg(target_os = "macos")]
fn full_disk_access_probes() -> Vec<std::io::Result<()>> {
    let mut probes =
        vec![std::fs::File::open("/Library/Application Support/com.apple.TCC/TCC.db").map(drop)];
    if let Some(home) = std::env::var_os("HOME") {
        probes.push(std::fs::read_dir(Path::new(&home).join("Library/Safari")).map(drop));
    }
    probes
}

fn any_probe_opened(probes: &[std::io::Result<()>]) -> bool {
    probes.iter().any(Result::is_ok)
}

/// Only macOS gates files behind a permission; elsewhere there is nothing to grant.
#[tauri::command]
pub(crate) fn check_system_permission(pane: SystemSettingsPane) -> bool {
    let SystemSettingsPane::FullDiskAccess = pane;
    #[cfg(target_os = "macos")]
    {
        any_probe_opened(&full_disk_access_probes())
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// True when `now` differs from what was last pushed; remembers `now`.
fn fullscreen_changed(last: &AtomicBool, now: bool) -> bool {
    last.swap(now, Ordering::SeqCst) != now
}

/// Tells the page when the window enters or leaves fullscreen, so it need not ask on every resize.
pub(crate) fn push_fullscreen(app: &tauri::AppHandle) {
    static LAST: AtomicBool = AtomicBool::new(false);
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(now) = window.is_fullscreen() else {
        return;
    };
    if fullscreen_changed(&LAST, now) {
        let _ = window.eval(format!("window.__gustafFullscreenState?.({now})"));
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WindowTheme {
    Light,
    Dark,
    System,
}

#[tauri::command]
pub(crate) fn set_window_theme(window: tauri::Window, theme: WindowTheme) -> Result<(), String> {
    let theme = match theme {
        WindowTheme::Light => Some(tauri::Theme::Light),
        WindowTheme::Dark => Some(tauri::Theme::Dark),
        WindowTheme::System => None,
    };
    window.set_theme(theme).map_err(|error| error.to_string())
}

// Serialize writes so a rapid series of settings changes cannot share a temp file.
pub(crate) struct ClientSettingsFile(pub std::sync::Mutex<()>);

pub(crate) fn client_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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
pub(crate) fn drag_window(window: tauri::Window, double_click: bool) -> Result<(), String> {
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
    use super::{
        any_probe_opened, free_destination, fullscreen_changed, init_script, is_handoff_url,
        SystemSettingsPane,
    };
    use std::io::{Error, ErrorKind};

    #[test]
    fn the_permission_is_granted_once_a_protected_file_opens() {
        let denied = || Err(Error::from(ErrorKind::PermissionDenied));
        assert!(!any_probe_opened(&[]));
        assert!(!any_probe_opened(&[
            denied(),
            Err(Error::from(ErrorKind::NotFound))
        ]));
        assert!(any_probe_opened(&[denied(), Ok(())]));
    }

    #[test]
    fn the_page_names_the_pane_the_way_the_contract_does() {
        let pane: SystemSettingsPane = serde_json::from_str(r#""full-disk-access""#).unwrap();
        assert!(matches!(pane, SystemSettingsPane::FullDiskAccess));
        assert!(serde_json::from_str::<SystemSettingsPane>(r#""camera""#).is_err());
    }

    use std::sync::atomic::AtomicBool;

    const ORIGIN: &str = "http://127.0.0.1:3773";

    /// Runs the init script in node as a page at `origin`; true when it got the bridge.
    fn bridge_installed_at(origin: &str) -> bool {
        use std::io::Write;
        const HARNESS: &str = r#"
const script = require("fs").readFileSync(0, "utf8");
const window = {
  location: { origin: process.argv[1] },
  localStorage: { getItem: () => null, removeItem() {} },
  __TAURI_INTERNALS__: { invoke: () => new Promise(() => {}) },
};
window.top = window;
const document = { addEventListener() {}, documentElement: {} };
new Function("window", "document", "navigator", script)(window, document, { language: "en" });
console.log(window.desktopBridge !== undefined || window.gustafShell !== undefined);
"#;
        let mut node = std::process::Command::new("node")
            .args(["-e", HARNESS, origin])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("node runs the init script");
        let bootstraps = serde_json::json!([{ "bootstrapToken": "tok" }]);
        let script = init_script(ORIGIN, "0.8.4", &bootstraps, "darwin", false);
        node.stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        let output = node.wait_with_output().unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim() == "true"
    }

    #[test]
    fn only_the_servers_own_origin_gets_the_bridge() {
        assert!(bridge_installed_at(ORIGIN));
        for origin in [
            "http://127.0.0.1:3000",
            "http://localhost:3773",
            "http://[::1]:3773",
            "https://127.0.0.1:3773",
            "null",
        ] {
            assert!(!bridge_installed_at(origin), "{origin}");
        }
    }

    #[test]
    fn the_page_hears_only_fullscreen_changes() {
        let last = AtomicBool::new(false);
        assert!(!fullscreen_changed(&last, false));
        assert!(fullscreen_changed(&last, true));
        assert!(!fullscreen_changed(&last, true));
        assert!(fullscreen_changed(&last, false));
    }

    /// Runs the init script in node with a fake window. The seed query answers `false`
    /// only after the shell has pushed `true`; returns what the page believes at the end.
    fn page_fullscreen_after_late_seed_answer() -> String {
        use std::io::Write;
        const HARNESS: &str = r#"
const script = require("fs").readFileSync(0, "utf8");
let answerSeed;
const window = {
  location: { origin: "http://127.0.0.1:3773" },
  localStorage: { getItem: () => null, removeItem() {} },
  __TAURI_INTERNALS__: {
    invoke: (command) =>
      command === "window_fullscreen_state"
        ? new Promise((resolve) => { answerSeed = resolve; })
        : new Promise(() => {}),
  },
};
window.top = window;
const document = { addEventListener() {}, documentElement: {} };
new Function("window", "document", "navigator", script)(window, document, { language: "en" });
(async () => {
  window.__gustafFullscreenState(true);
  answerSeed(false);
  await new Promise((resolve) => setImmediate(resolve));
  console.log(window.desktopBridge.getWindowFullscreenState());
})();
"#;
        let mut node = std::process::Command::new("node")
            .args(["-e", HARNESS])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("node runs the init script");
        let script = init_script(ORIGIN, "0.8.4", &serde_json::json!([]), "darwin", false);
        node.stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        let output = node.wait_with_output().unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    #[test]
    fn a_late_seed_answer_does_not_undo_a_pushed_fullscreen_change() {
        assert_eq!(page_fullscreen_after_late_seed_answer(), "true");
    }

    #[test]
    fn the_page_no_longer_asks_on_every_resize() {
        let script = init_script(ORIGIN, "0.8.4", &serde_json::json!([]), "darwin", false);
        assert!(!script.contains(r#"addEventListener("resize""#));
    }

    #[test]
    fn the_page_is_told_the_app_version_as_a_string() {
        let script = init_script(
            ORIGIN,
            "0.8.3\"; alert(1); \"",
            &serde_json::json!([]),
            "darwin",
            false,
        );
        assert!(script.contains(r#"version: "0.8.3\"; alert(1); \"","#));
        assert!(!script.contains("__GUSTAF_VERSION__"));
    }

    #[test]
    fn installs_desktop_bridge_without_preview() {
        let script = init_script(
            ORIGIN,
            "0.8.4",
            &serde_json::json!([{
                "id": "primary",
                "label": "This computer",
                "httpBaseUrl": "http://127.0.0.1:3773",
                "wsBaseUrl": "ws://127.0.0.1:3773",
                "bootstrapToken": "tok",
            }]),
            "darwin",
            false,
        );
        assert!(script.contains("window.desktopBridge = {"));
        assert!(!script.contains("__GUSTAF_RENDERS_SERVER_TABS__"));
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
