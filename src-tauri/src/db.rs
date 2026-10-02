use rusqlite::{params_from_iter, types::ValueRef, Connection};
use serde_json::{Map, Value};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};
use tauri::State;

pub struct Db(pub Mutex<Connection>);

/// Every statement is `create ... if not exists`, so this doubles as the (idempotent) migration:
/// opening an older database just adds the missing tables.
const SCHEMA: &str = "
pragma foreign_keys = on;
pragma journal_mode = wal;
create table if not exists projects(
  id integer primary key, name text not null, path text, source_id text unique,
  pinned integer not null default 0, created_at integer not null);
create table if not exists chats(
  id integer primary key, project_id integer references projects(id) on delete cascade,
  title text not null, source_id text unique, archived integer not null default 0,
  created_at integer not null, updated_at integer not null);
create table if not exists messages(
  id integer primary key, chat_id integer not null references chats(id) on delete cascade,
  role text not null, content text not null, created_at integer not null);
create index if not exists messages_chat on messages(chat_id, id);
create table if not exists settings(key text primary key, value text not null);
create table if not exists models_seen(
  provider text not null, model text not null, first_seen integer not null,
  primary key(provider, model));
-- Composer drafts (src/lib/chatSessions.ts). scope is 'chat:<id>' for an existing chat or 'new:<projectId or empty>'
-- for a chat that is not created yet; chat_id/project_id exist only so deleting the owner removes the draft.
create table if not exists drafts(
  scope text primary key,
  chat_id integer references chats(id) on delete cascade,
  project_id integer references projects(id) on delete cascade,
  text text not null default '',
  attachments_json text not null default '[]',
  updated_at integer not null);
";

fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    init(&conn)?;
    Ok(conn)
}

/// A panic while the lock was held poisons the mutex, but the SQLite connection itself is still valid
/// (each command is a single statement), so recover the guard instead of failing every later command.
fn lock(db: &Db) -> MutexGuard<'_, Connection> {
    db.0.lock().unwrap_or_else(|poisoned| {
        db.0.clear_poison();
        poisoned.into_inner()
    })
}

