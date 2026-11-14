//! Pure translation of an agent's action into the OS events the backend posts.
//! Points arrive in pixels of a screenshot; events need global display points.

use super::{Action, Button, CaptureGeometry, Display, Error, ErrorCode, ImagePoint};

/// One OS event. Coordinates are global display points: origin at the top left of the main
/// display, y down, negative to the left of or above it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Input {
    Move {
        x: f64,
        y: f64,
        dragging: Option<Button>,
    },
    Button {
        x: f64,
        y: f64,
        button: Button,
        down: bool,
        clicks: u8,
    },
    /// At the pointer, which the preceding move placed.
    Scroll {
        dx: i32,
        dy: i32,
    },
    Key {
        code: u16,
        down: bool,
        flags: u64,
    },
    /// At most `TEXT_CHUNK_UNITS` UTF-16 units, the most one event carries.
    Text(String),
}

pub(crate) const MAX_TEXT_CHARS: usize = 4_000;
const TEXT_CHUNK_UNITS: usize = 20;
const MAX_SCROLL_LINES: i32 = 100;
const MAX_REPEAT: u8 = 50;
const MAX_CLICKS: u8 = 3;
const DRAG_STEPS: u32 = 8;
pub(crate) const DEFAULT_CAPTURE_EDGE: u32 = 1280;
const MIN_CAPTURE_EDGE: u32 = 200;
const MAX_CAPTURE_EDGE: u32 = 2560;

/// Pixel size of a screenshot of `display` that fits the limits and is never upscaled.
pub(crate) fn capture_size(
    display: &Display,
    max_width: Option<u32>,
    max_height: Option<u32>,
) -> (u32, u32) {
    let limit = |value: Option<u32>| {
        f64::from(
            value
                .unwrap_or(DEFAULT_CAPTURE_EDGE)
                .clamp(MIN_CAPTURE_EDGE, MAX_CAPTURE_EDGE),
        )
    };
    let pixels_wide = display.bounds.width * display.scale;
    let pixels_high = display.bounds.height * display.scale;
    let factor = (limit(max_width) / pixels_wide)
        .min(limit(max_height) / pixels_high)
        .min(1.0);
    let size = |pixels: f64| ((pixels * factor).round() as u32).max(1);
    (size(pixels_wide), size(pixels_high))
}

/// The global point at the centre of a screenshot pixel.
pub(crate) fn to_global(capture: &CaptureGeometry, x: f64, y: f64) -> Result<(f64, f64), Error> {
    let inside =
        |value: f64, size: u32| value.is_finite() && value >= 0.0 && value < f64::from(size);
    if !inside(x, capture.width) || !inside(y, capture.height) {
        return Err(Error::new(
            ErrorCode::OutOfBounds,
            format!(
                "({x}, {y}) is outside the {}x{} screenshot.",
                capture.width, capture.height
            ),
        ));
    }
    let bounds = capture.bounds;
    Ok((
        bounds.x + (x + 0.5) * bounds.width / f64::from(capture.width),
        bounds.y + (y + 0.5) * bounds.height / f64::from(capture.height),
    ))
}

/// A screenshot still describes the screen while its display has the same place and scale.
pub(crate) fn capture_is_current(capture: &CaptureGeometry, displays: &[Display]) -> bool {
    displays.iter().any(|display| {
        display.id == capture.display_id
            && display.bounds == capture.bounds
            && display.scale == capture.scale
    })
}

pub(crate) fn points(action: &Action) -> Vec<&ImagePoint> {
    match action {
        Action::Move { at } | Action::Click { at, .. } | Action::Scroll { at, .. } => vec![at],
        Action::Drag { from, to, .. } => vec![from, to],
        Action::Type { .. } | Action::Key { .. } | Action::Activate { .. } => Vec::new(),
    }
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorCode::InvalidAction, message)
}

