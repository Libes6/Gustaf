//! Reads the app database for the phone and shapes rows into the `@gustaf/protocol` types.
//!
//! Two SQLite connections of the server's own, both on the same `app.db` file the webview writes (WAL mode, so the
//! webview's writes never block these reads and these reads never block the webview):
//! * `ro` opens the file read-only (`SQLITE_OPEN_READ_ONLY` plus `query_only`): projects, chats and messages. Even a bug in
//!   this module cannot modify the user's conversations.
//! * `rw` is used for the `paired_devices` table only (insert on pairing, `last_seen_at`, revoke).
//!
//! Output limits (everything a phone can make the desktop send is bounded): at most `MAX_PROJECTS` projects,
//! `MAX_CHATS` chats, `MAX_MESSAGES` messages per request, `MAX_TEXT_CHARS` characters per message, `MAX_TOOLS` tool cards per
//! message and `MAX_SUMMARY_CHARS` per tool summary. Images are never sent and tool OUTPUT is not sent at all (the protocol
//! has only a one-line summary per tool call). Titles, text and summaries pass through `redact_secrets`.

use super::redact::redact_secrets;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Mutex, MutexGuard},
    time::Duration,
};

pub const MAX_PROJECTS: usize = 500;
pub const MAX_CHATS: usize = 500;
pub const DEFAULT_CHATS: usize = 200;
pub const MAX_MESSAGES: usize = 100;
pub const DEFAULT_MESSAGES: usize = 50;
pub const MAX_TEXT_CHARS: usize = 20_000;
/// Longer message text is cut before redaction runs (a pasted 10 MB log must not cost a full regex pass).
const PRE_REDACT_CHARS: usize = 100_000;
pub const MAX_TOOLS: usize = 50;
pub const MAX_SUMMARY_CHARS: usize = 160;
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_ACTIVE_DEVICES: usize = 16;

pub struct Store {
    ro: Mutex<Connection>,
    rw: Mutex<Connection>,
}

fn lock(m: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    m.lock().unwrap_or_else(|p| {
        m.clear_poison();
        p.into_inner()
    })
}

fn err(e: rusqlite::Error) -> String {
    format!("database: {e}")
}

