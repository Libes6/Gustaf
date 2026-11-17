//! Chromium inside a window whose event loop belongs to Tauri (tao), loaded from a module
//! directory outside the app. Everything here runs on the main thread.
//!
//! Three things make the two coexist:
//! - Chromium asks `NSApp` whether it is inside `sendEvent:` (`CrAppProtocol`). tao's
//!   `NSApplication` subclass does not answer, so the methods are added to it at run time.
//! - CEF never runs its own loop (`external_message_pump`); it asks for work and the main
//!   dispatch queue, which AppKit drains in every common run-loop mode, does it.
//! - The framework is loaded by path with `cef_load_library`, and the helper processes are
//!   started from the same directory (`browser_subprocess_path`), so nothing is in the bundle.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{c_void, CString};
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::OnceLock;

use cef::{args::Args, *};
use objc2::ffi;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::NSApplication;
use objc2_foundation::{NSPoint, NSRect, NSSize};
use serde_json::{json, Value};

use super::cdp::Relay;

pub const FRAMEWORK: &str = "Chromium Embedded Framework.framework";
pub const HELPER: &str = "Gustaf Browser Helper";

pub struct Config {
    /// The directory holding the framework and the helper apps.
    pub module_root: PathBuf,
    /// What Chromium takes for the app bundle. Its sandbox lets child processes read only
    /// below this path, so a module outside the app names its own directory here.
    pub main_bundle_path: Option<PathBuf>,
    pub profile_root: PathBuf,
    pub log_file: PathBuf,
    pub sandbox: bool,
    /// `None` uses the real Keychain; `Some` passes `--use-mock-keychain`.
    pub mock_keychain: bool,
    pub keychain_service: Option<String>,
    pub remote_debugging_port: Option<u16>,
}

#[derive(Debug)]
pub enum HostEvent {
    /// The page's DevTools agent answered: the tab can be driven.
    Attached { tab_id: String },
    Detached { tab_id: String },
    Loaded { tab_id: String },
    /// A relayed CDP message for the client.
    Cdp { tab_id: String, message: String },
}

#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

type Reply = Box<dyn FnOnce(Result<Value, Value>)>;

#[derive(Default)]
struct Tab {
    profile: String,
    browser: Option<Browser>,
    registration: Option<Registration>,
    relay: Option<Relay>,
    /// Calls the host makes for itself; ids below `RELAY_FIRST_ID`.
    own: HashMap<i64, Reply>,
    next_own: i64,
}

const RELAY_FIRST_ID: i64 = 1_000_000;

thread_local! {
    static TABS: RefCell<HashMap<String, Tab>> = RefCell::default();
}

static ON_EVENT: OnceLock<Box<dyn Fn(HostEvent) + Send + Sync>> = OnceLock::new();
static PROFILE_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Browser profile ids of `packages/contracts/src/browserProfile.ts`.
pub const INCOGNITO_PROFILE_ID: &str = "incognito";

thread_local! {
    /// One persistent store per browser profile; incognito tabs each get their own in memory.
    static CONTEXTS: RefCell<HashMap<String, RequestContext>> = RefCell::default();
}

/// A profile's folder under Chromium's root, named so any profile id is a safe file name.
fn profile_dir(profile: &str) -> Option<PathBuf> {
    use std::fmt::Write;
    let mut name = String::new();
    for byte in profile.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' {
            name.push(byte as char);
        } else {
            let _ = write!(name, "%{byte:02X}");
        }
    }
    Some(PROFILE_ROOT.get()?.join("profiles").join(name))
}

fn new_context(cache_path: Option<&std::path::Path>) -> Option<RequestContext> {
    let settings = RequestContextSettings {
        cache_path: cache_path
            .map(|path| CefString::from(path.to_string_lossy().as_ref()))
            .unwrap_or_default(),
        persist_session_cookies: cache_path.is_some().into(),
        ..Default::default()
    };
    request_context_create_context(Some(&settings), None)
}

