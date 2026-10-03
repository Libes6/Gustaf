use base64::{engine::general_purpose::STANDARD, Engine};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::{Deserialize, Serialize};
use std::{
    io::{Cursor, Read},
    process::{Command, Stdio},
    thread::sleep,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use xcap::{image, image::RgbaImage, Monitor, Window};

/// Screenshots are downscaled so the long side fits this; model coordinates are mapped back.
const MAX_SIDE: u32 = 1440;

#[derive(Deserialize, Debug, PartialEq)]
pub struct Point {
    x: i32,
    y: i32,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    Click { x: i32, y: i32, #[serde(default)] button: Option<String> },
    DoubleClick { x: i32, y: i32 },
    Drag { path: Vec<Point> },
    Move { x: i32, y: i32 },
    MouseDown,
    MouseUp,
    Scroll { x: i32, y: i32, #[serde(default)] scroll_x: i32, #[serde(default)] scroll_y: i32 },
    Keypress { keys: Vec<String> },
    Type { text: String },
    Wait { #[serde(default)] ms: Option<u64> },
    /// Launches or activates an application by name (`open -a <name>`).
    OpenApp { name: String },
    Screenshot,
}

/// The screenshot after a batch plus facts about the desktop, so the model gets more than "OK".
#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    /// PNG, base64 without the data: prefix.
    png: String,
    width: u32,
    height: u32,
    /// Owner of the active application's frontmost window, when it could be read.
    front_app: Option<String>,
    /// Title of that window, when it has one.
    window_title: Option<String>,
    /// Mouse position in screenshot coordinates.
    cursor: Option<(i32, i32)>,
    /// Whether the screen differs from before the batch (None for screenshot-only batches).
    changed: Option<bool>,
    /// False when the screen was still changing when the settle wait gave up.
    settled: Option<bool>,
    /// Zero-based index of the action that failed; later actions were not executed.
    failed_step: Option<usize>,
    error: Option<String>,
}

/// Maps a point from the (possibly downscaled) screenshot space to display points.
pub fn map_coords(x: i32, y: i32, shot: (u32, u32), display: (u32, u32)) -> (i32, i32) {
    let sx = display.0 as f64 / shot.0 as f64;
    let sy = display.1 as f64 / shot.1 as f64;
    ((x as f64 * sx).round() as i32, (y as f64 * sy).round() as i32)
}

/// Maps display points back to screenshot pixels (inverse of `map_coords`).
pub fn unmap_coords(x: i32, y: i32, shot: (u32, u32), display: (u32, u32)) -> (i32, i32) {
    map_coords(x, y, display, shot)
}

pub fn fit(w: u32, h: u32) -> (u32, u32) {
    let long = w.max(h);
    if long <= MAX_SIDE {
        return (w, h);
    }
    let k = MAX_SIDE as f64 / long as f64;
    ((w as f64 * k).round() as u32, (h as f64 * k).round() as u32)
}

fn primary() -> Result<Monitor, String> {
    Monitor::all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .ok_or_else(|| "no primary display".into())
}

fn display_size(m: &Monitor) -> Result<(u32, u32), String> {
    Ok((m.width().map_err(|e| e.to_string())?, m.height().map_err(|e| e.to_string())?))
}

fn grab(m: &Monitor) -> Result<RgbaImage, String> {
    m.capture_image().map_err(|e| format!("screen capture failed (Screen Recording permission?): {e}"))
}

fn encode(raw: &RgbaImage, (w, h): (u32, u32)) -> Result<Shot, String> {
    let img = image::imageops::resize(raw, w, h, image::imageops::FilterType::Triangle);
    let mut png = Vec::new();
    img.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(Shot { png: STANDARD.encode(png), width: w, height: h, ..Default::default() })
}

/// Size of the grid a screen is reduced to for change detection.
const THUMB_W: usize = 64;
const THUMB_H: usize = 40;
/// A grid cell whose average brightness moves by more than this (0-255) counts as a change.
const CELL_DELTA: u8 = 10;

/// Average brightness of each cell of a THUMB_W x THUMB_H grid over an RGBA buffer, sampling every 4th pixel each way.
/// Cheap enough to run several times per second on a Retina capture.
pub fn thumb(width: usize, height: usize, rgba: &[u8]) -> Vec<u8> {
    if width == 0 || height == 0 || rgba.len() < width * height * 4 {
        return vec![0; THUMB_W * THUMB_H];
    }
    let mut sum = vec![0u32; THUMB_W * THUMB_H];
    let mut count = vec![0u32; THUMB_W * THUMB_H];
    for y in (0..height).step_by(4) {
        let cy = y * THUMB_H / height;
        for x in (0..width).step_by(4) {
            let cx = x * THUMB_W / width;
            let i = (y * width + x) * 4;
            let luma = (rgba[i] as u32 * 3 + rgba[i + 1] as u32 * 6 + rgba[i + 2] as u32) / 10;
            sum[cy * THUMB_W + cx] += luma;
            count[cy * THUMB_W + cx] += 1;
        }
    }
    sum.iter().zip(&count).map(|(s, c)| if *c == 0 { 0 } else { (s / c) as u8 }).collect()
}

fn thumb_of(img: &RgbaImage) -> Vec<u8> {
    thumb(img.width() as usize, img.height() as usize, img.as_raw())
}

/// True when two thumbnails differ visibly in at least one cell.
pub fn differs(a: &[u8], b: &[u8]) -> bool {
    a.len() != b.len() || a.iter().zip(b).any(|(x, y)| x.abs_diff(*y) > CELL_DELTA)
}

pub struct Settle {
    pub poll_ms: u64,
    /// The screen must look the same for this long.
    pub stable_ms: u64,
    /// Give up waiting after this long and use the latest capture.
    pub max_ms: u64,
}

/// Captures until the screen stops changing (same thumbnail for `stable_ms`) or `max_ms` passes. `sample` returns a
/// thumbnail and the capture it came from; the clock and the wait are injected for tests. Returns the latest capture,
/// its thumbnail and whether the screen settled.
pub fn settle<T>(
    cfg: &Settle,
    mut sample: impl FnMut() -> Result<(Vec<u8>, T), String>,
    mut now_ms: impl FnMut() -> u64,
    mut wait: impl FnMut(u64),
) -> Result<(T, Vec<u8>, bool), String> {
    let start = now_ms();
    let (mut last_thumb, mut last) = sample()?;
    let mut stable_since = now_ms();
    loop {
        let t = now_ms();
        if t.saturating_sub(stable_since) >= cfg.stable_ms {
            return Ok((last, last_thumb, true));
        }
        if t.saturating_sub(start) >= cfg.max_ms {
            return Ok((last, last_thumb, false));
        }
        wait(cfg.poll_ms);
        let (th, img) = sample()?;
        if differs(&th, &last_thumb) {
            stable_since = now_ms();
        }
        last_thumb = th;
        last = img;
    }
}

/// An application name for `open -a`: a plain name such as "Telegram" or "System Settings", never a path or an option.
pub fn valid_app_name(name: &str) -> Result<&str, String> {
    let n = name.trim();
    let bad = n.is_empty()
        || n.chars().count() > 80
        || n.starts_with(['-', '.', '~'])
        || n.contains(['/', '\\', ':'])
        || n.chars().any(char::is_control);
    if bad {
        return Err(format!("invalid application name {name:?}: use the app's name, not a path or option"));
    }
    Ok(n)
}

/// The launcher process: `open -a <name>` on macOS, `gtk-launch <name>` (desktop entry id) on Linux; Windows has no
/// equivalent that is safe to call with an arbitrary name (no shell is involved anywhere), so it reports unsupported.
fn launcher(name: &str) -> Result<Command, String> {
    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("/usr/bin/open");
        c.arg("-a").arg(name);
        Ok(c)
    }
    #[cfg(target_os = "linux")]
    {
        let mut c = Command::new("gtk-launch");
        c.arg(name);
        Ok(c)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = name;
        Err("open_app is not supported on this OS yet: switch to the app with clicks or keyboard shortcuts".into())
    }
}

/// Runs the launcher (argument array, no shell), bounded to 10 s.
fn open_app(name: &str) -> Result<(), String> {
    let name = valid_app_name(name)?;
    let mut command = launcher(name)?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run open: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) if status.success() => return Ok(()),
            Some(_) => {
                let mut err = String::new();
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_string(&mut err);
                }
                let err = err.trim();
                return Err(if err.is_empty() { format!("could not open application {name:?}") } else { format!("could not open application {name:?}: {err}") });
            }
            None if Instant::now() > deadline => {
                let _ = child.kill();
                return Err(format!("opening application {name:?} timed out"));
            }
            None => sleep(Duration::from_millis(50)),
        }
    }
}

