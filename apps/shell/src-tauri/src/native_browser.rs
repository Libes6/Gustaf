//! The user's browser tabs as native web views laid over the page (macOS).
//!
//! The page measures each tab's slot and asks for the view to be placed over it, or hidden while
//! something the page draws (a menu, a dialog) has to cover it. Agent tabs stay in the server's
//! browser. Pages loaded here never reach the shell's commands: the IPC grant names only the main
//! web view (`ipc_scope.rs`).
//!
//! Commands are async on purpose: building a web view from a synchronous command, which runs on
//! the main thread, waits on the main thread and deadlocks.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::webview::{DownloadEvent, NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

/// Browser profile ids of `packages/contracts/src/browserProfile.ts`.
const DEFAULT_PROFILE_ID: &str = "default";
const INCOGNITO_PROFILE_ID: &str = "incognito";

#[derive(Default)]
pub(crate) struct NativeBrowser {
    tabs: Mutex<HashMap<String, Tab>>,
    next: AtomicU64,
}

#[derive(Clone)]
struct Tab {
    label: String,
    number: u64,
}

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
pub(crate) struct CreateInput {
    tab_id: String,
    url: Option<String>,
    /// A tab of the server's browser: Chromium draws it and the server drives the same page.
    #[cfg_attr(not(feature = "cef-browser"), allow(dead_code))]
    server_tab: Option<ServerTabKey>,
    profile_id: Option<String>,
    zoom_factor: Option<f64>,
    color_scheme: Option<ColorScheme>,
}

#[cfg(feature = "cef-browser")]
type ServerTabKey = crate::cef::ServerTab;
#[cfg(not(feature = "cef-browser"))]
type ServerTabKey = serde::de::IgnoredAny;

/// Whether Chromium draws this tab rather than WebKit.
async fn chromium_owns(app: &AppHandle, tab_id: &str) -> bool {
    #[cfg(feature = "cef-browser")]
    return crate::cef::owns(app, tab_id).await;
    #[cfg(not(feature = "cef-browser"))]
    {
        let _ = (app, tab_id);
        false
    }
}

#[derive(Clone, Copy, Deserialize)]
pub(crate) struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

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

/// One persistent WebKit data store per browser profile, so profiles keep separate sign-ins and
/// none shares the app window's own store.
pub(crate) fn data_store_identifier(profile_id: &str) -> [u8; 16] {
    let digest = Sha256::digest(format!("gustaf-browser-profile:{profile_id}").as_bytes());
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest[..16]);
    // RFC 9562 version 8 (custom) and variant bits.
    id[6] = (id[6] & 0x0f) | 0x80;
    id[8] = (id[8] & 0x3f) | 0x80;
    id
}

/// Scripts for the main web view, in order. KVO and WebKit delegates fire inside the event loop's
/// own handlers; evaluating from there could re-enter it, so one thread hands them on.
fn send_to_page(app: &AppHandle, script: String) {
    static SENDER: OnceLock<Mutex<mpsc::Sender<String>>> = OnceLock::new();
    let sender = SENDER.get_or_init(|| {
        let (send, receive) = mpsc::channel::<String>();
        let app = app.clone();
        std::thread::spawn(move || {
            for script in receive {
                if let Some(page) = app.get_webview("main") {
                    let _ = page.eval(script);
                }
            }
        });
        Mutex::new(send)
    });
    if let Ok(sender) = sender.lock() {
        let _ = sender.send(script);
    }
}

fn open_link_script(tab_id: &str, url: &tauri::Url) -> String {
    let event = serde_json::json!({ "tabId": tab_id, "url": url.as_str() });
    format!("window.__gustafNativeBrowserOpenLink?.({event})")
}

fn tab(app: &AppHandle, tab_id: &str) -> Result<tauri::Webview, String> {
    let label = app
        .state::<NativeBrowser>()
        .tabs
        .lock()
        .map_err(|error| error.to_string())?
        .get(tab_id)
        .map(|tab| tab.label.clone());
    label
        .and_then(|label| app.get_webview(&label))
        .ok_or_else(|| format!("No browser tab {tab_id}"))
}