fn context_for(profile: &str) -> Option<RequestContext> {
    if profile == INCOGNITO_PROFILE_ID {
        return new_context(None);
    }
    if let Some(context) = CONTEXTS.with(|contexts| contexts.borrow().get(profile).cloned()) {
        return Some(context);
    }
    let context = new_context(Some(&profile_dir(profile)?))?;
    CONTEXTS.with(|contexts| contexts.borrow_mut().insert(profile.to_owned(), context.clone()));
    Some(context)
}

/// Deletes a profile's cookies, or every persistent profile's with `None`.
pub fn clear_cookies(profile: Option<&str>) {
    let profiles: Vec<String> = match profile {
        Some(profile) => vec![profile.to_owned()],
        None => {
            let root = PROFILE_ROOT.get().map(|root| root.join("profiles"));
            let mut names: Vec<String> =
                CONTEXTS.with(|contexts| contexts.borrow().keys().cloned().collect());
            // Profiles without an open tab this run still keep cookies on disk.
            if let Some(entries) = root.and_then(|root| std::fs::read_dir(root).ok()) {
                for entry in entries.flatten() {
                    names.push(decode_profile_name(&entry.file_name().to_string_lossy()));
                }
            }
            names.sort();
            names.dedup();
            names
        }
    };
    for profile in profiles {
        if profile == INCOGNITO_PROFILE_ID {
            continue;
        }
        if let Some(manager) = context_for(&profile).and_then(|context| context.cookie_manager(None)) {
            manager.delete_cookies(None, None, None);
            manager.flush_store(None);
        }
    }
}