/// The active application and the title of its frontmost window, from the on-screen window list (front to back).
/// Bounded to the first 60 windows; titles need Screen Recording permission, like the screenshot itself.
fn front_window() -> (Option<String>, Option<String>) {
    let Ok(windows) = Window::all() else { return (None, None) };
    let mut app = None;
    for w in windows.iter().take(60) {
        if !w.is_focused().unwrap_or(false) {
            continue;
        }
        if app.is_none() {
            app = w.app_name().ok().filter(|s| !s.trim().is_empty());
        }
        if let Ok(t) = w.title() {
            if !t.trim().is_empty() {
                return (app, Some(t.chars().take(200).collect()));
            }
        }
    }
    (app, None)
}

fn key_of(name: &str) -> Key {
    match name.to_lowercase().as_str() {
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "esc" | "escape" => Key::Escape,
        "up" | "arrowup" => Key::UpArrow,
        "down" | "arrowdown" => Key::DownArrow,
        "left" | "arrowleft" => Key::LeftArrow,
        "right" | "arrowright" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        // "cmd" is the model's name for the main shortcut modifier: Command on macOS, Ctrl elsewhere.
        "cmd" | "command" => if cfg!(target_os = "macos") { Key::Meta } else { Key::Control },
        "meta" | "super" | "win" => Key::Meta,
        "ctrl" | "control" => Key::Control,
        "alt" | "option" => Key::Alt,
        "shift" => Key::Shift,
        "f1" => Key::F1, "f2" => Key::F2, "f3" => Key::F3, "f4" => Key::F4,
        "f5" => Key::F5, "f6" => Key::F6, "f7" => Key::F7, "f8" => Key::F8,
        "f9" => Key::F9, "f10" => Key::F10, "f11" => Key::F11, "f12" => Key::F12,
        other => Key::Unicode(other.chars().next().unwrap_or(' ')),
    }
}

