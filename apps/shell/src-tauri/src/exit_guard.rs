//! Quitting or restarting the app stops the bundled server, and every agent turn it runs with it.
//! Before that the shell asks the server how many threads are working and lets the user back out.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::local_env::LocalEnvironmentState;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Exit {
    Quit,
    /// A settings change that needs the server started again.
    Restart,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Language {
    En,
    Ru,
}

#[derive(Debug, PartialEq, Eq)]
struct Warning {
    title: String,
    message: String,
    leave: String,
    stay: String,
}

/// `None` means leave without asking: nothing is running, or the server could not say.
/// A server that does not answer must never keep the user from quitting.
fn warning(working: Option<u64>, exit: Exit, language: Language) -> Option<Warning> {
    let count = working.filter(|count| *count > 0)?;
    let one = match language {
        Language::En => count == 1,
        Language::Ru => russian_plural(count) == RussianPlural::One,
    };
    let warning = match language {
        Language::En => {
            let agents = if one {
                "1 agent is still working".to_owned()
            } else {
                format!("{count} agents are still working")
            };
            let them = if one { "it" } else { "them" };
            let (title, message, leave) = match exit {
                Exit::Quit => (
                    "Quit Gustaf?",
                    format!("{agents}. Quitting stops {them}."),
                    "Quit anyway",
                ),
                Exit::Restart => (
                    "Restart Gustaf?",
                    format!("This setting takes effect after Gustaf restarts. {agents}, and restarting stops {them}."),
                    "Restart anyway",
                ),
            };
            Warning {
                title: title.to_owned(),
                message,
                leave: leave.to_owned(),
                stay: "Keep working".to_owned(),
            }
        }
        Language::Ru => {
            let noun = match russian_plural(count) {
                RussianPlural::One => "агент",
                RussianPlural::Few => "агента",
                RussianPlural::Many => "агентов",
            };
            let agents = if one {
                format!("Ещё работает {count} {noun}")
            } else {
                format!("Ещё работают {count} {noun}")
            };
            let them = if one { "его" } else { "их" };
            let (title, message, leave) = match exit {
                Exit::Quit => (
                    "Выйти из Gustaf?",
                    format!("{agents}. Выход остановит {them}."),
                    "Всё равно выйти",
                ),
                Exit::Restart => (
                    "Перезапустить Gustaf?",
                    format!("Настройка применится после перезапуска Gustaf. {agents}, перезапуск остановит {them}."),
                    "Всё равно перезапустить",
                ),
            };
            Warning {
                title: title.to_owned(),
                message,
                leave: leave.to_owned(),
                stay: "Продолжить работу".to_owned(),
            }
        }
    };
    Some(warning)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RussianPlural {
    One,
    Few,
    Many,
}

fn russian_plural(count: u64) -> RussianPlural {
    match (count % 10, count % 100) {
        (1, rest) if rest != 11 => RussianPlural::One,
        (2..=4, rest) if !(12..=14).contains(&rest) => RussianPlural::Few,
        _ => RussianPlural::Many,
    }
}

/// The page saves its settings through the shell, so the interface language is on disk.
fn language_from_settings(settings: &serde_json::Value) -> Language {
    match settings
        .get("uiLanguage")
        .and_then(serde_json::Value::as_str)
    {
        Some("ru") => Language::Ru,
        _ => Language::En,
    }
}

pub(crate) fn saved_language(app: &tauri::AppHandle) -> Language {
    crate::bridge::client_settings_path(app)
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .map_or(Language::En, |settings| language_from_settings(&settings))
}

fn working_from_response(body: &serde_json::Value) -> Option<u64> {
    body.get("workingThreads")?.as_u64()
}

fn working_threads(app: &tauri::AppHandle) -> Option<u64> {
    let local = app.try_state::<LocalEnvironmentState>()?;
    let base = local.http_base_url().ok()?;
    let bearer = local.bearer_token().ok()?;
    let response = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(1))
        .timeout(Duration::from_secs(3))
        .build()
        .get(&format!(
            "{}/api/orchestration/working-threads",
            base.trim_end_matches('/')
        ))
        .set("Authorization", &format!("Bearer {bearer}"))
        .call();
    match response {
        Ok(response) => working_from_response(&response.into_json().ok()?),
        Err(error) => {
            eprintln!("[gustaf] could not ask the server for running agents: {error}");
            None
        }
    }
}