fn decode_profile_name(name: &str) -> String {
    let bytes = name.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&name[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The open tabs of a profile, so a cache clear can ask a live page to do it.
pub fn tabs_of(profile: Option<&str>) -> Vec<String> {
    TABS.with(|tabs| {
        tabs.borrow()
            .iter()
            .filter(|(_, tab)| profile.is_none_or(|profile| tab.profile == profile))
            .map(|(id, _)| id.clone())
            .collect()
    })
}
static MOCK_KEYCHAIN: AtomicBool = AtomicBool::new(false);

fn emit(event: HostEvent) {
    if let Some(on_event) = ON_EVENT.get() {
        on_event(event);
    }
}

// ---- NSApplication ------------------------------------------------------------------------

static HANDLING_SEND_EVENT: AtomicBool = AtomicBool::new(false);
static ORIGINAL_SEND_EVENT: AtomicUsize = AtomicUsize::new(0);

extern "C-unwind" fn is_handling_send_event(_this: &AnyObject, _sel: Sel) -> Bool {
    Bool::new(HANDLING_SEND_EVENT.load(Ordering::Relaxed))
}

extern "C-unwind" fn set_handling_send_event(_this: &AnyObject, _sel: Sel, handling: Bool) {
    HANDLING_SEND_EVENT.store(handling.as_bool(), Ordering::Relaxed);
}

extern "C-unwind" fn send_event(this: &AnyObject, sel: Sel, event: &AnyObject) {
    let was = HANDLING_SEND_EVENT.swap(true, Ordering::Relaxed);
    // SAFETY: the stored pointer is the `sendEvent:` this function replaced.
    let original: extern "C-unwind" fn(&AnyObject, Sel, &AnyObject) =
        unsafe { std::mem::transmute(ORIGINAL_SEND_EVENT.load(Ordering::Relaxed)) };
    original(this, sel, event);
    HANDLING_SEND_EVENT.store(was, Ordering::Relaxed);
}

/// Teaches the running `NSApplication` (tao's `TaoApp`) Chromium's `CrAppControlProtocol`.
/// Returns the class name, for the log.
fn adopt_chromium_app_protocol(mtm: MainThreadMarker) -> String {
    let app = NSApplication::sharedApplication(mtm);
    let class: &AnyClass = app.class();
    let class_ptr = class as *const AnyClass as *mut AnyClass;
    // SAFETY: signatures match the type encodings (arm64: BOOL is `B`), and the class outlives us.
    unsafe {
        ffi::class_addMethod(
            class_ptr,
            sel!(isHandlingSendEvent),
            std::mem::transmute::<_, Imp>(
                is_handling_send_event as extern "C-unwind" fn(&AnyObject, Sel) -> Bool,
            ),
            c"B@:".as_ptr(),
        );
        ffi::class_addMethod(
            class_ptr,
            sel!(setHandlingSendEvent:),
            std::mem::transmute::<_, Imp>(
                set_handling_send_event as extern "C-unwind" fn(&AnyObject, Sel, Bool),
            ),
            c"v@:B".as_ptr(),
        );
        if ORIGINAL_SEND_EVENT.load(Ordering::Relaxed) == 0 {
            let method = ffi::class_getInstanceMethod(class_ptr, sel!(sendEvent:));
            let replacement = std::mem::transmute::<_, Imp>(
                send_event as extern "C-unwind" fn(&AnyObject, Sel, &AnyObject),
            );
            if let Some(original) = ffi::method_setImplementation(method.cast_mut(), replacement) {
                ORIGINAL_SEND_EVENT.store(original as usize, Ordering::Relaxed);
            }
        }
        // Present only once the framework is loaded; debug builds of Chromium check conformance.
        for name in [c"CrAppProtocol", c"CrAppControlProtocol", c"CefAppProtocol"] {
            let protocol = ffi::objc_getProtocol(name.as_ptr());
            if !protocol.is_null() {
                ffi::class_addProtocol(class_ptr, protocol);
            }
        }
    }
    class.name().to_string_lossy().into_owned()
}

// ---- message pump -------------------------------------------------------------------------

extern "C" {
    static _dispatch_main_q: c_void;
    fn dispatch_async_f(queue: *const c_void, context: *mut c_void, work: extern "C" fn(*mut c_void));
    fn dispatch_after_f(
        when: u64,
        queue: *const c_void,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
    fn dispatch_time(when: u64, delta: i64) -> u64;
}

/// cefclient's ceiling between two `DoMessageLoopWork` calls.
const MAX_PUMP_DELAY_MS: i64 = 1000 / 30;
static PUMP_ACTIVE: AtomicBool = AtomicBool::new(false);
static PUMP_REENTERED: AtomicBool = AtomicBool::new(false);
/// Only the newest delayed request runs; older timers find a different number and return.
static PUMP_TIMER: AtomicU64 = AtomicU64::new(0);
pub static PUMP_TICKS: AtomicU64 = AtomicU64::new(0);
static SHUT_DOWN: AtomicBool = AtomicBool::new(false);

/// May be called on any thread.
fn schedule_pump(delay_ms: i64) {
    let timer = PUMP_TIMER.fetch_add(1, Ordering::SeqCst) + 1;
    // SAFETY: the main queue is a process-lifetime static and the context is a plain number.
    unsafe {
        let queue = &raw const _dispatch_main_q;
        if delay_ms <= 0 {
            dispatch_async_f(queue, std::ptr::null_mut(), pump);
        } else {
            let delay = delay_ms.min(MAX_PUMP_DELAY_MS) * 1_000_000;
            dispatch_after_f(dispatch_time(0, delay), queue, timer as *mut c_void, pump);
        }
    }
}

extern "C" fn pump(context: *mut c_void) {
    let timer = context as u64;
    if SHUT_DOWN.load(Ordering::SeqCst)
        || (timer != 0 && timer != PUMP_TIMER.load(Ordering::SeqCst))
    {
        return;
    }
    if PUMP_ACTIVE.swap(true, Ordering::SeqCst) {
        PUMP_REENTERED.store(true, Ordering::SeqCst);
        return;
    }
    PUMP_REENTERED.store(false, Ordering::SeqCst);
    let before = PUMP_TIMER.load(Ordering::SeqCst);
    PUMP_TICKS.fetch_add(1, Ordering::Relaxed);
    do_message_loop_work();
    PUMP_ACTIVE.store(false, Ordering::SeqCst);
    if PUMP_REENTERED.load(Ordering::SeqCst) {
        schedule_pump(0);
    } else if PUMP_TIMER.load(Ordering::SeqCst) == before {
        // Nothing asked for more work; keep the heartbeat cefclient keeps.
        schedule_pump(MAX_PUMP_DELAY_MS);
    }
}

// ---- CEF handlers -------------------------------------------------------------------------

wrap_app! {
    struct HostApp;

    impl App {
        fn on_before_command_line_processing(
            &self,
            process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            let browser_process = process_type.is_none_or(|kind| kind.to_string().is_empty());
            if let (true, Some(command_line)) = (browser_process, command_line) {
                if MOCK_KEYCHAIN.load(Ordering::Relaxed) {
                    command_line.append_switch(Some(&CefString::from("use-mock-keychain")));
                }
            }
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(HostBrowserProcessHandler::new())
        }
    }
}

wrap_browser_process_handler! {
    struct HostBrowserProcessHandler;

    impl BrowserProcessHandler {
        fn on_schedule_message_pump_work(&self, delay_ms: i64) {
            schedule_pump(delay_ms);
        }
    }
}

wrap_client! {
    struct TabClient {
        tab_id: String,
    }

    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(TabLifeSpanHandler::new(self.tab_id.clone()))
        }

        fn load_handler(&self) -> Option<LoadHandler> {
            Some(TabLoadHandler::new(self.tab_id.clone()))
        }
    }
}

wrap_life_span_handler! {
    struct TabLifeSpanHandler {
        tab_id: String,
    }

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            // Observers cannot be added from inside the notification that reports the browser.
            if let Some(browser) = browser {
                let attach_later = Box::new((self.tab_id.clone(), browser.clone()));
                // SAFETY: the box is reclaimed exactly once, by `attach_from_queue`.
                unsafe {
                    dispatch_async_f(
                        &raw const _dispatch_main_q,
                        Box::into_raw(attach_later).cast(),
                        attach_from_queue,
                    );
                }
            }
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            TABS.with(|tabs| tabs.borrow_mut().remove(&self.tab_id));
            emit(HostEvent::Detached { tab_id: self.tab_id.clone() });
        }
    }
}