/// `resolve` maps a screenshot point to a global one; activation is not an input and plans nothing.
pub(crate) fn plan(
    action: &Action,
    resolve: impl Fn(&ImagePoint) -> Result<(f64, f64), Error>,
) -> Result<Vec<Input>, Error> {
    let at =
        |point: &ImagePoint, dragging| resolve(point).map(|(x, y)| Input::Move { x, y, dragging });
    Ok(match action {
        Action::Move { at: point } => vec![at(point, None)?],
        Action::Click {
            at: point,
            button,
            count,
        } => {
            if !(1..=MAX_CLICKS).contains(count) {
                return Err(invalid(format!("count must be 1 to {MAX_CLICKS}.")));
            }
            let (x, y) = resolve(point)?;
            let mut inputs = vec![Input::Move {
                x,
                y,
                dragging: None,
            }];
            for clicks in 1..=*count {
                for down in [true, false] {
                    inputs.push(Input::Button {
                        x,
                        y,
                        button: *button,
                        down,
                        clicks,
                    });
                }
            }
            inputs
        }
        Action::Drag { from, to, button } => {
            let (from_x, from_y) = resolve(from)?;
            let (to_x, to_y) = resolve(to)?;
            let mut inputs = vec![
                at(from, None)?,
                Input::Button {
                    x: from_x,
                    y: from_y,
                    button: *button,
                    down: true,
                    clicks: 1,
                },
            ];
            for step in 1..=DRAG_STEPS {
                let part = f64::from(step) / f64::from(DRAG_STEPS);
                inputs.push(Input::Move {
                    x: from_x + (to_x - from_x) * part,
                    y: from_y + (to_y - from_y) * part,
                    dragging: Some(*button),
                });
            }
            inputs.push(Input::Button {
                x: to_x,
                y: to_y,
                button: *button,
                down: false,
                clicks: 1,
            });
            inputs
        }
        Action::Scroll {
            at: point,
            delta_x,
            delta_y,
        } => {
            let range = -MAX_SCROLL_LINES..=MAX_SCROLL_LINES;
            if !range.contains(delta_x) || !range.contains(delta_y) {
                return Err(invalid(format!(
                    "Scroll at most {MAX_SCROLL_LINES} lines at a time."
                )));
            }
            vec![
                at(point, None)?,
                Input::Scroll {
                    dx: *delta_x,
                    dy: *delta_y,
                },
            ]
        }
        Action::Type { text } => type_text(text)?,
        Action::Key { keys, repeat } => press(keys, *repeat)?,
        Action::Activate { .. } => Vec::new(),
    })
}

/// Unicode text goes in as text, not key codes, so it does not depend on the keyboard layout.
/// A line break is the Return key: many fields ignore a typed newline.
fn type_text(text: &str) -> Result<Vec<Input>, Error> {
    if text.is_empty() || text.chars().count() > MAX_TEXT_CHARS {
        return Err(invalid(format!(
            "text must be 1 to {MAX_TEXT_CHARS} characters."
        )));
    }
    let mut inputs = Vec::new();
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    for (index, line) in normalized.split('\n').enumerate() {
        if index > 0 {
            inputs.extend(tap(RETURN, 0));
        }
        let mut chunk = String::new();
        for character in line.chars() {
            if chunk.encode_utf16().count() + character.len_utf16() > TEXT_CHUNK_UNITS {
                inputs.push(Input::Text(std::mem::take(&mut chunk)));
            }
            chunk.push(character);
        }
        if !chunk.is_empty() {
            inputs.push(Input::Text(chunk));
        }
    }
    Ok(inputs)
}

const RETURN: u16 = 0x24;

fn tap(code: u16, flags: u64) -> [Input; 2] {
    [
        Input::Key {
            code,
            down: true,
            flags,
        },
        Input::Key {
            code,
            down: false,
            flags,
        },
    ]
}

/// Modifiers go down in the order given, the key is pressed, then modifiers come up in reverse.
fn press(keys: &[String], repeat: u8) -> Result<Vec<Input>, Error> {
    if !(1..=MAX_REPEAT).contains(&repeat) {
        return Err(invalid(format!("repeat must be 1 to {MAX_REPEAT}.")));
    }
    let mut modifiers: Vec<(u16, u64)> = Vec::new();
    let mut key = None;
    for name in keys {
        match key_code(name) {
            Some(Key::Modifier(code, flag)) => {
                if !modifiers.contains(&(code, flag)) {
                    modifiers.push((code, flag));
                }
            }
            Some(Key::Plain(code)) if key.is_none() => key = Some(code),
            Some(Key::Plain(_)) => {
                return Err(invalid(
                    "Press one key at a time, with any modifiers, such as [\"command\", \"s\"].",
                ))
            }
            None => return Err(invalid(format!("Unknown key \"{name}\"."))),
        }
    }
    let Some(key) = key else {
        return Err(invalid(
            "Name one key besides the modifiers, such as [\"command\", \"s\"].",
        ));
    };
    let mut inputs = Vec::new();
    for _ in 0..repeat {
        let mut flags = 0;
        for (code, flag) in &modifiers {
            flags |= flag;
            inputs.push(Input::Key {
                code: *code,
                down: true,
                flags,
            });
        }
        inputs.extend(tap(key, flags));
        for (code, flag) in modifiers.iter().rev() {
            flags &= !flag;
            inputs.push(Input::Key {
                code: *code,
                down: false,
                flags,
            });
        }
    }
    Ok(inputs)
}

