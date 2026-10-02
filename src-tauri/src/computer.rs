use base64::{engine::general_purpose::STANDARD, Engine};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::{Deserialize, Serialize};
use std::{io::Cursor, thread::sleep, time::Duration};
use tauri::{AppHandle, Manager};
use xcap::{image, Monitor};

/// Screenshots are downscaled so the long side fits this; model coordinates are mapped back.
const MAX_SIDE: u32 = 1440;

#[derive(Deserialize, Debug)]
pub struct Point {
    x: i32,
    y: i32,
}

#[derive(Deserialize, Debug)]
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
    Screenshot,
}

#[derive(Serialize)]
pub struct Shot {
    /// PNG, base64 without the data: prefix.
    png: String,
    width: u32,
    height: u32,
}

/// Maps a point from the (possibly downscaled) screenshot space to display points.
pub fn map_coords(x: i32, y: i32, shot: (u32, u32), display: (u32, u32)) -> (i32, i32) {
    let sx = display.0 as f64 / shot.0 as f64;
    let sy = display.1 as f64 / shot.1 as f64;
    ((x as f64 * sx).round() as i32, (y as f64 * sy).round() as i32)
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

fn capture() -> Result<Shot, String> {
    let m = primary()?;
    let (w, h) = fit(display_size(&m)?.0, display_size(&m)?.1);
    let raw = m.capture_image().map_err(|e| format!("screen capture failed (Screen Recording permission?): {e}"))?;
    let img = image::imageops::resize(&raw, w, h, image::imageops::FilterType::Triangle);
    let mut png = Vec::new();
    img.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(Shot { png: STANDARD.encode(png), width: w, height: h })
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
        "cmd" | "command" | "meta" | "super" | "win" => Key::Meta,
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

fn perform(actions: &[Action], shot: (u32, u32), display: (u32, u32)) -> Result<(), String> {
    let mut en = Enigo::new(&Settings::default()).map_err(|e| format!("input unavailable (Accessibility permission?): {e}"))?;
    let e = |r: enigo::InputResult<()>| r.map_err(|e| e.to_string());
    let to = |en: &mut Enigo, x: i32, y: i32| {
        let (x, y) = map_coords(x, y, shot, display);
        en.move_mouse(x, y, Coordinate::Abs)
    };
    for a in actions {
        match a {
            Action::Click { x, y, button } => {
                e(to(&mut en, *x, *y))?;
                let b = match button.as_deref() {
                    Some("right") => Button::Right,
                    Some("middle" | "wheel") => Button::Middle,
                    _ => Button::Left,
                };
                e(en.button(b, Direction::Click))?;
            }
            Action::DoubleClick { x, y } => {
                e(to(&mut en, *x, *y))?;
                e(en.button(Button::Left, Direction::Click))?;
                e(en.button(Button::Left, Direction::Click))?;
            }
            Action::Drag { path } => {
                let (first, rest) = path.split_first().ok_or("empty drag path")?;
                e(to(&mut en, first.x, first.y))?;
                e(en.button(Button::Left, Direction::Press))?;
                for p in rest {
                    sleep(Duration::from_millis(30));
                    e(to(&mut en, p.x, p.y))?;
                }
                e(en.button(Button::Left, Direction::Release))?;
            }
            Action::Move { x, y } => e(to(&mut en, *x, *y))?,
            Action::MouseDown => e(en.button(Button::Left, Direction::Press))?,
            Action::MouseUp => e(en.button(Button::Left, Direction::Release))?,
            Action::Scroll { x, y, scroll_x, scroll_y } => {
                e(to(&mut en, *x, *y))?;
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
            Action::Wait { ms } => sleep(Duration::from_millis(ms.unwrap_or(1000))),
            Action::Screenshot => {}
        }
        sleep(Duration::from_millis(80));
    }
    Ok(())
}

/// Executes actions on the real desktop and returns a fresh screenshot. The app window hides meanwhile.
#[tauri::command]
pub async fn cu_execute(app: AppHandle, actions: Vec<Action>) -> Result<Shot, String> {
    let win = app.get_webview_window("main");
    if let Some(w) = &win {
        let _ = w.hide();
    }
    sleep(Duration::from_millis(300));
    let result = (|| {
        let m = primary()?;
        let display = display_size(&m)?;
        perform(&actions, fit(display.0, display.1), display)?;
        sleep(Duration::from_millis(400));
        capture()
    })();
    if let Some(w) = &win {
        let _ = w.show();
        let _ = w.set_focus();
    }
    result
}

/// Size of the screenshots the model will see (and whose coordinates it will send).
#[tauri::command]
pub fn cu_screen_size() -> Result<(u32, u32), String> {
    let d = display_size(&primary()?)?;
    Ok(fit(d.0, d.1))
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[derive(Serialize)]
pub struct Permissions {
    accessibility: bool,
    screen: bool,
}

#[tauri::command]
pub fn cu_permissions(request: bool) -> Permissions {
    unsafe {
        if request && !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess();
        }
        Permissions { accessibility: AXIsProcessTrusted(), screen: CGPreflightScreenCaptureAccess() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coords_roundtrip_through_downscale() {
        // 1728x1117 points (MacBook Pro 16") downscaled to fit 1440.
        let display = (1728, 1117);
        let shot = fit(display.0, display.1);
        assert_eq!(shot, (1440, 931));
        assert_eq!(map_coords(720, 465, shot, display), (864, 558));
        assert_eq!(map_coords(0, 0, shot, display), (0, 0));
        assert_eq!(map_coords(1440, 931, shot, display), (1728, 1117));
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
}

/// Temporary screenshot files let CLI agents inspect the same image as API models.
#[tauri::command]
pub fn cu_save_shot(png: String) -> Result<String, String> {
    let bytes = STANDARD.decode(png).map_err(|e| e.to_string())?;
    let dir = std::env::temp_dir().join("mcode-screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let path = dir.join(format!("{name}.png"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
