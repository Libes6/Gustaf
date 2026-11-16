// Spike: an HTML UI webview plus a native child webview placed over a slot the UI measures,
// the way BrowserSurfaceSlot places Electron's WebContentsView. Env vars drive a benchmark run.
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl};

const BROWSER: &str = "browser";

// Scrolls down and back up at ~60 steps a second, the same script the Chrome bench runs.
const SCROLL_START: &str = "window.__spikeScroll = setInterval(() => { \
  const max = document.documentElement.scrollHeight - innerHeight; \
  if (window.__dir === undefined) window.__dir = 1; \
  if (scrollY >= max - 2) window.__dir = -1; else if (scrollY <= 0) window.__dir = 1; \
  scrollBy(0, 40 * window.__dir); }, 16);";
const SCROLL_STOP: &str = "clearInterval(window.__spikeScroll);";

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn mark(label: &str) {
    println!("[spike] {label} {}", now_ms());
}

fn env_secs(name: &str, default: u64) -> Duration {
    Duration::from_secs(
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default),
    )
}

#[derive(serde::Deserialize)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
}

#[tauri::command]
fn spike_url() -> Option<String> {
    std::env::var("SPIKE_URL").ok()
}

#[tauri::command]
async fn browser_open(window: tauri::Window, url: String, bounds: Bounds) -> Result<(), String> {
    if let Some(existing) = window.app_handle().get_webview(BROWSER) {
        existing
            .navigate(url.parse().map_err(|e| format!("{e}"))?)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let benchmark = std::env::var("SPIKE_URL").is_ok();
    let builder = WebviewBuilder::new(
        BROWSER,
        WebviewUrl::External(url.parse().map_err(|e| format!("{e}"))?),
    )
    .on_page_load(move |webview, payload| {
        if payload.event() != PageLoadEvent::Finished || !benchmark {
            return;
        }
        // Only the first load starts the run.
        static STARTED: std::sync::Once = std::sync::Once::new();
        STARTED.call_once(|| {
            let webview = webview.clone();
            std::thread::spawn(move || run_benchmark(webview));
        });
    });
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| e.to_string())?;
    if !bounds.visible {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn browser_bounds(app: tauri::AppHandle, bounds: Bounds) -> Result<(), String> {
    let Some(webview) = app.get_webview(BROWSER) else {
        return Ok(());
    };
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| e.to_string())?;
    if bounds.visible {
        webview.show().map_err(|e| e.to_string())
    } else {
        webview.hide().map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn browser_navigate(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let Some(webview) = app.get_webview(BROWSER) else {
        return Err("no browser".into());
    };
    webview
        .navigate(url.parse().map_err(|e| format!("{e}"))?)
        .map_err(|e| e.to_string())
}

fn run_benchmark(webview: tauri::Webview) {
    mark("loaded");
    std::thread::sleep(env_secs("SPIKE_SETTLE_SECS", 5));
    mark("idle-start");
    std::thread::sleep(env_secs("SPIKE_IDLE_SECS", 20));
    mark("idle-end");
    let _ = webview.eval(SCROLL_START);
    mark("scroll-start");
    std::thread::sleep(env_secs("SPIKE_SCROLL_SECS", 20));
    mark("scroll-end");
    let _ = webview.eval(SCROLL_STOP);
    if std::env::var("SPIKE_STAY").is_err() {
        webview.app_handle().exit(0);
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            spike_url,
            browser_open,
            browser_bounds,
            browser_navigate
        ])
        .setup(|app| {
            let window = WindowBuilder::new(app, "main")
                .title("Native browser spike")
                .inner_size(1440.0, 900.0)
                .build()?;
            window.add_child(
                WebviewBuilder::new("ui", WebviewUrl::App("index.html".into())).auto_resize(),
                LogicalPosition::new(0.0, 0.0),
                window.inner_size()?.to_logical::<f64>(window.scale_factor()?),
            )?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("spike failed");
}
