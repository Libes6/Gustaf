//! What the WebSocket pushes: new messages, chat list changes and run status changes.
//!
//! Two sources feed it, both read-only from the server's point of view:
//! * the database (new `messages` rows, changed `chats` rows) is polled while at least one phone is connected, with the
//!   server's own read-only connection (see `data.rs`). Polling a few small indexed queries once a second is cheap and
//!   needs no hook in the code that writes (the webview, imports, scheduled runs and older app versions all write).
//! * run status (`running` / `waiting` / `failed` / `done`) exists only in the webview (session `busy` flags, open
//!   approvals, the unread/failed flags of `lib/chatStatus.ts`), so the webview REPORTS it with the `mobile_report_status`
//!   command (`lib/mobileBridge.ts`, on every change). The board below keeps the latest report; the detector turns changes
//!   of it into events. With the webview not running nothing is reported and every chat reads as `idle`.

use super::data::{chat_summary, shape_message, tool_results, ChatSummary, Store};
use serde_json::json;
use std::{collections::HashMap, sync::Mutex};

/// A report holds at most this many chats.
pub const MAX_STATUS_ENTRIES: usize = 5000;

#[derive(Default)]
pub struct StatusBoard {
    map: Mutex<HashMap<i64, &'static str>>,
}

fn known(status: &str) -> Option<&'static str> {
    match status {
        "running" => Some("running"),
        "waiting" => Some("waiting"),
        "failed" => Some("failed"),
        "done" => Some("done"),
        _ => None,
    }
}

impl StatusBoard {
    /// Replaces the whole picture; unknown statuses and anything past the bound are dropped. `true` when it changed.
    pub fn replace(&self, items: impl IntoIterator<Item = (i64, String)>) -> bool {
        let next: HashMap<i64, &'static str> = items.into_iter().filter_map(|(id, s)| known(&s).map(|s| (id, s))).take(MAX_STATUS_ENTRIES).collect();
        let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        let changed = *map != next;
        *map = next;
        changed
    }

    pub fn get(&self, chat_id: i64) -> Option<&'static str> {
        self.map.lock().unwrap_or_else(|p| p.into_inner()).get(&chat_id).copied()
    }
}

pub fn hello(protocol: u32) -> String {
    json!({ "type": "hello", "protocol": protocol }).to_string()
}

/// Remembers what the phones were last told and produces the frames for what changed since.
pub struct Detector {
    chats: HashMap<i64, ChatSummary>,
    last_message: i64,
}

impl Detector {
    /// Starts from the current state: nothing is announced for what already exists.
    pub fn baseline(store: &Store, board: &StatusBoard) -> Result<Detector, String> {
        let chats = store.all_chats()?.iter().map(|r| (r.id, chat_summary(r, board.get(r.id)))).collect();
        Ok(Detector { chats, last_message: store.max_message_id()? })
    }

    /// JSON frames (`ServerEvent`) for everything that changed since the last call.
    pub fn poll(&mut self, store: &Store, board: &StatusBoard) -> Result<Vec<String>, String> {
        let mut frames = Vec::new();
        for _ in 0..5 {
            let rows = store.messages_after(self.last_message, 200)?;
            let Some(last) = rows.last().map(|r| r.id) else { break };
            let results = tool_results(&rows);
            for row in &rows {
                if let Some(message) = shape_message(row, &results) {
                    frames.push(json!({ "type": "message.created", "message": message }).to_string());
                }
            }
            self.last_message = last;
            if rows.len() < 200 {
                break;
            }
        }
        let mut seen = HashMap::new();
        for row in store.all_chats()? {
            let now = chat_summary(&row, board.get(row.id));
            if let Some(before) = self.chats.get(&row.id) {
                if *before == now {
                    seen.insert(row.id, now);
                    continue;
                }
                if before.running && !now.running {
                    let outcome = if now.status == "failed" { "error" } else { "done" };
                    frames.push(json!({ "type": "chat.updated", "chat": now }).to_string());
                    frames.push(json!({ "type": "run.finished", "chatId": row.id, "outcome": outcome }).to_string());
                    seen.insert(row.id, now);
                    continue;
                }
            }
            frames.push(json!({ "type": "chat.updated", "chat": now }).to_string());
            seen.insert(row.id, now);
        }
        self.chats = seen;
        Ok(frames)
    }
}

#[cfg(test)]
mod tests {
    use super::super::data::fixtures::*;
    use super::*;
    use serde_json::Value;

