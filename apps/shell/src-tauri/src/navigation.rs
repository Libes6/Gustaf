//! The window shows the app from its own server. A page from anywhere else that loads in the
//! main frame replaces the app with no way back, so it goes to the system browser instead.
//!
//! Frames inside the app (HTML renders, MCP apps, files of a remote environment) load from other
//! origins on purpose, and the web views call the same handler for them. Only a navigation known
//! to be in the main frame is redirected; where the platform cannot say, it is left alone.

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MainFrameNavigation {
    Allow,
    OpenInBrowser,
    Refuse,
}

pub(crate) fn decide(app_url: &tauri::Url, url: &tauri::Url) -> MainFrameNavigation {
    if url.as_str() == "about:blank" {
        return MainFrameNavigation::Allow;
    }
    if url.origin() == app_url.origin() {
        return MainFrameNavigation::Allow;
    }
    match url.scheme() {
        "http" | "https" => MainFrameNavigation::OpenInBrowser,
        _ => MainFrameNavigation::Refuse,
    }
}

/// `Some(true)` when the navigation being decided right now targets the main frame,
/// `None` when this platform cannot tell.
pub(crate) fn deciding_main_frame() -> Option<bool> {
    #[cfg(windows)]
    {
        // WebView2 reports frame navigations through a separate event wry does not use.
        Some(true)
    }
    #[cfg(target_os = "macos")]
    {
        macos::deciding_main_frame()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        // WebKitGTK passes no frame with the navigation action.
        None
    }
}

/// Lets `deciding_main_frame` see the frame of each navigation in this window.
pub(crate) fn watch_frames(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let _ = window.with_webview(|webview| macos::install(webview.inner()));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::Cell;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    use objc2::runtime::{AnyObject, Imp, Sel};
    use objc2::{msg_send, sel};

    type DecidePolicy = unsafe extern "C-unwind" fn(
        *mut AnyObject,
        Sel,
        *mut AnyObject,
        *mut AnyObject,
        *mut c_void,
    );

    static ORIGINAL: OnceLock<Imp> = OnceLock::new();
    static INSTALLED: AtomicBool = AtomicBool::new(false);

    thread_local! {
        static SUBFRAME: Cell<bool> = const { Cell::new(false) };
    }

    pub(super) fn deciding_main_frame() -> Option<bool> {
        INSTALLED
            .load(Ordering::SeqCst)
            .then(|| !SUBFRAME.with(Cell::get))
    }

    /// wry's delegate passes Tauri only the URL; this runs first and records the target frame
    /// for the duration of wry's own decision, which calls the navigation handler synchronously.
    unsafe extern "C-unwind" fn decide_policy(
        this: *mut AnyObject,
        selector: Sel,
        webview: *mut AnyObject,
        action: *mut AnyObject,
        decision_handler: *mut c_void,
    ) {
        // A nil target frame is a new window; that is not a frame inside the app.
        let frame: *mut AnyObject = unsafe { msg_send![action, targetFrame] };
        let subframe = !frame.is_null() && {
            let main: bool = unsafe { msg_send![frame, isMainFrame] };
            !main
        };
        let Some(original) = ORIGINAL.get() else {
            return;
        };
        let original: DecidePolicy = unsafe { std::mem::transmute(*original) };
        SUBFRAME.with(|cell| cell.set(subframe));
        unsafe { original(this, selector, webview, action, decision_handler) };
        SUBFRAME.with(|cell| cell.set(false));
    }

    pub(super) fn install(webview: *mut c_void) {
        if webview.is_null() || ORIGINAL.get().is_some() {
            return;
        }
        let webview = webview.cast::<AnyObject>();
        let delegate: *mut AnyObject = unsafe { msg_send![webview, navigationDelegate] };
        let Some(delegate) = (unsafe { delegate.as_ref() }) else {
            return;
        };
        let Some(method) = delegate
            .class()
            .instance_method(sel!(webView:decidePolicyForNavigationAction:decisionHandler:))
        else {
            return;
        };
        if ORIGINAL.set(method.implementation()).is_err() {
            return;
        }
        let hook: DecidePolicy = decide_policy;
        unsafe { method.set_implementation(std::mem::transmute::<DecidePolicy, Imp>(hook)) };
        INSTALLED.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decide_from(app: &str, url: &str) -> MainFrameNavigation {
        decide(&app.parse().unwrap(), &url.parse().unwrap())
    }

    #[test]
    fn the_apps_own_origin_stays_in_the_window() {
        let app = "http://127.0.0.1:3773/";
        for url in [
            "http://127.0.0.1:3773/",
            "http://127.0.0.1:3773/settings/connections?tab=1#x",
            "blob:http://127.0.0.1:3773/5f0c2d4e",
            "about:blank",
        ] {
            assert_eq!(decide_from(app, url), MainFrameNavigation::Allow, "{url}");
        }
    }

    #[test]
    fn other_hosts_ports_and_schemes_go_to_the_browser() {
        let app = "http://127.0.0.1:3773/";
        for url in [
            "https://github.com/Libes6/Gustaf",
            "http://127.0.0.1:3000/",
            "http://localhost:3773/",
            "https://127.0.0.1:3773/",
            "http://127.0.0.1:3773@evil.com/",
            "http://user:pass@127.0.0.1.evil.com:3773/",
        ] {
            assert_eq!(
                decide_from(app, url),
                MainFrameNavigation::OpenInBrowser,
                "{url}"
            );
        }
    }

    #[test]
    fn pages_that_are_not_on_the_web_are_refused() {
        let app = "http://127.0.0.1:3773/";
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "about:srcdoc",
            "ftp://127.0.0.1:3773/",
        ] {
            assert_eq!(decide_from(app, url), MainFrameNavigation::Refuse, "{url}");
        }
    }
}