wrap_load_handler! {
    struct TabLoadHandler {
        tab_id: String,
    }

    impl LoadHandler {
        fn on_load_end(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            http_status_code: ::std::os::raw::c_int,
        ) {
            let Some(frame) = frame.filter(|frame| frame.is_main() != 0) else {
                return;
            };
            let _ = (http_status_code, frame);
            emit(HostEvent::Loaded { tab_id: self.tab_id.clone() });
        }
    }
}

wrap_dev_tools_message_observer! {
    struct TabObserver {
        tab_id: String,
    }

    impl DevToolsMessageObserver {
        fn on_dev_tools_message(
            &self,
            _browser: Option<&mut Browser>,
            message: Option<&[u8]>,
        ) -> ::std::os::raw::c_int {
            if let Some(message) = message {
                from_page(&self.tab_id, &String::from_utf8_lossy(message));
            }
            1
        }

        fn on_dev_tools_agent_detached(&self, _browser: Option<&mut Browser>) {
            emit(HostEvent::Detached { tab_id: self.tab_id.clone() });
        }
    }
}

// ---- host ---------------------------------------------------------------------------------

/// Loads the framework from the module and starts CEF on the already running AppKit loop.
pub fn start(
    config: &Config,
    on_event: impl Fn(HostEvent) + Send + Sync + 'static,
) -> Result<String, String> {
    let mtm = MainThreadMarker::new().ok_or("CEF starts on the main thread")?;
    let _ = ON_EVENT.set(Box::new(on_event));
    let _ = PROFILE_ROOT.set(config.profile_root.clone());
    MOCK_KEYCHAIN.store(config.mock_keychain, Ordering::Relaxed);

    let framework_dir = config.module_root.join(FRAMEWORK);
    let library = framework_dir.join("Chromium Embedded Framework");
    let library_c =
        CString::new(library.as_os_str().as_bytes()).map_err(|error| error.to_string())?;
    // SAFETY: a NUL-terminated path that lives across the call.
    if load_library(Some(unsafe { &*library_c.as_ptr().cast() })) != 1 {
        return Err(format!("Could not load {}", library.display()));
    }
    let app_class = adopt_chromium_app_protocol(mtm);
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);

    let helper = config
        .module_root
        .join(format!("{HELPER}.app/Contents/MacOS/{HELPER}"));
    let path = |path: &std::path::Path| CefString::from(path.to_string_lossy().as_ref());
    let settings = Settings {
        no_sandbox: (!config.sandbox).into(),
        framework_dir_path: path(&framework_dir),
        browser_subprocess_path: path(&helper),
        main_bundle_path: config.main_bundle_path.as_deref().map(path).unwrap_or_default(),
        external_message_pump: 1,
        root_cache_path: path(&config.profile_root),
        log_file: path(&config.log_file),
        log_severity: LogSeverity::WARNING,
        // The app owns its signal handling and its own argv.
        disable_signal_handlers: 1,
        command_line_args_disabled: 1,
        remote_debugging_port: config.remote_debugging_port.map_or(0, i32::from),
        keychain_service_name: config
            .keychain_service
            .as_deref()
            .map(CefString::from)
            .unwrap_or_default(),
        ..Default::default()
    };
    let args = Args::new();
    let mut app = HostApp::new();
    if initialize(
        Some(args.as_main_args()),
        Some(&settings),
        Some(&mut app),
        std::ptr::null_mut(),
    ) != 1
    {
        return Err(format!("cef_initialize failed with exit code {}", get_exit_code()));
    }
    schedule_pump(0);
    Ok(app_class)
}

