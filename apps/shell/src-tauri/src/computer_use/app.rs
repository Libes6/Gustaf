//! The executor inside the running shell: the menu-bar indicator, the emergency shortcut,
//! the enable dialog and the channel the server reaches it through.

use std::sync::{Arc, Mutex, OnceLock, Weak};

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use super::channel::{self, Channel};
use super::macos::HelperBackend;
use super::{EndReason, Executor, Host, Owner, EMERGENCY_SHORTCUT};
use crate::exit_guard::{saved_language, Language};
use crate::shell_settings::{self, ShellSettings};

/// Not taken by macOS; Escape because it means "stop". Shown to users as `EMERGENCY_SHORTCUT`.
const EMERGENCY_ACCELERATOR: &str = "Control+Option+Command+Escape";
const TRAY_ID: &str = "computer-use";
const STOP_MENU_ID: &str = "computer-use-stop";
pub(crate) const SOCKET_ENV: &str = "GUSTAF_COMPUTER_USE_SOCKET";
pub(crate) const TOKEN_ENV: &str = "GUSTAF_COMPUTER_USE_TOKEN";

struct Text {
    title: &'static str,
    confirm: String,
    allow: &'static str,
    deny: &'static str,
    indicator: &'static str,
    owner: &'static str,
    stop: String,
}

fn text(language: Language) -> Text {
    match language {
        Language::En => Text {
            title: "Allow agents to control this Mac?",
            confirm: format!("The agent in the thread you allow will see this Mac's screen and use its mouse and keyboard. You are asked once; later threads are allowed from the app. While an agent is in control, the menu bar says so. To stop: Stop in the thread, Stop control in the menu bar, or {EMERGENCY_SHORTCUT}."),
            allow: "Allow",
            deny: "Don't Allow",
            indicator: "Agent controls Mac",
            owner: "Controlled by",
            stop: format!("Stop control ({EMERGENCY_SHORTCUT})"),
        },
        Language::Ru => Text {
            title: "Разрешить агентам управлять этим Mac?",
            confirm: format!("Агент в треде, которому вы разрешите, будет видеть экран этого Mac и пользоваться мышью и клавиатурой. Это спрашивается один раз; следующие треды разрешаются из приложения. Пока агент управляет, об этом говорит строка меню. Остановить: «Стоп» в треде, «Остановить управление» в строке меню или {EMERGENCY_SHORTCUT}."),
            allow: "Разрешить",
            deny: "Не разрешать",
            indicator: "Агент управляет Mac",
            owner: "Управляет",
            stop: format!("Остановить управление ({EMERGENCY_SHORTCUT})"),
        },
    }
}

struct AppHost {
    app: tauri::AppHandle,
    channel: Arc<OnceLock<Weak<Channel>>>,
}

/// UI handlers run on the main thread; ending waits for a step in flight, so it runs elsewhere.
fn end_in_background(app: &tauri::AppHandle, reason: EndReason) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(executor) = app.try_state::<Arc<Executor>>() {
            executor.end(reason);
        }
    });
}

impl Host for AppHost {
    fn confirm_enable(&self) -> bool {
        let text = text(saved_language(&self.app));
        self.app
            .dialog()
            .message(text.confirm)
            .title(text.title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                text.allow.to_owned(),
                text.deny.to_owned(),
            ))
            .blocking_show()
    }

    fn save_enabled(&self, enabled: bool) -> Result<(), String> {
        let state = self.app.state::<Mutex<ShellSettings>>();
        let mut settings = state.lock().map_err(|error| error.to_string())?;
        let mut next = settings.clone();
        next.computer_use_enabled = enabled;
        shell_settings::save(&self.app, &next)?;
        *settings = next;
        Ok(())
    }

    fn session_started(&self, owner: &Owner) -> Result<(), String> {
        self.app
            .global_shortcut()
            .on_shortcut(EMERGENCY_ACCELERATOR, |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    end_in_background(app, EndReason::EmergencyShortcut);
                }
            })
            .map_err(|error| error.to_string())?;
        if let Err(error) = self.show_indicator(owner) {
            let _ = self.app.global_shortcut().unregister(EMERGENCY_ACCELERATOR);
            return Err(error);
        }
        self.broadcast_later();
        Ok(())
    }

    fn session_ended(&self, _reason: EndReason) {
        let _ = self.app.global_shortcut().unregister(EMERGENCY_ACCELERATOR);
        let _ = self.app.remove_tray_by_id(TRAY_ID);
        self.broadcast_later();
    }
}

