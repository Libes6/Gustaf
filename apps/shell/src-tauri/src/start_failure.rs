//! When the server does not start there is no window, so a native dialog is all the user sees.
//! It names the reason and lets them try again, keep the details, or quit; it never just closes.

use std::thread;

use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

use crate::exit_guard::{saved_language, Language};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Choice {
    TryAgain,
    Copy,
    SendReport,
    Quit,
}

#[derive(Debug, PartialEq, Eq)]
struct Dialog {
    message: String,
    /// Two or three buttons, the first one the default.
    buttons: Vec<(String, Choice)>,
}

/// Signed in, the user can send the text as a problem report; otherwise it can be copied
/// where the platform allows it.
fn dialog(reason: &str, language: Language, signed_in: bool, can_copy: bool) -> Dialog {
    let (headline, report_hint, try_again, copy, send, quit) = match language {
        Language::En => (
            "Gustaf could not start.",
            "You can send this message to the Gustaf team as a problem report.",
            "Try again",
            "Copy details",
            "Send report",
            "Quit",
        ),
        Language::Ru => (
            "Не удалось запустить Gustaf.",
            "Это сообщение можно отправить команде Gustaf как отчёт о проблеме.",
            "Повторить",
            "Скопировать подробности",
            "Отправить отчёт",
            "Выйти",
        ),
    };
    let mut message = format!("{headline}\n\n{reason}");
    let mut buttons = vec![(try_again.to_owned(), Choice::TryAgain)];
    if signed_in {
        message.push_str("\n\n");
        message.push_str(report_hint);
        buttons.push((send.to_owned(), Choice::SendReport));
    } else if can_copy {
        buttons.push((copy.to_owned(), Choice::Copy));
    }
    buttons.push((quit.to_owned(), Choice::Quit));
    Dialog { message, buttons }
}

/// Closing the dialog without a button, or an answer the dialog did not offer, quits.
fn choice(buttons: &[(String, Choice)], pressed: Option<&str>) -> Choice {
    pressed
        .and_then(|label| buttons.iter().find(|(button, _)| button == label))
        .map_or(Choice::Quit, |(_, choice)| *choice)
}

fn report_outcome(language: Language, sent: &Result<(), String>) -> String {
    match (language, sent) {
        (Language::En, Ok(())) => "The report was sent. Thank you.".to_owned(),
        (Language::En, Err(error)) => format!("The report could not be sent: {error}"),
        (Language::Ru, Ok(())) => "Отчёт отправлен. Спасибо.".to_owned(),
        (Language::Ru, Err(error)) => format!("Не удалось отправить отчёт: {error}"),
    }
}

#[cfg(target_os = "macos")]
fn copy_to_clipboard(text: &str) {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    #[allow(unused_unsafe)]
    unsafe {
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        pasteboard.setString_forType(&NSString::from_str(text), NSPasteboardTypeString);
    }
}

#[cfg(not(target_os = "macos"))]
fn copy_to_clipboard(_text: &str) {}

/// Shows the reason until the user picks what to do. Returns at once; the dialog runs on its own
/// thread because the account check reads the keyring, which can block.
pub(crate) fn report(app: &tauri::AppHandle, reason: &str) {
    eprintln!("Gustaf could not start: {reason}");
    let app = app.clone();
    let reason = reason.to_owned();
    thread::spawn(move || {
        let language = saved_language(&app);
        loop {
            let dialog = dialog(
                &reason,
                language,
                crate::account::has_session(&app),
                cfg!(target_os = "macos"),
            );
            let labels: Vec<String> = dialog
                .buttons
                .iter()
                .map(|(label, _)| label.clone())
                .collect();
            let buttons = match labels.as_slice() {
                [first, second, third] => MessageDialogButtons::YesNoCancelCustom(
                    first.clone(),
                    second.clone(),
                    third.clone(),
                ),
                [first, second] => {
                    MessageDialogButtons::OkCancelCustom(first.clone(), second.clone())
                }
                _ => unreachable!("the dialog always offers two or three buttons"),
            };
            let pressed = app
                .dialog()
                .message(dialog.message.clone())
                .title("Gustaf")
                .kind(MessageDialogKind::Error)
                .buttons(buttons)
                .blocking_show_with_result();
            let pressed = match &pressed {
                MessageDialogResult::Custom(label) => Some(label.as_str()),
                _ => None,
            };
            match choice(&dialog.buttons, pressed) {
                // No server was started, so there is nothing to stop before the relaunch.
                Choice::TryAgain => app.restart(),
                Choice::Copy => copy_to_clipboard(&dialog.message),
                Choice::SendReport => {
                    let sent = crate::account::send_problem_report(&app, &dialog.message, None);
                    app.dialog()
                        .message(report_outcome(language, &sent))
                        .title("Gustaf")
                        .blocking_show();
                }
                Choice::Quit => {
                    app.exit(1);
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(dialog: &Dialog) -> Vec<&str> {
        dialog
            .buttons
            .iter()
            .map(|(label, _)| label.as_str())
            .collect()
    }

    #[test]
    fn the_dialog_names_the_reason_and_always_offers_a_retry_and_a_way_out() {
        let shown = dialog(
            "The server stopped before it was ready.",
            Language::En,
            false,
            true,
        );
        assert_eq!(
            shown.message,
            "Gustaf could not start.\n\nThe server stopped before it was ready."
        );
        assert_eq!(labels(&shown), ["Try again", "Copy details", "Quit"]);
        let no_clipboard = dialog("x", Language::En, false, false);
        assert_eq!(labels(&no_clipboard), ["Try again", "Quit"]);
    }

    #[test]
    fn signed_in_the_details_go_to_a_problem_report() {
        let shown = dialog("x", Language::En, true, true);
        assert!(shown
            .message
            .ends_with("You can send this message to the Gustaf team as a problem report."));
        assert_eq!(labels(&shown), ["Try again", "Send report", "Quit"]);
    }

    #[test]
    fn the_dialog_follows_the_saved_interface_language() {
        let shown = dialog("x", Language::Ru, false, true);
        assert!(shown
            .message
            .starts_with("Не удалось запустить Gustaf.\n\nx"));
        assert_eq!(
            labels(&shown),
            ["Повторить", "Скопировать подробности", "Выйти"]
        );
        let signed_in = dialog("x", Language::Ru, true, false);
        assert_eq!(
            labels(&signed_in),
            ["Повторить", "Отправить отчёт", "Выйти"]
        );
        assert_eq!(
            report_outcome(Language::Ru, &Err("нет сети".to_owned())),
            "Не удалось отправить отчёт: нет сети"
        );
    }

    #[test]
    fn a_pressed_button_maps_to_its_action_and_anything_else_quits() {
        let shown = dialog("x", Language::En, false, true);
        assert_eq!(choice(&shown.buttons, Some("Try again")), Choice::TryAgain);
        assert_eq!(choice(&shown.buttons, Some("Copy details")), Choice::Copy);
        assert_eq!(choice(&shown.buttons, Some("Quit")), Choice::Quit);
        assert_eq!(choice(&shown.buttons, None), Choice::Quit);
        assert_eq!(choice(&shown.buttons, Some("Send report")), Choice::Quit);
    }
}