/// Places a browser view as a subview of `parent_view` (an `NSView*`), `rect` from its top left.
pub fn open_tab(
    tab_id: &str,
    url: &str,
    profile: &str,
    parent_view: *mut c_void,
    rect: Rect,
) -> Result<(), String> {
    if TABS.with(|tabs| tabs.borrow().contains_key(tab_id)) {
        return Err(format!("Tab {tab_id} is already open"));
    }
    let mut context = context_for(profile).ok_or("Chromium could not open the profile")?;
    TABS.with(|tabs| {
        tabs.borrow_mut().insert(
            tab_id.to_owned(),
            Tab { profile: profile.to_owned(), ..Tab::default() },
        )
    });
    let frame = frame_in(parent_view, rect);
    let window_info = WindowInfo {
        runtime_style: RuntimeStyle::ALLOY,
        ..Default::default()
    }
    .set_as_child(
        parent_view,
        &cef::Rect {
            x: frame.origin.x as i32,
            y: frame.origin.y as i32,
            width: frame.size.width as i32,
            height: frame.size.height as i32,
        },
    );
    let mut client = TabClient::new(tab_id.to_owned());
    let created = browser_host_create_browser(
        Some(&window_info),
        Some(&mut client),
        Some(&CefString::from(url)),
        Some(&BrowserSettings::default()),
        None,
        Some(&mut context),
    );
    if created != 1 {
        TABS.with(|tabs| tabs.borrow_mut().remove(tab_id));
        return Err("CEF refused to create the browser".to_owned());
    }
    Ok(())
}

fn frame_in(parent_view: *mut c_void, rect: Rect) -> NSRect {
    let parent = parent_view.cast::<AnyObject>();
    // SAFETY: the caller passes a live NSView on the main thread.
    let (bounds, flipped): (NSRect, bool) =
        unsafe { (msg_send![parent, bounds], msg_send![parent, isFlipped]) };
    let y = if flipped {
        rect.y
    } else {
        bounds.size.height - rect.y - rect.height
    };
    NSRect::new(NSPoint::new(rect.x, y), NSSize::new(rect.width, rect.height))
}

fn browser_of(tab_id: &str) -> Option<Browser> {
    TABS.with(|tabs| tabs.borrow().get(tab_id).and_then(|tab| tab.browser.clone()))
}

fn view_of(tab_id: &str) -> Option<*mut AnyObject> {
    let view = browser_of(tab_id)?.host()?.window_handle();
    (!view.is_null()).then_some(view.cast())
}