impl AppHost {
    fn show_indicator(&self, owner: &Owner) -> Result<(), String> {
        use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
        use tauri::tray::TrayIconBuilder;
        let text = text(saved_language(&self.app));
        let app = &self.app;
        let owner = MenuItem::new(
            app,
            format!("{}: {}", text.owner, owner.label),
            false,
            None::<&str>,
        )
        .map_err(|error| error.to_string())?;
        let stop = MenuItem::with_id(app, STOP_MENU_ID, text.stop, true, None::<&str>)
            .map_err(|error| error.to_string())?;
        let separator = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
        let menu = Menu::with_items(app, &[&owner, &separator, &stop])
            .map_err(|error| error.to_string())?;
        let mut tray = TrayIconBuilder::with_id(TRAY_ID)
            .title(text.indicator)
            .tooltip(text.indicator)
            .menu(&menu)
            .show_menu_on_left_click(true)
            .on_menu_event(|app, event| {
                if event.id() == STOP_MENU_ID {
                    end_in_background(app, EndReason::StoppedByUser);
                }
            });
        if let Some(icon) = app.default_window_icon() {
            tray = tray.icon(icon.clone());
        }
        tray.build(app).map(drop).map_err(|error| error.to_string())
    }

    /// The executor's state lock is held while this runs; status reads it, so send afterwards.
    fn broadcast_later(&self) {
        if let Some(channel) = self.channel.get().and_then(Weak::upgrade) {
            std::thread::spawn(move || channel.broadcast_status());
        }
    }
}

/// Starts the executor and its channel. Returns what the server needs to reach it, which the
/// shell gives only to the server it starts. Without a channel the server reports unavailable.
pub(crate) fn initialize(
    app: &tauri::AppHandle,
    settings: &ShellSettings,
) -> Vec<(String, String)> {
    let Ok(lock_path) = app
        .path()
        .data_dir()
        .map(|dir| dir.join("Gustaf/computer-use.lock"))
    else {
        return Vec::new();
    };
    let channel_slot = Arc::new(OnceLock::new());
    let executor = Arc::new(Executor::new(
        true,
        // A restart never resumes control: the switch persists, a session does not.
        settings.computer_use_enabled,
        lock_path,
        app.package_info().name.clone(),
        Box::new(HelperBackend::new(app.clone())),
        Box::new(AppHost {
            app: app.clone(),
            channel: Arc::clone(&channel_slot),
        }),
    ));
    app.manage(Arc::clone(&executor));
    let token = crate::account::random_token();
    let channel = Channel::new(executor, token.clone());
    let _ = channel_slot.set(Arc::downgrade(&channel));
    let path = channel::socket_path();
    if let Err(error) = channel::listen(&path, Arc::clone(&channel)) {
        eprintln!("[gustaf] computer use is unavailable: {error}");
        return Vec::new();
    }
    // Keeps the channel alive for the app's lifetime.
    app.manage(channel);
    vec![
        (SOCKET_ENV.to_owned(), path.to_string_lossy().into_owned()),
        (TOKEN_ENV.to_owned(), token),
    ]
}

pub(crate) fn shutdown(app: &tauri::AppHandle) {
    if let Some(executor) = app.try_state::<Arc<Executor>>() {
        executor.end(EndReason::AppQuit);
    }
    let _ = std::fs::remove_file(channel::socket_path());
}