fn to_sql(v: Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as V;
    match v {
        Value::Null => V::Null,
        Value::Bool(b) => V::Integer(b as i64),
        Value::Number(n) => n.as_i64().map(V::Integer).unwrap_or_else(|| V::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => V::Text(s),
        other => V::Text(other.to_string()),
    }
}

// ponytail: the webview is our own trusted code, so it gets a thin SQL bridge instead of one command per query.
#[tauri::command]
pub fn db_select(db: State<Db>, sql: String, params: Vec<Value>) -> Result<Vec<Map<String, Value>>, String> {
    select(&lock(&db), &sql, params)
}

#[tauri::command]
pub fn db_execute(db: State<Db>, sql: String, params: Vec<Value>) -> Result<(usize, i64), String> {
    execute(&lock(&db), &sql, params)
}

fn select(conn: &Connection, sql: &str, params: Vec<Value>) -> Result<Vec<Map<String, Value>>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let cols: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt
        .query_map(params_from_iter(params.into_iter().map(to_sql)), |row| {
            let mut m = Map::new();
            for (i, c) in cols.iter().enumerate() {
                let v = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => n.into(),
                    ValueRef::Real(f) => f.into(),
                    ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned().into(),
                    ValueRef::Blob(_) => Value::Null,
                };
                m.insert(c.clone(), v);
            }
            Ok(m)
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

fn execute(conn: &Connection, sql: &str, params: Vec<Value>) -> Result<(usize, i64), String> {
    let n = conn
        .execute(sql, params_from_iter(params.into_iter().map(to_sql)))
        .map_err(|e| e.to_string())?;
    Ok((n, conn.last_insert_rowid()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    // Same statements as src/lib/data.ts (loadDraft / writeDraft).
    const UPSERT: &str = "insert into drafts(scope, chat_id, project_id, text, attachments_json, updated_at) values(?, ?, ?, ?, ?, ?) \
        on conflict(scope) do update set text = excluded.text, attachments_json = excluded.attachments_json, updated_at = excluded.updated_at";
    const UPSERT_TEXT_ONLY: &str = "insert into drafts(scope, chat_id, project_id, text, updated_at) values(?, ?, ?, ?, ?) \
        on conflict(scope) do update set text = excluded.text, updated_at = excluded.updated_at";

    fn memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        conn.execute_batch("pragma foreign_keys = on;").unwrap();
        conn
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        let rows = select(conn, &format!("select count(*) as n from {table}"), vec![]).unwrap();
        rows[0]["n"].as_i64().unwrap()
    }

    fn new_chat(conn: &Connection) -> i64 {
        execute(conn, "insert into chats(title, created_at, updated_at) values('t', 1, 1)", vec![]).unwrap().1
    }

    #[test]
    fn schema_is_idempotent_and_migrates_an_old_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.db");
        let conn = open(&path).unwrap();
        let chat = new_chat(&conn);
        execute(&conn, "insert into messages(chat_id, role, content, created_at) values(?, 'user', '{}', 1)", vec![json!(chat)]).unwrap();
        // Simulate a database created before the drafts table existed.
        conn.execute_batch("drop table drafts").unwrap();
        drop(conn);

        let conn = open(&path).unwrap();
        assert_eq!(count(&conn, "drafts"), 0);
        assert_eq!(count(&conn, "messages"), 1, "existing data survives the migration");
        init(&conn).unwrap();
        init(&conn).unwrap();
        execute(&conn, UPSERT, vec![json!("new:"), Value::Null, Value::Null, json!("hi"), json!("[]"), json!(1)]).unwrap();
        drop(conn);

        let conn = open(&path).unwrap();
        assert_eq!(count(&conn, "drafts"), 1, "re-opening keeps drafts");
    }

    #[test]
    fn draft_crud_roundtrip() {
        let conn = memory();
        let chat = new_chat(&conn);
        let scope = json!(format!("chat:{chat}"));
        let attachments = json!(r#"[{"type":"image","data":"AAAA"}]"#);

        execute(&conn, UPSERT, vec![scope.clone(), json!(chat), Value::Null, json!("first"), attachments.clone(), json!(1)]).unwrap();
        execute(&conn, UPSERT, vec![scope.clone(), json!(chat), Value::Null, json!("second"), attachments.clone(), json!(2)]).unwrap();
        assert_eq!(count(&conn, "drafts"), 1, "upsert replaces instead of duplicating");

        // A text-only update keeps the stored attachments.
        execute(&conn, UPSERT_TEXT_ONLY, vec![scope.clone(), json!(chat), Value::Null, json!("third"), json!(3)]).unwrap();
        let rows = select(&conn, "select text, attachments_json, updated_at from drafts where scope = ?", vec![scope.clone()]).unwrap();
        assert_eq!(rows[0]["text"], json!("third"));
        assert_eq!(rows[0]["attachments_json"], attachments);
        assert_eq!(rows[0]["updated_at"], json!(3));

        let (deleted, _) = execute(&conn, "delete from drafts where scope = ?", vec![scope.clone()]).unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(count(&conn, "drafts"), 0);

        // A text-only insert (no existing row) falls back to the empty attachment list.
        execute(&conn, UPSERT_TEXT_ONLY, vec![scope.clone(), json!(chat), Value::Null, json!("fresh"), json!(4)]).unwrap();
        let rows = select(&conn, "select attachments_json from drafts where scope = ?", vec![scope]).unwrap();
        assert_eq!(rows[0]["attachments_json"], json!("[]"));
    }

    #[test]
    fn deleting_the_owner_removes_its_drafts() {
        let conn = memory();
        let project = execute(&conn, "insert into projects(name, created_at) values('p', 1)", vec![]).unwrap().1;
        let chat = execute(&conn, "insert into chats(project_id, title, created_at, updated_at) values(?, 't', 1, 1)", vec![json!(project)]).unwrap().1;
        execute(&conn, UPSERT, vec![json!(format!("chat:{chat}")), json!(chat), Value::Null, json!("a"), json!("[]"), json!(1)]).unwrap();
        execute(&conn, UPSERT, vec![json!(format!("new:{project}")), Value::Null, json!(project), json!("b"), json!("[]"), json!(1)]).unwrap();
        execute(&conn, UPSERT, vec![json!("new:"), Value::Null, Value::Null, json!("c"), json!("[]"), json!(1)]).unwrap();
        assert_eq!(count(&conn, "drafts"), 3);

        // Removing the project cascades to its chats and both of their drafts; the project-less draft stays.
        execute(&conn, "delete from projects where id = ?", vec![json!(project)]).unwrap();
        let rows = select(&conn, "select scope from drafts", vec![]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["scope"], json!("new:"));
    }

    #[test]
    fn draft_for_a_missing_chat_is_rejected() {
        let conn = memory();
        let err = execute(&conn, UPSERT, vec![json!("chat:99"), json!(99), Value::Null, json!("x"), json!("[]"), json!(1)]);
        assert!(err.is_err());
        assert_eq!(count(&conn, "drafts"), 0);
    }

    #[test]
    fn poisoned_lock_does_not_brick_the_database() {
        let db = Db(Mutex::new(memory()));
        execute(&lock(&db), "insert into settings(key, value) values('k', 'v')", vec![]).unwrap();

        let panicked = catch_unwind(AssertUnwindSafe(|| {
            let _guard = db.0.lock().unwrap();
            panic!("simulated panic while holding the database lock");
        }));
        assert!(panicked.is_err());
        assert!(db.0.is_poisoned(), "precondition: the panic poisoned the mutex");

        let rows = select(&lock(&db), "select value from settings where key = 'k'", vec![]).unwrap();
        assert_eq!(rows[0]["value"], json!("v"));
        execute(&lock(&db), "insert into settings(key, value) values('k2', 'v2')", vec![]).unwrap();
        assert!(!db.0.is_poisoned(), "poison flag is cleared after recovery");
    }
}