/// enigo scrolls in lines; models send pixels. ~40px per line, at least one line.
fn scroll_lines(px: i32) -> i32 {
    (px / 40).clamp(-50, 50).abs().max(1) * px.signum()
}

/// Input is created on first use, so a batch with only `open_app`/`wait` does not need Accessibility permission.
fn input(en: &mut Option<Enigo>) -> Result<&mut Enigo, String> {
    if en.is_none() {
        *en = Some(Enigo::new(&Settings::default()).map_err(|e| format!("input unavailable (Accessibility permission?): {e}"))?);
    }
    Ok(en.as_mut().expect("just set"))
}

/// Performs the actions in order and stops at the first failure, returning its index and error.
fn perform(actions: &[Action], shot: (u32, u32), display: (u32, u32), en: &mut Option<Enigo>) -> Result<(), (usize, String)> {
    for (i, a) in actions.iter().enumerate() {
        perform_one(a, shot, display, en).map_err(|e| (i, e))?;
        sleep(Duration::from_millis(80));
    }
    Ok(())
}

fn perform_one(a: &Action, shot: (u32, u32), display: (u32, u32), en: &mut Option<Enigo>) -> Result<(), String> {
    match a {
        Action::Screenshot => return Ok(()),
        Action::Wait { ms } => {
            sleep(Duration::from_millis(ms.unwrap_or(1000).min(5000)));
            return Ok(());
        }
        Action::OpenApp { name } => return open_app(name),
        _ => {}
    }
    let en = input(en)?;
    let e = |r: enigo::InputResult<()>| r.map_err(|e| e.to_string());
    let to = |en: &mut Enigo, x: i32, y: i32| {
        let (x, y) = map_coords(x, y, shot, display);
        en.move_mouse(x, y, Coordinate::Abs)
    };
    match a {
        Action::Click { x, y, button } => {
            e(to(en, *x, *y))?;
            let b = match button.as_deref() {
                Some("right") => Button::Right,
                Some("middle" | "wheel") => Button::Middle,
                _ => Button::Left,
            };
            e(en.button(b, Direction::Click))?;
        }
        Action::DoubleClick { x, y } => {
            e(to(en, *x, *y))?;
            e(en.button(Button::Left, Direction::Click))?;
            e(en.button(Button::Left, Direction::Click))?;
        }
        Action::Drag { path } => {
            let (first, rest) = path.split_first().ok_or("empty drag path")?;
            e(to(en, first.x, first.y))?;
            e(en.button(Button::Left, Direction::Press))?;
            for p in rest {
                sleep(Duration::from_millis(30));
                e(to(en, p.x, p.y))?;
            }
            e(en.button(Button::Left, Direction::Release))?;
        }
        Action::Move { x, y } => e(to(en, *x, *y))?,
        Action::MouseDown => e(en.button(Button::Left, Direction::Press))?,
        Action::MouseUp => e(en.button(Button::Left, Direction::Release))?,
        Action::Scroll { x, y, scroll_x, scroll_y } => {
            e(to(en, *x, *y))?;
            if *scroll_y != 0 {
                e(en.scroll(scroll_lines(*scroll_y), Axis::Vertical))?;
            }
            if *scroll_x != 0 {
                e(en.scroll(scroll_lines(*scroll_x), Axis::Horizontal))?;
            }
        }
        Action::Keypress { keys } => {
            let keys: Vec<Key> = keys.iter().map(|k| key_of(k)).collect();
            let (last, mods) = keys.split_last().ok_or("empty keypress")?;
            for m in mods {
                e(en.key(*m, Direction::Press))?;
            }
            e(en.key(*last, Direction::Click))?;
            for m in mods.iter().rev() {
                e(en.key(*m, Direction::Release))?;
            }
        }
        Action::Type { text } => e(en.text(text))?,
        Action::Wait { .. } | Action::OpenApp { .. } | Action::Screenshot => {}
    }
    Ok(())
}

