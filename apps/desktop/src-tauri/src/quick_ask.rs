//! "Quick ask" window: a small, borderless, always-on-top, Spotlight-like window (label `quick-ask`) that a global
//! shortcut toggles. The window is created lazily (nothing exists until the first use) and only hidden afterwards.
//!
//! The page (`quick-ask.html`, own Vite entry) does the actual chat turn with the default model; this module owns
//! what only Rust can do: the global shortcut, creating / placing / resizing / hiding the window and bringing the main
//! window forward for "Open in Gustaf". The feature is off until the frontend calls `quick_ask_configure(true, ...)`
//! (Settings -> Shortcuts); a shortcut that cannot be registered (taken by another app, invalid) is an `Err` string
//! the settings page shows as a notice, never a crash. Errors are `<code>: <message>`:
//! `invalid_shortcut`, `needs_modifier`, `shortcut_unavailable`, `window_error`.
//!
//! Pure parts (default accelerator per OS, height clamp, placement on a monitor, accelerator validation) are unit-tested
//! below. Focus, always-on-top, multi-monitor placement and registration on each OS need a real desktop session.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const LABEL: &str = "quick-ask";
const PAGE: &str = "quick-ask.html";
/// Event the page listens to: the window was (re)shown, start a fresh question.
const SHOWN_EVENT: &str = "quick-ask:shown";
pub const WIDTH: f64 = 640.0;
pub const MIN_HEIGHT: f64 = 160.0;
pub const MAX_HEIGHT: f64 = 520.0;

#[derive(Default)]
pub struct QuickAsk {
    shortcut: Mutex<Option<Shortcut>>,
    hide_on_blur: AtomicBool,
    /// The window was just created: show it once its page reports `quick_ask_ready` (no white flash).
    pending_show: AtomicBool,
    /// Blur hides only a window that had focus before, so the focus event that races with `show` cannot hide it.
    was_focused: AtomicBool,
}

fn err(code: &str, message: impl std::fmt::Display) -> String {
    format!("{code}: {message}")
}

// ---- pure parts ----------------------------------------------------------------------------------------------------

/// Default accelerator (off until the user turns the feature on). `Cmd+Alt+Space` is Finder search and `Ctrl(+Alt)+Space`
/// switches the input source on macOS, so macOS gets a three-modifier combination; elsewhere `Ctrl+Alt+Space` is free
/// (Windows' `Alt+Space` is the window menu and PowerToys Run's key).
pub fn default_accelerator_for(os: &str) -> &'static str {
    match os {
        "macos" => "Command+Shift+Alt+Space",
        _ => "Control+Alt+Space",
    }
}

pub fn default_accelerator() -> &'static str {
    default_accelerator_for(std::env::consts::OS)
}

/// Window height (logical px) for a requested content height: at least the input row, at most the full answer view.
pub fn clamp_height(requested: f64) -> f64 {
    if requested.is_nan() {
        return MIN_HEIGHT;
    }
    requested.clamp(MIN_HEIGHT, MAX_HEIGHT)
}

/// Top-left corner (physical px) of a window of `win_w` x `max_h` physical px centered on a monitor. The window keeps
/// this top edge while it grows, so at its largest size it is exactly centered and while small it sits a bit higher.
pub fn centered_origin(
    mon_x: i32,
    mon_y: i32,
    mon_w: u32,
    mon_h: u32,
    win_w: u32,
    max_h: u32,
) -> (i32, i32) {
    let x = mon_x + (i64::from(mon_w) - i64::from(win_w)).max(0) as i32 / 2;
    let y = mon_y + (i64::from(mon_h) - i64::from(max_h)).max(0) as i32 / 2;
    (x, y)
}

/// Parses and validates an accelerator: a known key plus at least one modifier (a bare key would steal typing everywhere).
pub fn parse_accelerator(text: &str) -> Result<Shortcut, String> {
    let shortcut: Shortcut = text
        .trim()
        .parse()
        .map_err(|e| err("invalid_shortcut", e))?;
    if shortcut.mods.is_empty() {
        return Err(err(
            "needs_modifier",
            "a global shortcut needs at least one modifier key",
        ));
    }
    Ok(shortcut)
}

// ---- window --------------------------------------------------------------------------------------------------------

fn target_monitor(app: &AppHandle) -> Option<tauri::window::Monitor> {
    // The monitor under the mouse pointer is the "active screen"; the primary one when that cannot be determined.
    app.cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
}