enum Key {
    Modifier(u16, u64),
    Plain(u16),
}

const SHIFT: u64 = 0x0002_0000;
const CONTROL: u64 = 0x0004_0000;
const OPTION: u64 = 0x0008_0000;
const COMMAND: u64 = 0x0010_0000;
const FUNCTION: u64 = 0x0080_0000;

/// macOS virtual key codes of the ANSI layout. Letters name keys, not characters: with a
/// Russian layout, ["command", "s"] is still Save.
fn key_code(name: &str) -> Option<Key> {
    let name = name.trim().to_ascii_lowercase();
    let modifier = match name.as_str() {
        "command" | "cmd" | "meta" | "super" => Some((0x37, COMMAND)),
        "shift" => Some((0x38, SHIFT)),
        "option" | "opt" | "alt" => Some((0x3A, OPTION)),
        "control" | "ctrl" => Some((0x3B, CONTROL)),
        "fn" | "function" => Some((0x3F, FUNCTION)),
        _ => None,
    };
    if let Some((code, flag)) = modifier {
        return Some(Key::Modifier(code, flag));
    }
    const LETTERS: &str = "asdfhgzxcv\0bqweryt";
    let code = match name.as_str() {
        "return" | "enter" => RETURN,
        "tab" => 0x30,
        "space" => 0x31,
        "backspace" | "delete" => 0x33,
        "escape" | "esc" => 0x35,
        "forwarddelete" | "del" => 0x75,
        "home" => 0x73,
        "end" => 0x77,
        "pageup" => 0x74,
        "pagedown" => 0x79,
        "left" | "arrowleft" => 0x7B,
        "right" | "arrowright" => 0x7C,
        "down" | "arrowdown" => 0x7D,
        "up" | "arrowup" => 0x7E,
        "f1" => 0x7A,
        "f2" => 0x78,
        "f3" => 0x63,
        "f4" => 0x76,
        "f5" => 0x60,
        "f6" => 0x61,
        "f7" => 0x62,
        "f8" => 0x64,
        "f9" => 0x65,
        "f10" => 0x6D,
        "f11" => 0x67,
        "f12" => 0x6F,
        single if single.chars().count() == 1 => {
            let character = single.chars().next()?;
            if let Some(index) = LETTERS.find(character).filter(|_| character != '\0') {
                index as u16
            } else {
                match character {
                    'o' => 0x1F,
                    'u' => 0x20,
                    'i' => 0x22,
                    'p' => 0x23,
                    'l' => 0x25,
                    'j' => 0x26,
                    'k' => 0x28,
                    'n' => 0x2D,
                    'm' => 0x2E,
                    '1' => 0x12,
                    '2' => 0x13,
                    '3' => 0x14,
                    '4' => 0x15,
                    '6' => 0x16,
                    '5' => 0x17,
                    '=' => 0x18,
                    '9' => 0x19,
                    '7' => 0x1A,
                    '-' => 0x1B,
                    '8' => 0x1C,
                    '0' => 0x1D,
                    ']' => 0x1E,
                    '[' => 0x21,
                    '\'' => 0x27,
                    ';' => 0x29,
                    '\\' => 0x2A,
                    ',' => 0x2B,
                    '/' => 0x2C,
                    '.' => 0x2F,
                    '`' => 0x32,
                    _ => return None,
                }
            }
        }
        _ => return None,
    };
    Some(Key::Plain(code))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer_use::Rect;

    fn display(id: u32, x: f64, y: f64, width: f64, height: f64, scale: f64) -> Display {
        Display {
            id,
            name: format!("Display {id}"),
            main: id == 1,
            bounds: Rect {
                x,
                y,
                width,
                height,
            },
            scale,
        }
    }

    fn capture_of(display: &Display) -> CaptureGeometry {
        let (width, height) = capture_size(display, None, None);
        CaptureGeometry {
            capture_id: "c1".into(),
            display_id: display.id,
            bounds: display.bounds,
            scale: display.scale,
            width,
            height,
        }
    }

    #[test]
    fn screenshot_pixels_map_to_global_points() {
        // (display, screenshot size, pixel, expected global point)
        let cases = [
            // Retina laptop: 2880x1800 pixels shrink to 1280x800; scale cancels out.
            (
                display(1, 0.0, 0.0, 1440.0, 900.0, 2.0),
                (1280, 800),
                (640.0, 400.0),
                (720.5625, 450.5625),
            ),
            // A second display left of and above the main one.
            (
                display(2, -1920.0, -200.0, 1920.0, 1080.0, 1.0),
                (1280, 720),
                (0.0, 0.0),
                (-1919.25, -199.25),
            ),
            // A small display is not upscaled: one pixel per point.
            (
                display(3, 1440.0, 0.0, 1024.0, 768.0, 1.0),
                (1024, 768),
                (1023.0, 767.0),
                (2463.5, 767.5),
            ),
        ];
        for (display, size, (x, y), expected) in cases {
            let capture = capture_of(&display);
            assert_eq!((capture.width, capture.height), size);
            assert_eq!(to_global(&capture, x, y).unwrap(), expected);
        }
    }

    #[test]
    fn points_outside_the_screenshot_or_after_a_display_change_are_refused() {
        let main = display(1, 0.0, 0.0, 1440.0, 900.0, 2.0);
        let capture = capture_of(&main);
        for (x, y) in [(1280.0, 0.0), (0.0, 800.0), (-1.0, 5.0), (f64::NAN, 1.0)] {
            assert_eq!(
                to_global(&capture, x, y).unwrap_err().code,
                ErrorCode::OutOfBounds
            );
        }
        assert!(capture_is_current(&capture, std::slice::from_ref(&main)));
        let rescaled = display(1, 0.0, 0.0, 1728.0, 1117.0, 2.0);
        let moved = display(1, 0.0, -900.0, 1440.0, 900.0, 2.0);
        assert!(!capture_is_current(&capture, &[rescaled]));
        assert!(!capture_is_current(&capture, &[moved]));
        assert!(!capture_is_current(&capture, &[]));
    }

    #[test]
    fn capture_limits_are_clamped() {
        let retina = display(1, 0.0, 0.0, 1512.0, 982.0, 2.0);
        assert_eq!(capture_size(&retina, Some(10), Some(10)), (200, 130));
        assert_eq!(
            capture_size(&retina, Some(99_999), Some(99_999)),
            (2560, 1663)
        );
    }

    #[test]
    fn russian_and_multiline_text_is_typed_as_unicode_chunks() {
        let inputs = type_text("Привет, мир! Это проверка ввода 👋\nвторая").unwrap();
        let texts: Vec<_> = inputs
            .iter()
            .map(|input| match input {
                Input::Text(text) => text.clone(),
                Input::Key { code, down, .. } => format!("<key {code} {down}>"),
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        assert_eq!(
            texts,
            [
                "Привет, мир! Это про",
                "верка ввода 👋",
                "<key 36 true>",
                "<key 36 false>",
                "вторая",
            ]
        );
        for text in &texts {
            assert!(text.encode_utf16().count() <= TEXT_CHUNK_UNITS);
        }
        assert_eq!(type_text("").unwrap_err().code, ErrorCode::InvalidAction);
    }

    #[test]
    fn shortcuts_hold_modifiers_around_one_key() {
        let keys = |names: &[&str]| {
            names
                .iter()
                .map(|name| name.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            press(&keys(&["Cmd", "shift", "s"]), 1).unwrap(),
            [
                Input::Key {
                    code: 0x37,
                    down: true,
                    flags: COMMAND
                },
                Input::Key {
                    code: 0x38,
                    down: true,
                    flags: COMMAND | SHIFT
                },
                Input::Key {
                    code: 0x01,
                    down: true,
                    flags: COMMAND | SHIFT
                },
                Input::Key {
                    code: 0x01,
                    down: false,
                    flags: COMMAND | SHIFT
                },
                Input::Key {
                    code: 0x38,
                    down: false,
                    flags: COMMAND
                },
                Input::Key {
                    code: 0x37,
                    down: false,
                    flags: 0
                },
            ]
        );
        assert_eq!(press(&keys(&["tab"]), 3).unwrap().len(), 6);
        for (names, repeat) in [
            (keys(&["command"]), 1),
            (keys(&["a", "b"]), 1),
            (keys(&["hyper", "a"]), 1),
            (keys(&["a"]), 0),
            (keys(&["a"]), 51),
        ] {
            assert_eq!(
                press(&names, repeat).unwrap_err().code,
                ErrorCode::InvalidAction
            );
        }
    }

    #[test]
    fn key_names_follow_the_ansi_layout() {
        for (name, code) in [
            ("a", 0x00),
            ("s", 0x01),
            ("t", 0x11),
            ("o", 0x1F),
            ("m", 0x2E),
            ("1", 0x12),
            ("0", 0x1D),
            ("Return", RETURN),
            ("esc", 0x35),
            ("up", 0x7E),
            ("/", 0x2C),
        ] {
            assert!(
                matches!(key_code(name), Some(Key::Plain(found)) if found == code),
                "{name}"
            );
        }
        assert!(key_code("\0").is_none());
        assert!(key_code("я").is_none());
    }
}
