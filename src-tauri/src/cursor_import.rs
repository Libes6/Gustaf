use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CursorChat {
    pub id: String,
    pub title: String,
    pub project_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
}

#[derive(Serialize, Debug)]
pub struct CursorMessage {
    pub role: String,
    pub text: String,
}

/// Cursor keeps its state next to VS Code's: `~/Library/Application Support` (macOS), `%APPDATA%` (Windows),
/// `$XDG_CONFIG_HOME` or `~/.config` (Linux). `dirs::config_dir` resolves all three.
fn global_db_in(config_dir: &Path) -> PathBuf {
    config_dir.join("Cursor/User/globalStorage/state.vscdb")
}

fn global_db() -> PathBuf {
    let config = dirs::config_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config"));
    global_db_in(&config)
}

fn open_ro(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("Cursor database not available: {e}"))
}

pub fn scan(path: &Path) -> Result<Vec<CursorChat>, String> {
    let conn = open_ro(path)?;
    let mut stmt = conn
        .prepare(
            "select substr(key, 14), coalesce(json_extract(value, '$.name'), ''),
                    json_extract(value, '$.workspaceIdentifier.uri.fsPath'),
                    coalesce(json_extract(value, '$.createdAt'), 0),
                    coalesce(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.createdAt'), 0),
                    coalesce(json_array_length(value, '$.fullConversationHeadersOnly'), 0)
             from cursorDiskKV where key like 'composerData:%' and json_valid(value)",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CursorChat {
                id: r.get(0)?,
                title: r.get(1)?,
                project_path: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
                message_count: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut chats: Vec<CursorChat> = rows.filter_map(Result::ok).filter(|c| c.message_count > 0).collect();
    chats.sort_by_key(|c| -c.updated_at);
    Ok(chats)
}

pub fn messages(path: &Path, chat_id: &str) -> Result<Vec<CursorMessage>, String> {
    let conn = open_ro(path)?;
    let mut stmt = conn
        .prepare(
            "select json_extract(b.value, '$.type'), coalesce(json_extract(b.value, '$.text'), '')
             from json_each((select json_extract(value, '$.fullConversationHeadersOnly')
                             from cursorDiskKV where key = 'composerData:' || ?1)) h
             join cursorDiskKV b on b.key = 'bubbleId:' || ?1 || ':' || json_extract(h.value, '$.bubbleId')
             order by h.key",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([chat_id], |r| {
            let kind: i64 = r.get(0)?;
            Ok(CursorMessage { role: if kind == 1 { "user" } else { "assistant" }.into(), text: r.get(1)? })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).filter(|m| !m.text.trim().is_empty()).collect())
}

#[tauri::command]
pub async fn cursor_scan() -> Result<Vec<CursorChat>, String> {
    scan(&global_db())
}

#[tauri::command]
pub async fn cursor_messages(chat_id: String) -> Result<Vec<CursorMessage>, String> {
    messages(&global_db(), &chat_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn database_lives_under_the_config_dir() {
        let base = Path::new("cfg");
        assert_eq!(global_db_in(base), base.join("Cursor").join("User").join("globalStorage").join("state.vscdb"));
    }

    #[test]
    fn parses_cursor_layout() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let c = Connection::open(&path).unwrap();
        c.execute_batch(
            r#"create table cursorDiskKV(key text unique on conflict replace, value blob);
            insert into cursorDiskKV values('composerData:c1', '{"name":"Fix bug","createdAt":10,"lastUpdatedAt":20,
              "workspaceIdentifier":{"id":"w","uri":{"fsPath":"/tmp/proj"}},
              "fullConversationHeadersOnly":[{"bubbleId":"b1","type":1},{"bubbleId":"b2","type":2},{"bubbleId":"b3","type":2}]}');
            insert into cursorDiskKV values('composerData:empty', '{"name":"","fullConversationHeadersOnly":[]}');
            insert into cursorDiskKV values('bubbleId:c1:b1', '{"type":1,"text":"hi"}');
            insert into cursorDiskKV values('bubbleId:c1:b2', '{"type":2,"text":""}');
            insert into cursorDiskKV values('bubbleId:c1:b3', '{"type":2,"text":"hello"}');"#,
        )
        .unwrap();
        drop(c);

        let chats = scan(&path).unwrap();
        assert_eq!(chats.len(), 1);
        assert_eq!(chats[0].title, "Fix bug");
        assert_eq!(chats[0].project_path.as_deref(), Some("/tmp/proj"));
        assert_eq!(chats[0].updated_at, 20);

        let msgs = messages(&path, "c1").unwrap();
        let got: Vec<_> = msgs.iter().map(|m| (m.role.as_str(), m.text.as_str())).collect();
        assert_eq!(got, [("user", "hi"), ("assistant", "hello")]);
    }
}