fn place(app: &AppHandle, win: &WebviewWindow) {
    match target_monitor(app) {
        Some(m) => {
            let s = m.scale_factor();
            let (x, y) = centered_origin(
                m.position().x,
                m.position().y,
                m.size().width,
                m.size().height,
                (WIDTH * s) as u32,
                (MAX_HEIGHT * s) as u32,
            );
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
        None => {
            let _ = win.center();
        }
    }
}

fn create(app: &AppHandle) -> Result<WebviewWindow, String> {
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(PAGE.into()))
        .title("Gustaf Quick Ask")
        .inner_size(WIDTH, MIN_HEIGHT)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .build()
        .map_err(|e| err("window_error", e))?;
    let handle = app.clone();
    win.on_window_event(move |event| {
        let state = handle.state::<QuickAsk>();
        match event {
            WindowEvent::Focused(true) => state.was_focused.store(true, Ordering::SeqCst),
            WindowEvent::Focused(false) => {
                if state.was_focused.swap(false, Ordering::SeqCst)
                    && state.hide_on_blur.load(Ordering::SeqCst)
                {
                    if let Some(w) = handle.get_webview_window(LABEL) {
                        let _ = w.hide();
                    }
                }
            }
            _ => {}
        }
    });
    Ok(win)
}

fn reveal(app: &AppHandle, win: &WebviewWindow) {
    place(app, win);
    let _ = win.show();
    let _ = win.set_focus();
    let _ = win.emit(SHOWN_EVENT, ());
}

pub fn show(app: &AppHandle) -> Result<(), String> {
    match app.get_webview_window(LABEL) {
        Some(win) => reveal(app, &win),
        None => {
            app.state::<QuickAsk>()
                .pending_show
                .store(true, Ordering::SeqCst);
            if let Err(e) = create(app) {
                app.state::<QuickAsk>()
                    .pending_show
                    .store(false, Ordering::SeqCst);
                return Err(e);
            }
        }
    }
    Ok(())
}

pub fn hide(app: &AppHandle) {
    app.state::<QuickAsk>()
        .pending_show
        .store(false, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
    }
}

pub fn toggle(app: &AppHandle) -> Result<(), String> {
    match app.get_webview_window(LABEL) {
        Some(win) if win.is_visible().unwrap_or(false) => {
            hide(app);
            Ok(())
        }
        _ => show(app),
    }
}

/// Closing the main window ends the app: the quick-ask window must not keep it alive on its own.
pub fn on_main_destroyed(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.destroy();
    }
}

// ---- commands ------------------------------------------------------------------------------------------------------

/// Turns the feature on or off and (re)registers the global shortcut. Idempotent; the previous registration of this
/// feature is always released first. On `Err` nothing stays registered and the feature is effectively off.
#[tauri::command]
pub async fn quick_ask_configure(
    app: AppHandle,
    enabled: bool,
    accelerator: Option<String>,
    hide_on_blur: bool,
) -> Result<(), String> {
    let state = app.state::<QuickAsk>();
    state.hide_on_blur.store(hide_on_blur, Ordering::SeqCst);
    let gs = app.global_shortcut();
    if let Some(old) = state
        .shortcut
        .lock()
        .map_err(|e| err("window_error", e))?
        .take()
    {
        let _ = gs.unregister(old);
    }
    if !enabled {
        hide(&app);
        return Ok(());
    }
    let shortcut = parse_accelerator(
        accelerator
            .as_deref()
            .unwrap_or_else(|| default_accelerator()),
    )?;
    gs.on_shortcut(shortcut, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let app = app.clone();
            // Creating a window must not run on the shortcut's own thread.
            tauri::async_runtime::spawn(async move {
                let _ = toggle(&app);
            });
        }
    })
    .map_err(|e| err("shortcut_unavailable", e))?;
    *state.shortcut.lock().map_err(|e| err("window_error", e))? = Some(shortcut);
    Ok(())
}

#[tauri::command]
pub async fn quick_ask_show(app: AppHandle) -> Result<(), String> {
    show(&app)
}

#[tauri::command]
pub async fn quick_ask_hide(app: AppHandle) -> Result<(), String> {
    hide(&app);
    Ok(())
}

#[tauri::command]
pub async fn quick_ask_toggle(app: AppHandle) -> Result<(), String> {
    toggle(&app)
}