/// Executes actions on the real desktop and returns a fresh screenshot with facts about the result. The app window hides
/// meanwhile. After any non-screenshot action the final capture waits for the screen to settle (bounded), so the model
/// can verify the outcome without another turn. A failed step still returns a screenshot, with `failed_step` and `error`.
#[tauri::command]
pub async fn cu_execute(app: AppHandle, actions: Vec<Action>) -> Result<Shot, String> {
    let win = app.get_webview_window("main");
    if let Some(w) = &win {
        let _ = w.hide();
    }
    sleep(Duration::from_millis(300));
    let result = execute_batch(&actions);
    if let Some(w) = &win {
        let _ = w.show();
        let _ = w.set_focus();
    }
    result
}

fn execute_batch(actions: &[Action]) -> Result<Shot, String> {
    let m = primary()?;
    let display = display_size(&m)?;
    let size = fit(display.0, display.1);
    let mut en: Option<Enigo> = None;
    let acting = actions.iter().any(|a| *a != Action::Screenshot);
    let (raw, changed, settled, outcome) = if !acting {
        (grab(&m)?, None, None, Ok(()))
    } else {
        let before = grab(&m).ok().map(|r| thumb_of(&r));
        let outcome = perform(actions, size, display, &mut en);
        let opened = actions.iter().any(|a| matches!(a, Action::OpenApp { .. }));
        sleep(Duration::from_millis(if opened { 400 } else { 120 }));
        let cfg = Settle { poll_ms: 60, stable_ms: 250, max_ms: if opened { 4000 } else { 2000 } };
        let t0 = Instant::now();
        let waited = settle(&cfg, || grab(&m).map(|r| (thumb_of(&r), r)), || t0.elapsed().as_millis() as u64, |ms| sleep(Duration::from_millis(ms)));
        let (raw, after, ok) = match waited {
            Ok(v) => v,
            // A capture failed while polling: fall back to a fixed wait; a second failure is the command's error.
            Err(_) => {
                sleep(Duration::from_millis(400));
                let r = grab(&m)?;
                let th = thumb_of(&r);
                (r, th, false)
            }
        };
        (raw, before.map(|b| differs(&b, &after)), Some(ok), outcome)
    };
    let mut shot = encode(&raw, size)?;
    shot.changed = changed;
    shot.settled = settled;
    if let Err((i, e)) = outcome {
        shot.failed_step = Some(i);
        shot.error = Some(e);
    }
    let (front_app, window_title) = front_window();
    shot.front_app = front_app;
    shot.window_title = window_title;
    shot.cursor = input(&mut en).ok().and_then(|en| en.location().ok()).map(|(x, y)| unmap_coords(x, y, size, display));
    Ok(shot)
}

