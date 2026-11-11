//! What the web app cannot do from inside a system web view.
//!
//! The window shows the server's web app, which was written for Electron and for
//! browsers. A system web view is neither: it has no `Notification`, hides the
//! path of a dropped folder, drops downloads, and cannot follow editor links.
//! The script below gives the page the missing pieces under `window.gustafShell`.

use std::path::{Path, PathBuf};

/// Runs in the main frame before the page's own code.
const INIT_SCRIPT: &str = r#"(() => {
  if (window.top !== window || window.gustafShell) return;
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);

  // The shell pushes each update state here (`publish` in updater.rs).
  const updateListeners = new Set();
  window.__gustafUpdateState = (state) => {
    for (const listener of updateListeners) listener(state);
  };

  window.gustafShell = Object.freeze({
    /** The installed app's version; the page's own version is the web client's. */
    version: __GUSTAF_VERSION__,
    /** The update calls of Electron's desktopBridge, for the sidebar button and Settings. */
    updater: Object.freeze({
      getUpdateState: () => invoke("update_state"),
      onUpdateState: (listener) => {
        updateListeners.add(listener);
        return () => updateListeners.delete(listener);
      },
      checkForUpdate: () => invoke("update_check"),
      downloadUpdate: () => invoke("update_download"),
      installUpdate: (expectedVersion) =>
        invoke("update_install", { expectedVersion: expectedVersion ?? null }),
      // The shell opens every new window in the system browser.
      openExternal: async (url) => {
        window.open(url, "_blank");
        return true;
      },
    }),
    /** Native folder dialog; null when the user cancels. */
    pickFolder: async (options) => {
      const picked = await invoke("plugin:dialog|open", {
        options: {
          directory: true,
          multiple: false,
          ...(options?.initialPath ? { defaultPath: options.initialPath } : {}),
        },
      });
      return typeof picked === "string" && picked.length > 0 ? picked : null;
    },
    /** Absolute paths of what the last drag carried; empty where the system does not tell. */
    droppedPaths: async () => {
      const paths = await invoke("dropped_paths");
      return Array.isArray(paths) ? paths.filter((path) => typeof path === "string") : [];
    },
  });

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

pub(crate) fn init_script(version: &str) -> String {
    let version = serde_json::to_string(version).unwrap_or_else(|_| "null".to_owned());
    INIT_SCRIPT.replace("__GUSTAF_VERSION__", &version)
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
        let script = init_script("0.8.3\"; alert(1); \"");
        assert!(script.contains(r#"version: "0.8.3\"; alert(1); \"","#));
        assert!(!script.contains("__GUSTAF_VERSION__"));
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