/// The page finished loading: reveal a window that was created for a pending show.
#[tauri::command]
pub async fn quick_ask_ready(app: AppHandle) -> Result<(), String> {
    if app
        .state::<QuickAsk>()
        .pending_show
        .swap(false, Ordering::SeqCst)
    {
        if let Some(win) = app.get_webview_window(LABEL) {
            reveal(&app, &win);
        }
    }
    Ok(())
}

/// Grows or shrinks the window to the content (logical px, clamped to 160..520).
#[tauri::command]
pub async fn quick_ask_resize(app: AppHandle, height: f64) -> Result<(), String> {
    let win = app
        .get_webview_window(LABEL)
        .ok_or_else(|| err("window_error", "the quick ask window does not exist"))?;
    win.set_size(LogicalSize::new(WIDTH, clamp_height(height)))
        .map_err(|e| err("window_error", e))
}

/// "Open in Gustaf": hide the quick-ask window and bring the main window to the front.
#[tauri::command]
pub async fn quick_ask_open_main(app: AppHandle) -> Result<(), String> {
    hide(&app);
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| err("window_error", "the main window is not open"))?;
    let _ = main.show();
    let _ = main.unminimize();
    main.set_focus().map_err(|e| err("window_error", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_accelerator_per_os() {
        assert_eq!(default_accelerator_for("macos"), "Command+Shift+Alt+Space");
        assert_eq!(default_accelerator_for("windows"), "Control+Alt+Space");
        assert_eq!(default_accelerator_for("linux"), "Control+Alt+Space");
        assert_eq!(default_accelerator_for("freebsd"), "Control+Alt+Space");
    }

    #[test]
    fn defaults_are_valid_accelerators() {
        for os in ["macos", "windows", "linux"] {
            assert!(
                parse_accelerator(default_accelerator_for(os)).is_ok(),
                "{os}"
            );
        }
        assert!(parse_accelerator(default_accelerator()).is_ok());
    }

    #[test]
    fn accelerators_need_a_modifier_and_a_known_key() {
        assert!(parse_accelerator("Control+Alt+Space").is_ok());
        assert!(parse_accelerator("  CommandOrControl+Shift+K ").is_ok());
        assert!(parse_accelerator("Alt+F9").is_ok());
        assert!(parse_accelerator("Space")
            .unwrap_err()
            .starts_with("needs_modifier:"));
        assert!(parse_accelerator("Control+Alt")
            .unwrap_err()
            .starts_with("invalid_shortcut:"));
        assert!(parse_accelerator("")
            .unwrap_err()
            .starts_with("invalid_shortcut:"));
        assert!(parse_accelerator("Ctrl+Alt+Nonsense")
            .unwrap_err()
            .starts_with("invalid_shortcut:"));
        assert!(parse_accelerator("Ctrl+A+B")
            .unwrap_err()
            .starts_with("invalid_shortcut:"));
    }

    #[test]
    fn height_is_clamped_to_the_window_range() {
        assert_eq!(clamp_height(0.0), MIN_HEIGHT);
        assert_eq!(clamp_height(-40.0), MIN_HEIGHT);
        assert_eq!(clamp_height(f64::NAN), MIN_HEIGHT);
        assert_eq!(clamp_height(f64::NEG_INFINITY), MIN_HEIGHT);
        assert_eq!(clamp_height(300.0), 300.0);
        assert_eq!(clamp_height(9_999.0), MAX_HEIGHT);
        assert_eq!(clamp_height(f64::INFINITY), MAX_HEIGHT);
    }

    #[test]
    fn window_is_centered_on_the_monitor_with_the_pointer() {
        // 1920x1080 at the origin: 640 wide, 520 tall at full size
        assert_eq!(centered_origin(0, 0, 1920, 1080, 640, 520), (640, 280));
        // a second monitor to the right and above (negative y)
        assert_eq!(
            centered_origin(1920, -1080, 2560, 1440, 640, 520),
            (1920 + 960, -1080 + 460)
        );
        // retina: physical sizes
        assert_eq!(centered_origin(0, 0, 3024, 1964, 1280, 1040), (872, 462));
    }

    #[test]
    fn a_monitor_smaller_than_the_window_pins_it_to_the_top_left() {
        assert_eq!(centered_origin(100, 50, 500, 300, 640, 520), (100, 50));
    }
}