/// Size of the screenshots the model will see (and whose coordinates it will send).
#[tauri::command]
pub fn cu_screen_size() -> Result<(u32, u32), String> {
    let d = display_size(&primary()?)?;
    Ok(fit(d.0, d.1))
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[derive(Serialize)]
pub struct Permissions {
    accessibility: bool,
    screen: bool,
    /// False where Computer Use cannot work at all (a pure Wayland session: no global input injection or capture without portals).
    supported: bool,
}

/// Windows has no per-app screen/input permission to grant; on Linux X11 neither. A Wayland-only session is reported unsupported.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn other_os_permissions(os: &str, wayland_display: bool, x11_display: bool) -> Permissions {
    let supported = os != "linux" || x11_display || !wayland_display;
    Permissions { accessibility: supported, screen: supported, supported }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn cu_permissions(request: bool) -> Permissions {
    unsafe {
        if request && !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess();
        }
        Permissions { accessibility: AXIsProcessTrusted(), screen: CGPreflightScreenCaptureAccess(), supported: true }
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn cu_permissions(_request: bool) -> Permissions {
    let set = |k: &str| std::env::var_os(k).is_some_and(|v| !v.is_empty());
    other_os_permissions(std::env::consts::OS, set("WAYLAND_DISPLAY"), set("DISPLAY"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn coords_roundtrip_through_downscale() {
        // 1728x1117 points (MacBook Pro 16") downscaled to fit 1440.
        let display = (1728, 1117);
        let shot = fit(display.0, display.1);
        assert_eq!(shot, (1440, 931));
        assert_eq!(map_coords(720, 465, shot, display), (864, 558));
        assert_eq!(map_coords(0, 0, shot, display), (0, 0));
        assert_eq!(map_coords(1440, 931, shot, display), (1728, 1117));
        assert_eq!(unmap_coords(864, 558, shot, display), (720, 465));
        assert_eq!(fit(1280, 800), (1280, 800));
    }

    #[test]
    fn scroll_lines_converts_pixels_to_signed_clamped_lines() {
        assert_eq!(scroll_lines(0), 0);
        assert_eq!(scroll_lines(10), 1);
        assert_eq!(scroll_lines(-10), -1);
        assert_eq!(scroll_lines(120), 3);
        assert_eq!(scroll_lines(-120), -3);
        assert_eq!(scroll_lines(1_000_000), 50);
        assert_eq!(scroll_lines(-1_000_000), -50);
    }

    fn solid(w: usize, h: usize, v: u8) -> Vec<u8> {
        let mut px = Vec::with_capacity(w * h * 4);
        for _ in 0..w * h {
            px.extend_from_slice(&[v, v, v, 255]);
        }
        px
    }

    #[test]
    fn thumbnails_detect_visible_changes_only() {
        let (w, h) = (640, 400);
        let white = solid(w, h, 255);
        let a = thumb(w, h, &white);
        assert_eq!(a.len(), THUMB_W * THUMB_H);
        assert!(a.iter().all(|v| *v == 255));
        assert!(!differs(&a, &thumb(w, h, &white)));
        // A dark 40x40 block (a dialog, a new message) changes the cells it covers.
        let mut block = white.clone();
        for y in 100..140 {
            for x in 200..240 {
                let i = (y * w + x) * 4;
                block[i..i + 3].copy_from_slice(&[0, 0, 0]);
            }
        }
        assert!(differs(&a, &thumb(w, h, &block)));
        // A slight brightness shift everywhere (noise, compression) does not count.
        assert!(!differs(&a, &thumb(w, h, &solid(w, h, 250))));
        // Short or empty buffers do not panic.
        assert_eq!(thumb(0, 0, &[]).len(), THUMB_W * THUMB_H);
        assert_eq!(thumb(10, 10, &[0; 4]).len(), THUMB_W * THUMB_H);
        assert!(differs(&a, &a[..10]));
    }

    /// Runs `settle` against scripted thumbnails with a fake clock: each sample takes 20 ms, each wait advances time.
    fn run_settle(frames: &[u8], cfg: Settle) -> (usize, bool, u64) {
        let clock = Cell::new(0u64);
        let i = Cell::new(0usize);
        let (idx, _, ok) = settle(
            &cfg,
            || {
                let n = i.get();
                i.set(n + 1);
                clock.set(clock.get() + 20);
                Ok((vec![frames[n.min(frames.len() - 1)]; 4], n))
            },
            || clock.get(),
            |ms| clock.set(clock.get() + ms),
        )
        .unwrap();
        (idx, ok, clock.get())
    }

    #[test]
    fn settle_waits_until_the_screen_is_stable() {
        let cfg = || Settle { poll_ms: 60, stable_ms: 250, max_ms: 2000 };
        // Already still: settles after ~250 ms with a handful of captures.
        let (n, ok, t) = run_settle(&[100], cfg());
        assert!(ok);
        assert!(t >= 250 && t < 400, "took {t}");
        assert!(n <= 5);
        // Changing for 4 frames, then still: the stable window restarts after the last change.
        let (n, ok, _) = run_settle(&[0, 50, 100, 150, 200], cfg());
        assert!(ok);
        assert!(n >= 7, "stopped at frame {n}");
        // Never still: gives up at max_ms and reports it.
        let frames: Vec<u8> = (0..200).map(|k| if k % 2 == 0 { 0 } else { 200 }).collect();
        let (_, ok, t) = run_settle(&frames, cfg());
        assert!(!ok);
        assert!(t >= 2000 && t < 2200, "took {t}");
    }

    #[test]
    fn settle_propagates_capture_errors() {
        let cfg = Settle { poll_ms: 10, stable_ms: 50, max_ms: 100 };
        let r = settle(&cfg, || Err::<(Vec<u8>, ()), _>("no permission".to_string()), || 0, |_| {});
        assert_eq!(r.unwrap_err(), "no permission");
    }

    #[test]
    fn permissions_off_macos() {
        let p = other_os_permissions("windows", false, false);
        assert!(p.accessibility && p.screen && p.supported);
        assert!(other_os_permissions("linux", false, true).supported);
        assert!(other_os_permissions("linux", true, true).supported, "XWayland session");
        let w = other_os_permissions("linux", true, false);
        assert!(!w.supported && !w.screen && !w.accessibility);
    }

    #[test]
    fn app_names_reject_paths_and_options() {
        assert_eq!(valid_app_name(" Telegram "), Ok("Telegram"));
        assert_eq!(valid_app_name("System Settings"), Ok("System Settings"));
        assert_eq!(valid_app_name("Safari.app"), Ok("Safari.app"));
        assert_eq!(valid_app_name("Почта"), Ok("Почта"));
        for bad in ["", "  ", "-a", "--args", "/Applications/Safari.app", "../x", "~/Apps/x", ".hidden", "a\\b", "x:y", "a\nb", &"x".repeat(81)] {
            assert!(valid_app_name(bad).is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn actions_parse_from_the_frontend_json() {
        let a: Vec<Action> = serde_json::from_str(
            r#"[{"type":"open_app","name":"Telegram"},{"type":"click","x":1,"y":2},{"type":"keypress","keys":["cmd","f"]},
                {"type":"type","text":"hi"},{"type":"wait"},{"type":"scroll","x":3,"y":4,"scroll_y":-120},{"type":"screenshot"}]"#,
        )
        .unwrap();
        assert_eq!(a[0], Action::OpenApp { name: "Telegram".into() });
        assert_eq!(a[1], Action::Click { x: 1, y: 2, button: None });
        assert_eq!(a[2], Action::Keypress { keys: vec!["cmd".into(), "f".into()] });
        assert_eq!(a[4], Action::Wait { ms: None });
        assert_eq!(a[5], Action::Scroll { x: 3, y: 4, scroll_x: 0, scroll_y: -120 });
        assert_eq!(a[6], Action::Screenshot);
        assert!(serde_json::from_str::<Action>(r#"{"type":"open_app"}"#).is_err());
        assert!(serde_json::from_str::<Action>(r#"{"type":"shell","command":"rm"}"#).is_err());
    }

    #[test]
    fn shot_serializes_camel_case_facts() {
        let s = Shot { png: "x".into(), width: 2, height: 1, front_app: Some("Telegram".into()), cursor: Some((3, 4)), failed_step: Some(1), ..Default::default() };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["frontApp"], "Telegram");
        assert_eq!(v["cursor"], serde_json::json!([3, 4]));
        assert_eq!(v["failedStep"], 1);
        assert!(v["windowTitle"].is_null());
    }
}