/// `None` hides the view, as the page does while one of its own menus must cover the tab.
pub fn present(tab_id: &str, rect: Option<Rect>, corner_radius: f64) {
    let Some(view) = view_of(tab_id) else {
        return;
    };
    // SAFETY: CEF's browser view, alive while its browser is, on the main thread.
    unsafe {
        match rect {
            Some(rect) => {
                let parent: *mut AnyObject = msg_send![view, superview];
                let frame = frame_in(parent.cast(), rect);
                let _: () = msg_send![view, setFrame: frame];
                let _: () = msg_send![view, setWantsLayer: true];
                let layer: *mut AnyObject = msg_send![view, layer];
                if !layer.is_null() {
                    let _: () = msg_send![layer, setCornerRadius: corner_radius];
                    let _: () = msg_send![layer, setMasksToBounds: corner_radius > 0.0];
                }
                let _: () = msg_send![view, setHidden: false];
            }
            None => {
                let _: () = msg_send![view, setHidden: true];
            }
        }
    }
    if let Some(host) = browser_of(tab_id).and_then(|browser| browser.host()) {
        host.was_hidden(rect.is_none().into());
        host.was_resized();
    }
}

extern "C" fn attach_from_queue(context: *mut c_void) {
    // SAFETY: the pointer `on_after_created` leaked for this call.
    let (tab_id, browser) = *unsafe { Box::from_raw(context.cast::<(String, Browser)>()) };
    attach(&tab_id, browser);
}

fn attach(tab_id: &str, browser: Browser) {
    let Some(host) = browser.host() else {
        return;
    };
    let mut observer = TabObserver::new(tab_id.to_owned());
    let registration = host.add_dev_tools_message_observer(Some(&mut observer));
    TABS.with(|tabs| {
        if let Some(tab) = tabs.borrow_mut().get_mut(tab_id) {
            tab.browser = Some(browser);
            tab.registration = registration;
        }
    });
    // The client is told about the tab only once the page can name itself.
    let tab = tab_id.to_owned();
    call(tab_id, "Target.getTargetInfo", json!({}), move |target| {
        let target = target
            .ok()
            .and_then(|result| result.get("targetInfo").cloned())
            .unwrap_or_else(|| json!({ "targetId": tab, "type": "page", "title": "", "url": "" }));
        let again = tab.clone();
        call(&tab, "Browser.getVersion", json!({}), move |version| {
            let user_agent = version
                .ok()
                .and_then(|version| version["userAgent"].as_str().map(str::to_owned))
                .unwrap_or_default();
            TABS.with(|tabs| {
                if let Some(tab) = tabs.borrow_mut().get_mut(&again) {
                    tab.relay = Some(Relay::new(target.clone(), user_agent, RELAY_FIRST_ID));
                }
            });
            emit(HostEvent::Attached { tab_id: again });
        });
    });
}

fn to_page(tab_id: &str, message: &str) {
    if let Some(host) = browser_of(tab_id).and_then(|browser| browser.host()) {
        host.send_dev_tools_message(Some(message.as_bytes()));
    }
}

/// A CDP call of the host's own, answered through the observer like any other.
pub fn call(
    tab_id: &str,
    method: &str,
    params: Value,
    reply: impl FnOnce(Result<Value, Value>) + 'static,
) {
    let id = TABS.with(|tabs| {
        let mut tabs = tabs.borrow_mut();
        let tab = tabs.get_mut(tab_id)?;
        tab.next_own += 1;
        tab.own.insert(tab.next_own, Box::new(reply));
        Some(tab.next_own)
    });
    if let Some(id) = id {
        to_page(tab_id, &json!({ "id": id, "method": method, "params": params }).to_string());
    }
}