#[tauri::command]
pub(crate) async fn native_browser_create(
    app: AppHandle,
    input: CreateInput,
) -> Result<(), String> {
    #[cfg(feature = "cef-browser")]
    if let (Some(server), true) = (input.server_tab.clone(), crate::cef::running()) {
        let url = input
            .url
            .as_deref()
            .and_then(|raw| parse_page_url(raw).ok())
            .map_or_else(|| "about:blank".to_owned(), |url| url.to_string());
        return crate::cef::create(&app, input.tab_id, url, Some(server)).await;
    }
    let state = app.state::<NativeBrowser>();
    let reserved = {
        let mut tabs = state.tabs.lock().map_err(|error| error.to_string())?;
        if let Some(existing) = tabs.get(&input.tab_id) {
            Err(existing.clone())
        } else {
            let number = state.next.fetch_add(1, Ordering::Relaxed) + 1;
            let tab = Tab {
                label: format!("native-browser-{number}"),
                number,
            };
            tabs.insert(input.tab_id.clone(), tab.clone());
            Ok(tab)
        }
    };
    let tab = match reserved {
        Ok(tab) => tab,
        // Asked again by a remount: the tab keeps its page and reports its state once more.
        Err(existing) => {
            if let Some(webview) = app.get_webview(&existing.label) {
                platform::publish(&webview);
            }
            return Ok(());
        }
    };
    let created = build(&app, &input, &tab);
    if created.is_err() {
        if let Ok(mut tabs) = state.tabs.lock() {
            tabs.remove(&input.tab_id);
        }
    }
    created
}

fn build(app: &AppHandle, input: &CreateInput, tab: &Tab) -> Result<(), String> {
    // Not `get_webview_window`: Tauri stops treating a window with child web views as one.
    let window = app.get_window("main").ok_or("The app window is not open")?;
    let url = match input.url.as_deref() {
        Some(raw) => parse_page_url(raw).unwrap_or_else(|_| "about:blank".parse().expect("url")),
        None => "about:blank".parse().expect("url"),
    };
    let link_tab_id = input.tab_id.clone();
    let link_app = app.clone();
    let builder = WebviewBuilder::new(&tab.label, WebviewUrl::External(url))
        .devtools(true)
        .disable_drag_drop_handler()
        .on_navigation(|url| {
            if crate::bridge::is_handoff_url(url) {
                crate::open_external_url(url);
                return false;
            }
            is_page_url(url)
        })
        .on_download(|_webview, event| {
            if let DownloadEvent::Requested { destination, .. } = event {
                *destination = crate::bridge::free_destination(destination);
            }
            true
        })
        // A link that asks for a new window opens as a new tab of the same thread.
        .on_new_window(move |url, _features| {
            if is_page_url(&url) {
                send_to_page(&link_app, open_link_script(&link_tab_id, &url));
            } else if crate::bridge::is_handoff_url(&url) {
                crate::open_external_url(&url);
            }
            NewWindowResponse::Deny
        });
    let profile_id = input.profile_id.as_deref().unwrap_or(DEFAULT_PROFILE_ID);
    let builder = if profile_id == INCOGNITO_PROFILE_ID {
        builder.incognito(true)
    } else {
        // Before macOS 14 WebKit has one persistent store, and every profile shares it.
        #[cfg(target_os = "macos")]
        let builder = builder.data_store_identifier(data_store_identifier(profile_id));
        builder
    };
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| error.to_string())?;
    // Shown once the page reports the slot's place.
    webview.hide().map_err(|error| error.to_string())?;
    if let Some(zoom) = input.zoom_factor.filter(|zoom| *zoom > 0.0) {
        let _ = webview.set_zoom(zoom);
    }
    platform::attach(
        &webview,
        input.tab_id.clone(),
        tab.number,
        input.color_scheme,
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_browser_close(app: AppHandle, tab_id: String) -> Result<(), String> {
    #[cfg(feature = "cef-browser")]
    if chromium_owns(&app, &tab_id).await {
        return crate::cef::close(&app, tab_id).await;
    }
    let removed = app
        .state::<NativeBrowser>()
        .tabs
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&tab_id);
    if let Some(tab) = removed {
        close_webview(&app, &tab);
    }
    Ok(())
}