// ---- Protocol shapes (camelCase JSON, `@gustaf/protocol`) --------------------------------------------------------------

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: i64,
    pub name: String,
    pub pinned: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub archived: bool,
    pub updated_at: i64,
    pub running: bool,
    /// `idle | running | waiting | done | failed`
    pub status: &'static str,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivity {
    pub id: String,
    pub tool: String,
    pub summary: String,
    /// `running | done | error | denied`
    pub status: &'static str,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: i64,
    pub chat_id: i64,
    pub role: &'static str,
    pub text: String,
    pub tools: Vec<ToolActivity>,
    pub created_at: i64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ChatRow {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub archived: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct RawMessage {
    pub id: i64,
    pub chat_id: i64,
    pub role: String,
    pub content: String,
    pub created_at: i64,
}

// ---- Store ------------------------------------------------------------------------------------------------------------

impl Store {
    /// The database must already exist with the app's schema (`db::open` ran at startup).
    pub fn open(path: &Path) -> Result<Store, String> {
        let ro = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(err)?;
        ro.busy_timeout(Duration::from_secs(3)).map_err(err)?;
        ro.execute_batch("pragma query_only = on;").map_err(err)?;
        let rw = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(err)?;
        rw.busy_timeout(Duration::from_secs(3)).map_err(err)?;
        // Prove the schema is there now rather than on the first phone request.
        rw.query_row("select count(*) from paired_devices", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(err)?;
        Ok(Store {
            ro: Mutex::new(ro),
            rw: Mutex::new(rw),
        })
    }

    // -- devices (read-write connection) --

    pub fn insert_device(
        &self,
        id: &str,
        name: &str,
        token_hash: &str,
        now: i64,
    ) -> Result<(), String> {
        lock(&self.rw)
            .execute("insert into paired_devices(id, name, token_hash, created_at, last_seen_at, revoked_at) values(?, ?, ?, ?, ?, null)", params![id, name, token_hash, now, now])
            .map(|_| ())
            .map_err(err)
    }

    /// `(id, token_hash)` of every device that has not been revoked.
    pub fn active_devices(&self) -> Result<Vec<(String, String)>, String> {
        let conn = lock(&self.rw);
        let mut stmt = conn
            .prepare("select id, token_hash from paired_devices where revoked_at is null")
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn list_devices(&self) -> Result<Vec<Device>, String> {
        let conn = lock(&self.rw);
        let mut stmt = conn
            .prepare("select id, name, created_at, last_seen_at from paired_devices where revoked_at is null order by created_at desc, rowid desc")
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Device {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    created_at: r.get(2)?,
                    last_seen_at: r.get(3)?,
                })
            })
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn device_active(&self, id: &str) -> Result<bool, String> {
        lock(&self.rw)
            .query_row(
                "select 1 from paired_devices where id = ? and revoked_at is null",
                [id],
                |_| Ok(()),
            )
            .optional()
            .map(|r| r.is_some())
            .map_err(err)
    }

    pub fn touch_device(&self, id: &str, now: i64) -> Result<(), String> {
        lock(&self.rw)
            .execute(
                "update paired_devices set last_seen_at = ? where id = ? and revoked_at is null",
                params![now, id],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// `true` when a live device was revoked.
    pub fn revoke_device(&self, id: &str, now: i64) -> Result<bool, String> {
        lock(&self.rw)
            .execute(
                "update paired_devices set revoked_at = ? where id = ? and revoked_at is null",
                params![now, id],
            )
            .map(|n| n > 0)
            .map_err(err)
    }

    // -- chat data (read-only connection) --

    pub fn projects(&self) -> Result<Vec<ProjectSummary>, String> {
        let conn = lock(&self.ro);
        let mut stmt = conn.prepare("select id, name, pinned from projects order by pinned desc, created_at desc, id desc limit ?").map_err(err)?;
        let rows = stmt
            .query_map([MAX_PROJECTS as i64], |r| {
                Ok(ProjectSummary {
                    id: r.get(0)?,
                    name: shape_title(&r.get::<_, String>(1)?),
                    pinned: r.get::<_, i64>(2)? != 0,
                })
            })
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    /// Chats that belong to a project (the phone lists chats per project), newest first. Archived chats only on request.
    pub fn chats(
        &self,
        project: Option<i64>,
        include_archived: bool,
        limit: usize,
    ) -> Result<Vec<ChatRow>, String> {
        let conn = lock(&self.ro);
        let mut stmt = conn
            .prepare(
                "select id, project_id, title, archived, updated_at from chats \
                 where project_id is not null and (?1 is null or project_id = ?1) and (?2 = 1 or archived = 0) \
                 order by updated_at desc, id desc limit ?3",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(
                params![
                    project,
                    include_archived as i64,
                    limit.min(MAX_CHATS) as i64
                ],
                chat_row,
            )
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    /// Every chat with a project, for the change detector (bounded).
    pub fn all_chats(&self) -> Result<Vec<ChatRow>, String> {
        let conn = lock(&self.ro);
        let mut stmt = conn.prepare("select id, project_id, title, archived, updated_at from chats where project_id is not null order by id desc limit 5000").map_err(err)?;
        let rows = stmt.query_map([], chat_row).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }

    pub fn chat_exists(&self, id: i64) -> Result<bool, String> {
        lock(&self.ro)
            .query_row("select 1 from chats where id = ?", [id], |_| Ok(()))
            .optional()
            .map(|r| r.is_some())
            .map_err(err)
    }

    /// Up to `limit` messages older than `before` (all when `None`), newest page first, returned oldest first.
    pub fn messages(
        &self,
        chat_id: i64,
        limit: usize,
        before: Option<i64>,
    ) -> Result<Vec<RawMessage>, String> {
        let conn = lock(&self.ro);
        let mut stmt = conn
            .prepare("select id, chat_id, role, content, created_at from messages where chat_id = ?1 and (?2 is null or id < ?2) order by id desc limit ?3")
            .map_err(err)?;
        let rows = stmt
            .query_map(
                params![chat_id, before, limit.min(MAX_MESSAGES) as i64],
                message_row,
            )
            .map_err(err)?;
        let mut out: Vec<RawMessage> = rows.collect::<Result<_, _>>().map_err(err)?;
        out.reverse();
        Ok(out)
    }

    pub fn max_message_id(&self) -> Result<i64, String> {
        lock(&self.ro)
            .query_row("select coalesce(max(id), 0) from messages", [], |r| {
                r.get(0)
            })
            .map_err(err)
    }

    pub fn messages_after(&self, id: i64, limit: usize) -> Result<Vec<RawMessage>, String> {
        let conn = lock(&self.ro);
        let mut stmt = conn.prepare("select id, chat_id, role, content, created_at from messages where id > ? order by id limit ?").map_err(err)?;
        let rows = stmt
            .query_map(params![id, limit as i64], message_row)
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
    }
}

fn chat_row(r: &rusqlite::Row) -> rusqlite::Result<ChatRow> {
    Ok(ChatRow {
        id: r.get(0)?,
        project_id: r.get(1)?,
        title: r.get(2)?,
        archived: r.get::<_, i64>(3)? != 0,
        updated_at: r.get(4)?,
    })
}

fn message_row(r: &rusqlite::Row) -> rusqlite::Result<RawMessage> {
    Ok(RawMessage {
        id: r.get(0)?,
        chat_id: r.get(1)?,
        role: r.get(2)?,
        content: r.get(3)?,
        created_at: r.get(4)?,
    })
}

// ---- Shaping ----------------------------------------------------------------------------------------------------------

/// First `max` characters (never splits a character), with an ellipsis when something was cut.
pub fn clip_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn shape_title(raw: &str) -> String {
    clip_chars(
        &one_line(&redact_secrets(&clip_chars(raw, MAX_TITLE_CHARS * 4))),
        MAX_TITLE_CHARS,
    )
}

pub fn chat_summary(row: &ChatRow, status: Option<&str>) -> ChatSummary {
    let status: &'static str = match status {
        Some("running") => "running",
        Some("waiting") => "waiting",
        Some("failed") => "failed",
        Some("done") => "done",
        _ => "idle",
    };
    ChatSummary {
        id: row.id,
        project_id: row.project_id,
        title: shape_title(&row.title),
        archived: row.archived,
        updated_at: row.updated_at,
        running: matches!(status, "running" | "waiting"),
        status,
    }
}

/// What the chat view shows of a stored user message (see `userText` in `ChatView.tsx`): system notifications are not
/// messages, `<user_query>` unwraps imported Cursor turns and the `<file path=...>` blocks appended for `@file`
/// mentions (whole file contents) are cut.
fn user_text(raw: &str) -> Option<String> {
    if raw.contains("<system_notification>") {
        return None;
    }
    if let (Some(a), Some(b)) = (raw.find("<user_query>"), raw.find("</user_query>")) {
        if b > a {
            return Some(raw[a + 12..b].trim().to_string());
        }
    }
    let cut = raw
        .find("\n\n<file path=\"")
        .map(|i| &raw[..i])
        .unwrap_or(raw);
    Some(cut.trim().to_string())
}

fn summarize_args(name: &str, args: &Value) -> String {
    const KEYS: [&str; 10] = [
        "path",
        "file_path",
        "filePath",
        "command",
        "cmd",
        "url",
        "query",
        "pattern",
        "description",
        "title",
    ];
    let text = args
        .as_object()
        .and_then(|o| KEYS.iter().find_map(|k| o.get(*k).and_then(Value::as_str)))
        .unwrap_or("");
    let line = one_line(&redact_secrets(&clip_chars(text, MAX_SUMMARY_CHARS * 4)));
    if line.is_empty() {
        clip_chars(name, MAX_SUMMARY_CHARS)
    } else {
        clip_chars(&line, MAX_SUMMARY_CHARS)
    }
}

/// `tool_call id -> is_error` from the `tool` messages of a page, so the phone sees a failed call as failed.
pub fn tool_results(rows: &[RawMessage]) -> HashMap<String, bool> {
    let mut out = HashMap::new();
    for row in rows.iter().filter(|r| r.role == "tool") {
        let Ok(doc) = serde_json::from_str::<Value>(&row.content) else {
            continue;
        };
        for part in doc
            .get("parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if part.get("type").and_then(Value::as_str) == Some("tool_result") {
                if let Some(id) = part.get("id").and_then(Value::as_str) {
                    out.insert(
                        id.to_string(),
                        part.get("isError")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    );
                }
            }
        }
    }
    out
}

/// One stored message as the protocol type, or `None` when it is not something a phone shows (tool results, compaction
/// summaries, system notifications, malformed rows, nothing readable left).
pub fn shape_message(row: &RawMessage, results: &HashMap<String, bool>) -> Option<ChatMessage> {
    let role = match row.role.as_str() {
        "user" => "user",
        "assistant" => "assistant",
        _ => return None,
    };
    let doc: Value = serde_json::from_str(&row.content).ok()?;
    if doc
        .pointer("/meta/compacted")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let mut texts: Vec<&str> = Vec::new();
    let mut images = 0usize;
    let mut tools: Vec<ToolActivity> = Vec::new();
    for part in doc.get("parts").and_then(Value::as_array)? {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => texts.extend(part.get("text").and_then(Value::as_str)),
            Some("image") => images += 1,
            Some("activity") if tools.len() < MAX_TOOLS => {
                let (Some(id), Some(name)) = (
                    part.get("id").and_then(Value::as_str),
                    part.get("name").and_then(Value::as_str),
                ) else {
                    continue;
                };
                let status = match part.get("status").and_then(Value::as_str) {
                    Some("running") => "running",
                    Some("error") => "error",
                    _ => "done",
                };
                tools.push(ToolActivity {
                    id: clip_chars(id, 100),
                    tool: clip_chars(name, 100),
                    summary: summarize_args(name, part.get("args").unwrap_or(&Value::Null)),
                    status,
                });
            }
            Some("tool_call") if tools.len() < MAX_TOOLS => {
                let (Some(id), Some(name)) = (
                    part.get("id").and_then(Value::as_str),
                    part.get("name").and_then(Value::as_str),
                ) else {
                    continue;
                };
                let status = if results.get(id).copied().unwrap_or(false) {
                    "error"
                } else {
                    "done"
                };
                tools.push(ToolActivity {
                    id: clip_chars(id, 100),
                    tool: clip_chars(name, 100),
                    summary: summarize_args(name, part.get("args").unwrap_or(&Value::Null)),
                    status,
                });
            }
            _ => {}
        }
    }
    let joined = texts.join("\n\n");
    let mut text = if role == "user" {
        user_text(&clip_chars(&joined, PRE_REDACT_CHARS))?
    } else {
        clip_chars(joined.trim(), PRE_REDACT_CHARS)
    };
    text = clip_chars(&redact_secrets(&text), MAX_TEXT_CHARS);
    for _ in 0..images.min(3) {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str("[image omitted]");
    }
    if text.is_empty() && tools.is_empty() {
        return None;
    }
    Some(ChatMessage {
        id: row.id,
        chat_id: row.chat_id,
        role,
        text,
        tools,
        created_at: row.created_at,
    })
}

pub fn shape_messages(rows: &[RawMessage]) -> Vec<ChatMessage> {
    let results = tool_results(rows);
    rows.iter()
        .filter_map(|r| shape_message(r, &results))
        .collect()
}

#[cfg(test)]
pub mod fixtures {
    use rusqlite::Connection;
    use serde_json::{json, Value};

    pub fn msg(conn: &Connection, chat: i64, role: &str, parts: Vec<Value>, meta: Value) -> i64 {
        conn.execute(
            "insert into messages(chat_id, role, content, created_at) values(?, ?, ?, ?)",
            rusqlite::params![
                chat,
                role,
                json!({ "role": role, "parts": parts, "meta": meta }).to_string(),
                1_700_000_000_000i64
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    pub fn text(t: &str) -> Value {
        json!({ "type": "text", "text": t })
    }

    /// Project 1 "Alpha" (pinned) with chats 1 (two messages) and 2 (archived), project 2 "Beta" with chat 3, and chat 4
    /// without a project.
    pub fn seed(conn: &Connection) {
        conn.execute_batch(
            "insert into projects(id, name, path, pinned, created_at) values (1, 'Alpha', '/secret/path/alpha', 1, 10), (2, 'Beta', null, 0, 20);
             insert into chats(id, project_id, title, archived, created_at, updated_at) values
               (1, 1, 'First chat', 0, 1, 100), (2, 1, 'Old chat', 1, 1, 50), (3, 2, 'Beta chat', 0, 1, 200), (4, null, 'No project', 0, 1, 300);",
        )
        .unwrap();
        msg(conn, 1, "user", vec![text("hello there")], json!({}));
        msg(
            conn,
            1,
            "assistant",
            vec![text("hi!")],
            json!({ "provider": "p", "model": "m" }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;
    use serde_json::json;

    fn raw(role: &str, doc: Value) -> RawMessage {
        RawMessage {
            id: 7,
            chat_id: 1,
            role: role.to_string(),
            content: doc.to_string(),
            created_at: 5,
        }
    }

    fn shaped(role: &str, parts: Vec<Value>) -> Option<ChatMessage> {
        shape_message(
            &raw(role, json!({ "role": role, "parts": parts })),
            &HashMap::new(),
        )
    }

    #[test]
    fn clipping_is_character_safe() {
        assert_eq!(clip_chars("abcdef", 3), "abc…");
        assert_eq!(clip_chars("abc", 3), "abc");
        assert_eq!(clip_chars("ёёёёё", 2), "ёё…");
        assert_eq!(clip_chars("", 0), "");
    }

    #[test]
    fn plain_messages_become_protocol_messages() {
        let m = shaped("user", vec![text("hello")]).unwrap();
        assert_eq!(
            m,
            ChatMessage {
                id: 7,
                chat_id: 1,
                role: "user",
                text: "hello".into(),
                tools: vec![],
                created_at: 5
            }
        );
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(
            json,
            json!({ "id": 7, "chatId": 1, "role": "user", "text": "hello", "tools": [], "createdAt": 5 })
        );
    }

    #[test]
    fn secrets_are_redacted_and_long_text_is_clipped() {
        let m = shaped(
            "assistant",
            vec![text(
                "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 now",
            )],
        )
        .unwrap();
        assert_eq!(m.text, "use [REDACTED] now");
        let long = "x".repeat(MAX_TEXT_CHARS * 3);
        let m = shaped("assistant", vec![text(&long)]).unwrap();
        assert_eq!(m.text.chars().count(), MAX_TEXT_CHARS + 1);
        assert!(m.text.ends_with('…'));
        // A secret that sits past the pre-redaction cut is simply gone, never half-shown.
        let m = shaped(
            "assistant",
            vec![text(&format!(
                "{}sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
                "y".repeat(PRE_REDACT_CHARS - 5)
            ))],
        )
        .unwrap();
        assert!(!m.text.contains("sk-ant"));
    }

    #[test]
    fn tool_calls_and_activities_become_one_line_cards() {
        let parts = vec![
            text("looking"),
            json!({ "type": "tool_call", "id": "c1", "name": "fs_read", "args": { "path": "src/main.rs" } }),
            json!({ "type": "tool_call", "id": "c2", "name": "run_command", "args": { "command": "cat .env\nexport API_KEY=abcdef123456" } }),
            json!({ "type": "activity", "id": "a1", "name": "Edit", "args": { "file_path": "a.ts" }, "status": "running", "output": "OUTPUT-NEVER-SENT" }),
            json!({ "type": "activity", "id": "a2", "name": "Bash", "args": {}, "status": "error", "output": "boom" }),
        ];
        let results = HashMap::from([("c2".to_string(), true), ("c1".to_string(), false)]);
        let m = shape_message(
            &raw("assistant", json!({ "role": "assistant", "parts": parts })),
            &results,
        )
        .unwrap();
        let tools: Vec<_> = m
            .tools
            .iter()
            .map(|t| (t.id.as_str(), t.tool.as_str(), t.summary.as_str(), t.status))
            .collect();
        assert_eq!(
            tools,
            vec![
                ("c1", "fs_read", "src/main.rs", "done"),
                (
                    "c2",
                    "run_command",
                    "cat .env export API_KEY=[REDACTED]",
                    "error"
                ),
                ("a1", "Edit", "a.ts", "running"),
                ("a2", "Bash", "Bash", "error"),
            ]
        );
        assert!(!serde_json::to_string(&m)
            .unwrap()
            .contains("OUTPUT-NEVER-SENT"));
    }

    #[test]
    fn tool_cards_and_summaries_are_bounded() {
        let parts: Vec<Value> = (0..200).map(|i| json!({ "type": "tool_call", "id": format!("c{i}"), "name": "x", "args": { "command": "z".repeat(5000) } })).collect();
        let m = shaped("assistant", parts).unwrap();
        assert_eq!(m.tools.len(), MAX_TOOLS);
        assert!(m
            .tools
            .iter()
            .all(|t| t.summary.chars().count() <= MAX_SUMMARY_CHARS + 1));
    }

    #[test]
    fn images_are_never_sent() {
        let m = shaped(
            "user",
            vec![
                text("look"),
                json!({ "type": "image", "data": "BASE64SECRETDATA" }),
            ],
        )
        .unwrap();
        assert_eq!(m.text, "look\n[image omitted]");
        assert!(!serde_json::to_string(&m)
            .unwrap()
            .contains("BASE64SECRETDATA"));
        let only = shaped("user", vec![json!({ "type": "image", "data": "AAAA" })]).unwrap();
        assert_eq!(only.text, "[image omitted]");
    }

    #[test]
    fn harness_wrappers_and_non_chat_rows_are_hidden() {
        assert_eq!(
            shaped(
                "user",
                vec![text("fix it\n\n<file path=\"a.ts\">\nBODY\n</file>")]
            )
            .unwrap()
            .text,
            "fix it"
        );
        assert_eq!(
            shaped(
                "user",
                vec![text(
                    "<timestamp>x</timestamp>\n<user_query>\nbuild it\n</user_query>"
                )]
            )
            .unwrap()
            .text,
            "build it"
        );
        assert!(shaped(
            "user",
            vec![text("<system_notification>done</system_notification>")]
        )
        .is_none());
        assert!(shaped(
            "tool",
            vec![json!({ "type": "tool_result", "id": "1", "name": "x", "output": "O" })]
        )
        .is_none());
        assert!(shaped("assistant", vec![text("  \n ")]).is_none());
        let summary = raw(
            "user",
            json!({ "role": "user", "parts": [{ "type": "text", "text": "SUMMARY" }], "meta": { "compacted": true } }),
        );
        assert!(shape_message(&summary, &HashMap::new()).is_none());
        let bad = RawMessage {
            id: 1,
            chat_id: 1,
            role: "user".into(),
            content: "not json".into(),
            created_at: 1,
        };
        assert!(shape_message(&bad, &HashMap::new()).is_none());
        let no_parts = raw("user", json!({ "role": "user" }));
        assert!(shape_message(&no_parts, &HashMap::new()).is_none());
    }

    #[test]
    fn tool_results_mark_failed_calls_across_a_page() {
        let rows = vec![
            raw(
                "assistant",
                json!({ "role": "assistant", "parts": [{ "type": "tool_call", "id": "c1", "name": "x", "args": {} }] }),
            ),
            raw(
                "tool",
                json!({ "role": "tool", "parts": [{ "type": "tool_result", "id": "c1", "name": "x", "output": "bad", "isError": true }] }),
            ),
        ];
        let shaped = shape_messages(&rows);
        assert_eq!(shaped.len(), 1);
        assert_eq!(shaped[0].tools[0].status, "error");
    }

    #[test]
    fn chat_summaries_map_the_run_status() {
        let row = ChatRow {
            id: 1,
            project_id: 2,
            title: "A\nsk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789".into(),
            archived: false,
            updated_at: 9,
        };
        let s = chat_summary(&row, Some("waiting"));
        assert_eq!((s.status, s.running), ("waiting", true));
        assert_eq!(s.title, "A [REDACTED]");
        assert_eq!(chat_summary(&row, Some("running")).running, true);
        assert_eq!(
            (
                chat_summary(&row, Some("done")).status,
                chat_summary(&row, Some("done")).running
            ),
            ("done", false)
        );
        assert_eq!(chat_summary(&row, Some("bogus")).status, "idle");
        assert_eq!(chat_summary(&row, None).status, "idle");
        assert_eq!(
            serde_json::to_value(chat_summary(&row, None)).unwrap(),
            json!({ "id": 1, "projectId": 2, "title": "A [REDACTED]", "archived": false, "updatedAt": 9, "running": false, "status": "idle" })
        );
    }

    fn store() -> (tempfile::TempDir, Store, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.db");
        let conn = crate::db::open(&path).unwrap();
        seed(&conn);
        let store = Store::open(&path).unwrap();
        (dir, store, conn)
    }

    #[test]
    fn the_store_lists_projects_and_chats_without_paths_or_projectless_chats() {
        let (_d, store, _c) = store();
        let projects = store.projects().unwrap();
        assert_eq!(
            projects,
            vec![
                ProjectSummary {
                    id: 1,
                    name: "Alpha".into(),
                    pinned: true
                },
                ProjectSummary {
                    id: 2,
                    name: "Beta".into(),
                    pinned: false
                }
            ]
        );
        assert!(!serde_json::to_string(&projects).unwrap().contains("secret"));
        let ids = |rows: Vec<ChatRow>| rows.iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(
            ids(store.chats(None, false, 100).unwrap()),
            vec![3, 1],
            "newest first; archived and project-less chats left out"
        );
        assert_eq!(ids(store.chats(None, true, 100).unwrap()), vec![3, 1, 2]);
        assert_eq!(ids(store.chats(Some(1), false, 100).unwrap()), vec![1]);
        assert_eq!(
            ids(store.chats(Some(99), false, 100).unwrap()),
            Vec::<i64>::new()
        );
        assert_eq!(ids(store.chats(None, true, 1).unwrap()), vec![3]);
    }

    #[test]
    fn messages_page_backwards_in_order() {
        let (_d, store, conn) = store();
        for i in 0..10 {
            msg(
                &conn,
                3,
                if i % 2 == 0 { "user" } else { "assistant" },
                vec![text(&format!("m{i}"))],
                json!({}),
            );
        }
        let page = store.messages(3, 4, None).unwrap();
        let texts = |rows: &[RawMessage]| {
            shape_messages(rows)
                .iter()
                .map(|m| m.text.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            texts(&page),
            vec!["m6", "m7", "m8", "m9"],
            "the newest page, oldest first"
        );
        let older = store.messages(3, 4, Some(page[0].id)).unwrap();
        assert_eq!(texts(&older), vec!["m2", "m3", "m4", "m5"]);
        let oldest = store.messages(3, 4, Some(older[0].id)).unwrap();
        assert_eq!(texts(&oldest), vec!["m0", "m1"]);
        assert!(store.messages(3, 4, Some(oldest[0].id)).unwrap().is_empty());
        assert_eq!(store.messages(3, 100_000, None).unwrap().len(), 10);
        assert!(store.chat_exists(3).unwrap() && !store.chat_exists(99).unwrap());
    }

    #[test]
    fn the_read_connection_cannot_write() {
        let (_d, store, _c) = store();
        let ro = lock(&store.ro);
        assert!(ro.execute("update chats set title = 'x'", []).is_err());
        assert!(ro
            .execute("insert into projects(name, created_at) values('x', 1)", [])
            .is_err());
    }

    #[test]
    fn devices_are_stored_hashed_and_revocation_is_immediate() {
        let (_d, store, _c) = store();
        store.insert_device("d1", "Pixel", "hash1", 100).unwrap();
        store.insert_device("d2", "iPhone", "hash2", 200).unwrap();
        assert_eq!(store.active_devices().unwrap().len(), 2);
        assert_eq!(
            store
                .list_devices()
                .unwrap()
                .iter()
                .map(|d| d.id.as_str())
                .collect::<Vec<_>>(),
            vec!["d2", "d1"]
        );
        store.touch_device("d1", 555).unwrap();
        assert_eq!(store.list_devices().unwrap()[1].last_seen_at, Some(555));
        assert!(store.device_active("d1").unwrap());
        assert!(store.revoke_device("d1", 600).unwrap());
        assert!(!store.revoke_device("d1", 601).unwrap(), "already revoked");
        assert!(!store.device_active("d1").unwrap());
        assert_eq!(
            store.active_devices().unwrap(),
            vec![("d2".to_string(), "hash2".to_string())]
        );
        assert_eq!(store.list_devices().unwrap().len(), 1);
        store.touch_device("d1", 999).unwrap();
        assert!(
            store.insert_device("d3", "x", "hash2", 1).is_err(),
            "a token hash is unique"
        );
    }
}