/// Whether to go ahead. Blocks on the server and on the dialog, so never call it on the main thread.
pub(crate) fn confirm(app: &tauri::AppHandle, exit: Exit) -> bool {
    let Some(warning) = warning(working_threads(app), exit, saved_language(app)) else {
        return true;
    };
    app.dialog()
        .message(warning.message)
        .title(warning.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            warning.leave,
            warning.stay,
        ))
        .blocking_show()
}

/// Quits once the user agrees. Returns at once; a second request while one is open is ignored.
pub(crate) fn request_quit(app: &tauri::AppHandle) {
    static ASKING: AtomicBool = AtomicBool::new(false);
    if ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if confirm(&app, Exit::Quit) {
            app.exit(0);
        }
        ASKING.store(false, Ordering::SeqCst);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_running_or_no_answer_leaves_without_asking() {
        for exit in [Exit::Quit, Exit::Restart] {
            assert_eq!(warning(None, exit, Language::En), None);
            assert_eq!(warning(Some(0), exit, Language::Ru), None);
        }
    }

    #[test]
    fn quitting_names_the_running_agents() {
        let one = warning(Some(1), Exit::Quit, Language::En).unwrap();
        assert_eq!(one.title, "Quit Gustaf?");
        assert_eq!(one.message, "1 agent is still working. Quitting stops it.");
        assert_eq!(
            (one.leave.as_str(), one.stay.as_str()),
            ("Quit anyway", "Keep working")
        );
        let three = warning(Some(3), Exit::Quit, Language::En).unwrap();
        assert_eq!(
            three.message,
            "3 agents are still working. Quitting stops them."
        );
    }

    #[test]
    fn a_restart_for_a_setting_says_why_it_restarts() {
        let warning = warning(Some(2), Exit::Restart, Language::En).unwrap();
        assert_eq!(warning.title, "Restart Gustaf?");
        assert!(warning
            .message
            .starts_with("This setting takes effect after Gustaf restarts."));
        assert!(warning.message.contains("2 agents are still working"));
        assert_eq!(warning.leave, "Restart anyway");
    }

    #[test]
    fn russian_text_agrees_with_the_count() {
        let message = |count| {
            warning(Some(count), Exit::Quit, Language::Ru)
                .unwrap()
                .message
        };
        assert_eq!(message(1), "Ещё работает 1 агент. Выход остановит его.");
        assert_eq!(message(3), "Ещё работают 3 агента. Выход остановит их.");
        assert_eq!(message(5), "Ещё работают 5 агентов. Выход остановит их.");
        assert_eq!(message(11), "Ещё работают 11 агентов. Выход остановит их.");
        assert_eq!(message(21), "Ещё работает 21 агент. Выход остановит его.");
        assert_eq!(message(22), "Ещё работают 22 агента. Выход остановит их.");
        let restart = warning(Some(2), Exit::Restart, Language::Ru).unwrap();
        assert_eq!(
            (restart.leave.as_str(), restart.stay.as_str()),
            ("Всё равно перезапустить", "Продолжить работу")
        );
    }

    #[test]
    fn the_language_follows_the_saved_interface_language() {
        let read = |value: serde_json::Value| language_from_settings(&value);
        assert_eq!(
            read(serde_json::json!({ "uiLanguage": "ru" })),
            Language::Ru
        );
        assert_eq!(
            read(serde_json::json!({ "uiLanguage": "en" })),
            Language::En
        );
        assert_eq!(read(serde_json::json!({})), Language::En);
    }

    #[test]
    fn reads_the_count_from_the_server_answer() {
        let read = |value: serde_json::Value| working_from_response(&value);
        assert_eq!(read(serde_json::json!({ "workingThreads": 4 })), Some(4));
        assert_eq!(
            read(serde_json::json!({ "_tag": "EnvironmentScopeRequiredError" })),
            None
        );
        assert_eq!(read(serde_json::json!({ "workingThreads": -1 })), None);
    }
}