    fn setup() -> (tempfile::TempDir, Store, rusqlite::Connection) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.db");
        let conn = crate::db::open(&path).unwrap();
        seed(&conn);
        let store = Store::open(&path).unwrap();
        (dir, store, conn)
    }

    fn parse(frames: &[String]) -> Vec<Value> {
        frames.iter().map(|f| serde_json::from_str(f).unwrap()).collect()
    }

    #[test]
    fn the_board_keeps_only_known_statuses_and_reports_changes() {
        let b = StatusBoard::default();
        assert!(b.replace([(1, "running".to_string()), (2, "nonsense".to_string()), (3, "done".to_string())]));
        assert_eq!((b.get(1), b.get(2), b.get(3)), (Some("running"), None, Some("done")));
        assert!(!b.replace([(1, "running".to_string()), (3, "done".to_string())]), "same picture, no change");
        assert!(b.replace([]));
        assert_eq!(b.get(1), None);
        let many = (0..(MAX_STATUS_ENTRIES as i64 + 50)).map(|i| (i, "done".to_string()));
        b.replace(many);
        assert_eq!(b.map.lock().unwrap().len(), MAX_STATUS_ENTRIES);
    }

    #[test]
    fn hello_carries_the_protocol_version() {
        assert_eq!(serde_json::from_str::<Value>(&hello(1)).unwrap(), json!({ "type": "hello", "protocol": 1 }));
    }

    #[test]
    fn nothing_is_announced_for_existing_data() {
        let (_d, store, _c) = setup();
        let board = StatusBoard::default();
        let mut det = Detector::baseline(&store, &board).unwrap();
        assert!(det.poll(&store, &board).unwrap().is_empty());
    }

    #[test]
    fn new_messages_and_chat_changes_are_announced_once() {
        let (_d, store, conn) = setup();
        let board = StatusBoard::default();
        let mut det = Detector::baseline(&store, &board).unwrap();
        let id = msg(&conn, 1, "assistant", vec![text("new reply")], json!({}));
        msg(&conn, 1, "tool", vec![json!({ "type": "tool_result", "id": "x", "name": "n", "output": "o" })], json!({}));
        conn.execute("update chats set updated_at = 999 where id = 1", []).unwrap();
        let events = parse(&det.poll(&store, &board).unwrap());
        assert_eq!(events.len(), 2, "tool results are not messages: {events:?}");
        assert_eq!(events[0]["type"], "message.created");
        assert_eq!(events[0]["message"]["id"], id);
        assert_eq!(events[0]["message"]["text"], "new reply");
        assert_eq!(events[1]["type"], "chat.updated");
        assert_eq!(events[1]["chat"]["updatedAt"], 999);
        assert!(det.poll(&store, &board).unwrap().is_empty(), "announced once");
        conn.execute("insert into chats(id, project_id, title, created_at, updated_at) values(10, 2, 'brand new', 1, 1000)", []).unwrap();
        let events = parse(&det.poll(&store, &board).unwrap());
        assert_eq!((events[0]["type"].as_str(), events[0]["chat"]["id"].as_i64()), (Some("chat.updated"), Some(10)));
    }

    #[test]
    fn secrets_in_pushed_messages_are_redacted() {
        let (_d, store, conn) = setup();
        let board = StatusBoard::default();
        let mut det = Detector::baseline(&store, &board).unwrap();
        msg(&conn, 1, "assistant", vec![text("token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789")], json!({}));
        let frames = det.poll(&store, &board).unwrap();
        assert!(!frames.concat().contains("sk-ant"));
    }

    #[test]
    fn status_changes_become_chat_updates_and_run_finished() {
        let (_d, store, _c) = setup();
        let board = StatusBoard::default();
        let mut det = Detector::baseline(&store, &board).unwrap();
        board.replace([(1, "running".to_string())]);
        let events = parse(&det.poll(&store, &board).unwrap());
        assert_eq!(events.len(), 1);
        assert_eq!((events[0]["chat"]["status"].as_str(), events[0]["chat"]["running"].as_bool()), (Some("running"), Some(true)));
        board.replace([(1, "waiting".to_string())]);
        let events = parse(&det.poll(&store, &board).unwrap());
        assert_eq!((events.len(), events[0]["chat"]["status"].as_str()), (1, Some("waiting")), "still running: no run.finished");
        board.replace([(1, "done".to_string())]);
        let events = parse(&det.poll(&store, &board).unwrap());
        assert_eq!(events.len(), 2);
        assert_eq!(events[1], json!({ "type": "run.finished", "chatId": 1, "outcome": "done" }));
        board.replace([(1, "running".to_string())]);
        det.poll(&store, &board).unwrap();
        board.replace([(1, "failed".to_string())]);
        let events = parse(&det.poll(&store, &board).unwrap());
        assert_eq!(events[1], json!({ "type": "run.finished", "chatId": 1, "outcome": "error" }));
    }
}