fn from_page(tab_id: &str, raw: &str) {
    let own_id = raw
        .contains("\"id\"")
        .then(|| serde_json::from_str::<Value>(raw).ok())
        .flatten()
        .filter(|message| message["id"].as_i64().is_some_and(|id| id < RELAY_FIRST_ID));
    if let Some(mut message) = own_id {
        let id = message["id"].as_i64().unwrap_or_default();
        // Taken out first: the reply may make calls of its own.
        let reply = TABS.with(|tabs| tabs.borrow_mut().get_mut(tab_id)?.own.remove(&id));
        if let Some(reply) = reply {
            reply(match message.get_mut("result") {
                Some(result) => Ok(result.take()),
                None => Err(message["error"].take()),
            });
        }
        return;
    }
    let relayed = TABS.with(|tabs| {
        tabs.borrow_mut()
            .get_mut(tab_id)
            .and_then(|tab| tab.relay.as_mut())
            .map(|relay| relay.from_page(raw))
            .unwrap_or_default()
    });
    for message in relayed {
        emit(HostEvent::Cdp { tab_id: tab_id.to_owned(), message });
    }
}

/// A `cdp` command from the client.
pub fn from_client(tab_id: &str, raw: &str) {
    let output = TABS.with(|tabs| {
        tabs.borrow_mut()
            .get_mut(tab_id)
            .and_then(|tab| tab.relay.as_mut())
            .map(|relay| relay.from_client(raw))
    });
    let Some(output) = output else {
        return;
    };
    for message in output.to_client {
        emit(HostEvent::Cdp { tab_id: tab_id.to_owned(), message });
    }
    for message in output.to_page {
        to_page(tab_id, &message);
    }
}

/// The page's address and history, as the window's toolbar shows them.
pub fn page_state(tab_id: &str) -> Option<(String, bool, bool, bool)> {
    let browser = browser_of(tab_id)?;
    let url = browser
        .main_frame()
        .map(|frame| CefString::from(&frame.url()).to_string())
        .unwrap_or_default();
    Some((
        url,
        browser.is_loading() != 0,
        browser.can_go_back() != 0,
        browser.can_go_forward() != 0,
    ))
}

pub fn is_open(tab_id: &str) -> bool {
    TABS.with(|tabs| tabs.borrow().contains_key(tab_id))
}

pub fn close_tab(tab_id: &str) {
    match browser_of(tab_id).and_then(|browser| browser.host()) {
        Some(host) => host.close_browser(1),
        // Not created yet: forget it so the creation callback finds nothing to attach.
        None => {
            TABS.with(|tabs| tabs.borrow_mut().remove(tab_id));
        }
    }
}

pub fn navigate(tab_id: &str, url: &str) {
    if let Some(frame) = browser_of(tab_id).and_then(|browser| browser.main_frame()) {
        frame.load_url(Some(&CefString::from(url)));
    }
}

pub fn history(tab_id: &str, delta: i32) {
    if let Some(browser) = browser_of(tab_id) {
        if delta < 0 {
            browser.go_back();
        } else if delta > 0 {
            browser.go_forward();
        }
    }
}

pub fn reload(tab_id: &str, hard: bool) {
    if let Some(browser) = browser_of(tab_id) {
        if hard {
            browser.reload_ignore_cache();
        } else {
            browser.reload();
        }
    }
}

pub fn set_zoom(tab_id: &str, zoom_factor: f64) {
    if let Some(host) = browser_of(tab_id).and_then(|browser| browser.host()) {
        // CEF's zoom level is logarithmic: each step of 1.0 is a factor of 1.2.
        host.set_zoom_level(zoom_factor.ln() / 1.2f64.ln());
    }
}

pub fn open_devtools(tab_id: &str) {
    if let Some(host) = browser_of(tab_id).and_then(|browser| browser.host()) {
        host.show_dev_tools(None, None, None, None);
    }
}

/// Closes every browser and shuts CEF down. The pump must not run afterwards.
pub fn stop() {
    let browsers: Vec<Browser> =
        TABS.with(|tabs| tabs.borrow().values().filter_map(|tab| tab.browser.clone()).collect());
    for browser in browsers {
        if let Some(host) = browser.host() {
            host.close_browser(1);
        }
    }
    for _ in 0..200 {
        if TABS.with(|tabs| tabs.borrow().is_empty()) {
            break;
        }
        do_message_loop_work();
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    SHUT_DOWN.store(true, Ordering::SeqCst);
    shutdown();
}