/// A page load starts from no tabs; the web app creates the ones its threads still have.
#[tauri::command]
pub(crate) async fn native_browser_close_all(app: AppHandle) -> Result<(), String> {
    #[cfg(feature = "cef-browser")]
    if crate::cef::running() {
        crate::cef::close_all(&app).await?;
    }
    let removed: Vec<Tab> = app
        .state::<NativeBrowser>()
        .tabs
        .lock()
        .map_err(|error| error.to_string())?
        .drain()
        .map(|(_, tab)| tab)
        .collect();
    for tab in removed {
        close_webview(&app, &tab);
    }
    Ok(())
}

fn close_webview(app: &AppHandle, tab: &Tab) {
    if let Some(webview) = app.get_webview(&tab.label) {
        platform::detach(&webview);
        let _ = webview.close();
    }
}

#[tauri::command]
pub(crate) async fn native_browser_present(
    app: AppHandle,
    tab_id: String,
    rect: Option<Rect>,
    corner_radius: Option<f64>,
) -> Result<(), String> {
    #[cfg(feature = "cef-browser")]
    if chromium_owns(&app, &tab_id).await {
        let rect = rect
            .filter(|rect| rect.width >= 1.0 && rect.height >= 1.0)
            .map(|rect| (rect.x, rect.y, rect.width, rect.height));
        let radius = corner_radius.unwrap_or(0.0).max(0.0);
        return crate::cef::present(&app, tab_id, rect, radius).await;
    }
    let webview = tab(&app, &tab_id)?;
    let Some(rect) = rect.filter(|rect| rect.width >= 1.0 && rect.height >= 1.0) else {
        return webview.hide().map_err(|error| error.to_string());
    };
    webview
        .set_position(LogicalPosition::new(rect.x, rect.y))
        .map_err(|error| error.to_string())?;
    webview
        .set_size(LogicalSize::new(rect.width, rect.height))
        .map_err(|error| error.to_string())?;
    platform::set_corner_radius(&webview, corner_radius.unwrap_or(0.0).max(0.0));
    webview.show().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn native_browser_navigate(
    app: AppHandle,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    if chromium_owns(&app, &tab_id).await {
        #[cfg(feature = "cef-browser")]
        return crate::cef::with_tab(&app, tab_id, move |tab| crate::cef::navigate(tab, &url)).await;
    }
    let webview = tab(&app, &tab_id)?;
    webview
        .navigate(parse_page_url(&url)?)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn native_browser_history(
    app: AppHandle,
    tab_id: String,
    delta: i32,
) -> Result<(), String> {
    if chromium_owns(&app, &tab_id).await {
        #[cfg(feature = "cef-browser")]
        return crate::cef::with_tab(&app, tab_id, move |tab| crate::cef::history(tab, delta)).await;
    }
    let webview = tab(&app, &tab_id)?;
    platform::history(&webview, delta);
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_browser_reload(
    app: AppHandle,
    tab_id: String,
    hard: bool,
) -> Result<(), String> {
    if chromium_owns(&app, &tab_id).await {
        #[cfg(feature = "cef-browser")]
        return crate::cef::with_tab(&app, tab_id, move |tab| crate::cef::reload(tab, hard)).await;
    }
    let webview = tab(&app, &tab_id)?;
    platform::reload(&webview, hard);
    Ok(())
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
    if chromium_owns(&app, &tab_id).await {
        #[cfg(feature = "cef-browser")]
        return crate::cef::with_tab(&app, tab_id, move |tab| crate::cef::set_zoom(tab, zoom_factor))
            .await;
    }
    let webview = tab(&app, &tab_id)?;
    webview
        .set_zoom(zoom_factor)
        .map_err(|error| error.to_string())?;
    // Page zoom is not key-value observable, so the page hears of it here.
    platform::publish(&webview);
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_browser_set_color_scheme(
    app: AppHandle,
    tab_id: String,
    color_scheme: ColorScheme,
) -> Result<(), String> {
    // Chromium tabs follow the system appearance for now.
    if chromium_owns(&app, &tab_id).await {
        return Ok(());
    }
    let webview = tab(&app, &tab_id)?;
    platform::set_color_scheme(&webview, color_scheme);
    // The page keeps the scheme it asked for and shows it with the next state.
    platform::publish(&webview);
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_browser_open_devtools(
    app: AppHandle,
    tab_id: String,
) -> Result<(), String> {
    if chromium_owns(&app, &tab_id).await {
        #[cfg(feature = "cef-browser")]
        return crate::cef::with_tab(&app, tab_id, crate::cef::open_devtools).await;
    }
    let webview = tab(&app, &tab_id)?;
    webview.open_devtools();
    Ok(())
}

/// Without a profile, clears every profile's store; never the app window's own.
#[tauri::command]
pub(crate) async fn native_browser_clear_data(
    app: AppHandle,
    profile_id: Option<String>,
    kind: DataKind,
) -> Result<(), String> {
    if profile_id.as_deref() == Some(INCOGNITO_PROFILE_ID) {
        // Its store lives only as long as its tabs.
        return Ok(());
    }
    let identifier = profile_id.as_deref().map(data_store_identifier);
    platform::clear_data(&app, identifier, kind)
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;
    use std::ffi::c_void;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
    };
    use objc2_foundation::{
        NSDate, NSKeyValueObservingOptions, NSObjectNSKeyValueObserverRegistration,
        NSOperatingSystemVersion, NSProcessInfo, NSSet, NSString, NSUUID,
    };
    use objc2_web_kit::{
        WKWebView, WKWebsiteDataStore, WKWebsiteDataTypeCookies, WKWebsiteDataTypeDiskCache,
        WKWebsiteDataTypeFetchCache, WKWebsiteDataTypeMemoryCache,
    };
    use tauri::{AppHandle, Manager};

    use super::{ColorScheme, DataKind};

    const KEY_PATHS: [&str; 5] = ["URL", "title", "loading", "canGoBack", "canGoForward"];

    pub(super) struct ObserverIvars {
        app: AppHandle,
        tab_id: String,
        number: u64,
        last: RefCell<String>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements and the class has no Drop impl.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "GustafNativeBrowserObserver"]
        #[ivars = ObserverIvars]
        pub(super) struct TabObserver;

        impl TabObserver {
            #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
            fn observe_value(
                &self,
                _key_path: Option<&NSString>,
                object: Option<&AnyObject>,
                _change: Option<&AnyObject>,
                _context: *mut c_void,
            ) {
                if let Some(webview) = object.and_then(|object| object.downcast_ref::<WKWebView>()) {
                    self.publish(webview);
                }
            }
        }
    );

    impl TabObserver {
        fn new(mtm: MainThreadMarker, ivars: ObserverIvars) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(ivars);
            unsafe { msg_send![super(this), init] }
        }

        fn publish(&self, webview: &WKWebView) {
            let ivars = self.ivars();
            let state = unsafe {
                serde_json::json!({
                    "tabId": ivars.tab_id,
                    "number": ivars.number,
                    "url": webview
                        .URL()
                        .and_then(|url| url.absoluteString())
                        .map(|url| url.to_string())
                        .unwrap_or_default(),
                    "title": webview.title().map(|title| title.to_string()).unwrap_or_default(),
                    "loading": webview.isLoading(),
                    "canGoBack": webview.canGoBack(),
                    "canGoForward": webview.canGoForward(),
                    "zoomFactor": webview.pageZoom(),
                })
            }
            .to_string();
            if *ivars.last.borrow() == state {
                return;
            }
            ivars.last.replace(state.clone());
            super::send_to_page(
                &ivars.app,
                format!("window.__gustafNativeBrowserState?.({state})"),
            );
        }
    }

    thread_local! {
        /// Observers by web view label; only the main thread touches them.
        static OBSERVERS: RefCell<std::collections::HashMap<String, Retained<TabObserver>>> =
            RefCell::default();
    }

    fn with_wk(
        webview: &tauri::Webview,
        f: impl FnOnce(&WKWebView, MainThreadMarker) + Send + 'static,
    ) {
        let _ = webview.with_webview(move |platform| {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            // SAFETY: on macOS `inner` is the WKWebView, alive while its Tauri web view is.
            let webview = unsafe { &*(platform.inner() as *const WKWebView) };
            f(webview, mtm);
        });
    }

    pub(super) fn attach(
        webview: &tauri::Webview,
        tab_id: String,
        number: u64,
        color_scheme: Option<ColorScheme>,
    ) {
        let app = webview.app_handle().clone();
        let label = webview.label().to_owned();
        with_wk(webview, move |wk, mtm| {
            if let Some(color_scheme) = color_scheme {
                apply_color_scheme(wk, color_scheme);
            }
            let observer = TabObserver::new(
                mtm,
                ObserverIvars {
                    app,
                    tab_id,
                    number,
                    last: RefCell::default(),
                },
            );
            for key in KEY_PATHS {
                unsafe {
                    wk.addObserver_forKeyPath_options_context(
                        &observer,
                        &NSString::from_str(key),
                        NSKeyValueObservingOptions::empty(),
                        std::ptr::null_mut(),
                    );
                }
            }
            observer.publish(wk);
            OBSERVERS.with(|observers| observers.borrow_mut().insert(label, observer));
        });
    }

    pub(super) fn detach(webview: &tauri::Webview) {
        let label = webview.label().to_owned();
        with_wk(webview, move |wk, _| {
            let Some(observer) = OBSERVERS.with(|observers| observers.borrow_mut().remove(&label))
            else {
                return;
            };
            for key in KEY_PATHS {
                unsafe { wk.removeObserver_forKeyPath(&observer, &NSString::from_str(key)) };
            }
        });
    }

    pub(super) fn publish(webview: &tauri::Webview) {
        let label = webview.label().to_owned();
        with_wk(webview, move |wk, _| {
            OBSERVERS.with(|observers| {
                if let Some(observer) = observers.borrow().get(&label) {
                    observer.ivars().last.replace(String::new());
                    observer.publish(wk);
                }
            });
        });
    }

    pub(super) fn history(webview: &tauri::Webview, delta: i32) {
        with_wk(webview, move |wk, _| unsafe {
            if delta < 0 {
                wk.goBack();
            } else if delta > 0 {
                wk.goForward();
            }
        });
    }

    pub(super) fn reload(webview: &tauri::Webview, hard: bool) {
        with_wk(webview, move |wk, _| unsafe {
            if hard {
                wk.reloadFromOrigin();
            } else {
                wk.reload();
            }
        });
    }

    pub(super) fn set_corner_radius(webview: &tauri::Webview, radius: f64) {
        with_wk(webview, move |wk, _| {
            wk.setWantsLayer(true);
            if let Some(layer) = wk.layer() {
                if layer.cornerRadius() != radius {
                    layer.setCornerRadius(radius);
                    layer.setMasksToBounds(radius > 0.0);
                }
            }
        });
    }

    fn apply_color_scheme(wk: &WKWebView, color_scheme: ColorScheme) {
        // The view's appearance is what the page's `prefers-color-scheme` follows.
        let appearance = match color_scheme {
            ColorScheme::System => None,
            ColorScheme::Light => NSAppearance::appearanceNamed(unsafe { NSAppearanceNameAqua }),
            ColorScheme::Dark => NSAppearance::appearanceNamed(unsafe { NSAppearanceNameDarkAqua }),
        };
        wk.setAppearance(appearance.as_deref());
    }

    pub(super) fn set_color_scheme(webview: &tauri::Webview, color_scheme: ColorScheme) {
        with_wk(webview, move |wk, _| apply_color_scheme(wk, color_scheme));
    }

    pub(super) fn clear_data(
        app: &AppHandle,
        identifier: Option<[u8; 16]>,
        kind: DataKind,
    ) -> Result<(), String> {
        let version = NSOperatingSystemVersion {
            majorVersion: 14,
            minorVersion: 0,
            patchVersion: 0,
        };
        // The per-profile stores, and the calls that find them, arrived in macOS 14.
        if !NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(version) {
            return Err("Clearing browser data needs macOS 14 or later".to_owned());
        }
        app.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let clear = move |identifier: [u8; 16]| unsafe {
                let store = WKWebsiteDataStore::dataStoreForIdentifier(
                    &NSUUID::from_bytes(identifier),
                    mtm,
                );
                let types: Vec<&NSString> = match kind {
                    DataKind::Cookies => vec![WKWebsiteDataTypeCookies],
                    DataKind::Cache => vec![
                        WKWebsiteDataTypeDiskCache,
                        WKWebsiteDataTypeMemoryCache,
                        WKWebsiteDataTypeFetchCache,
                    ],
                };
                store.removeDataOfTypes_modifiedSince_completionHandler(
                    &NSSet::from_slice(&types),
                    &NSDate::distantPast(),
                    &block2::RcBlock::new(|| {}),
                );
            };
            match identifier {
                Some(identifier) => clear(identifier),
                None => unsafe {
                    WKWebsiteDataStore::fetchAllDataStoreIdentifiers(
                        &block2::RcBlock::new(
                            move |identifiers: std::ptr::NonNull<
                                objc2_foundation::NSArray<NSUUID>,
                            >| {
                                for identifier in identifiers.as_ref().iter() {
                                    clear(identifier.as_bytes());
                                }
                            },
                        ),
                        mtm,
                    );
                },
            }
        })
        .map_err(|error| error.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use tauri::AppHandle;

    use super::{ColorScheme, DataKind};

    pub(super) fn attach(_: &tauri::Webview, _: String, _: u64, _: Option<ColorScheme>) {}
    pub(super) fn detach(_: &tauri::Webview) {}
    pub(super) fn publish(_: &tauri::Webview) {}
    pub(super) fn history(webview: &tauri::Webview, delta: i32) {
        let _ = webview.eval(if delta < 0 {
            "history.back()"
        } else {
            "history.forward()"
        });
    }
    pub(super) fn reload(webview: &tauri::Webview, _hard: bool) {
        let _ = webview.reload();
    }
    pub(super) fn set_corner_radius(_: &tauri::Webview, _: f64) {}
    pub(super) fn set_color_scheme(_: &tauri::Webview, _: ColorScheme) {}
    pub(super) fn clear_data(
        _: &AppHandle,
        _: Option<[u8; 16]>,
        _: DataKind,
    ) -> Result<(), String> {
        Err("Native browser tabs are only available on macOS".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::{data_store_identifier, is_page_url, parse_page_url};

    #[test]
    fn each_profile_gets_its_own_stable_data_store() {
        let default = data_store_identifier("default");
        assert_eq!(default, data_store_identifier("default"));
        assert_ne!(default, data_store_identifier("work"));
        assert_eq!(default[6] >> 4, 8, "version 8");
        assert_eq!(default[8] >> 6, 0b10, "RFC variant");
    }

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
