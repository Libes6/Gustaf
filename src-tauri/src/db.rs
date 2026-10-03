use rusqlite::{params, params_from_iter, types::ValueRef, Connection, OptionalExtension};
use serde::Serialize;
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
-- agent-runs:begin
-- Subagent runs and their full transcripts (src/agent/agentRunsDb.ts). Replaces the bounded `agentRuns` setting, which is
-- migrated once by the app. `agent_messages.parts_json` holds one message of the subagent's own history (bounded per
-- message by the app); seq 0 is the task prompt. Deleting a chat removes the runs it started (trigger below).
create table if not exists agent_runs(
  id text primary key, chat_id integer, title text not null, type text not null, model text not null default '',
  status text not null, started_at integer not null default 0, ended_at integer, tokens integer not null default 0,
  tool_uses integer not null default 0, error text, report text,
  provider_id text not null default '', project_root text not null default '', created_at integer not null default 0,
  changed_json text, warnings_json text);
create index if not exists agent_runs_created on agent_runs(created_at);
create table if not exists agent_messages(
  run_id text not null references agent_runs(id) on delete cascade, seq integer not null,
  role text not null, parts_json text not null, created_at integer not null default 0,
  primary key(run_id, seq));
create trigger if not exists agent_runs_chat_deleted after delete on chats begin
  delete from agent_runs where chat_id = old.id;
end;
-- agent-runs:end
";

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)
}

#[cfg(test)]
fn init(conn: &Connection) -> rusqlite::Result<()> {
    init_schema(conn)?;
    init_search(conn)
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    init_schema(&conn)?;
    // The search index is derived data: if it cannot be built the app still starts (and retries on the next launch).
    if let Err(e) = init_search(&conn) {
        eprintln!("full-text search index unavailable: {e}");
    }
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

// ---------------------------------------------------------------------------------------------------------------------
// Full-text search over message text (SQLite FTS5; the bundled SQLite of rusqlite ships FTS5 and JSON functions).
//
// `messages_fts` is a regular (content-bearing) FTS5 table whose rowid is `messages.id`. It holds only the readable
// text of a message: the `text` parts of its JSON `content` (never images, tool calls, tool results or activities),
// minus the harness wrappers that the chat view also hides (see `text_sql`). AFTER INSERT/UPDATE/DELETE triggers keep
// it in sync, so every writer (the JS `db_execute` bridge, imports, cascading deletes, and older builds of the app
// that know nothing about search) maintains the index. The triggers use only built-in SQL functions, so they never
// break writes from a connection that lacks anything custom. Existing databases are backfilled by `init_search`.
// ---------------------------------------------------------------------------------------------------------------------

/// Bump when the extraction rules or the table definition change: the index is then rebuilt on the next start.
const SEARCH_VERSION: i64 = 1;
/// Row in `settings` that records which `SEARCH_VERSION` the index was built with.
const SEARCH_VERSION_KEY: &str = "searchIndexVersion";
/// Characters indexed per message; longer texts (pasted logs) are cut so one message cannot bloat the index.
const MAX_INDEXED_CHARS: usize = 100_000;
/// Delimiters `snippet()` wraps around matches. Control characters never occur in rendered chat text, and the
/// frontend (`src/lib/searchUtil.ts`) splits on exactly these two.
pub const MARK_OPEN: char = '\u{1}';
pub const MARK_CLOSE: char = '\u{2}';
const DEFAULT_RESULTS: usize = 40;
const MAX_RESULTS: usize = 100;
const MAX_QUERY_CHARS: usize = 256;
const MAX_QUERY_TERMS: usize = 16;

/// The message JSON, or NULL when `content` is not valid JSON (so malformed rows are skipped instead of failing writes).
fn doc_sql(row: &str) -> String {
    format!("(case when json_valid({row}.content) then {row}.content end)")
}

/// SQL scalar subquery: the searchable text of the `messages` row aliased `row` (`new`, `old` or a table alias), or NULL.
/// Only user/assistant `text` parts count, joined by newlines. For user messages the wrappers are removed the way
/// `userText()` in `ChatView.tsx` does: system notifications are skipped, `<user_query>` unwraps imported Cursor
/// turns, and the `<file path=...>` blocks appended for `@file` mentions are cut. Compaction summaries are skipped
/// because they only repeat messages that are indexed anyway.
fn text_sql(row: &str) -> String {
    let doc = doc_sql(row);
    format!(
        "(select substr(trim(clean, ' ' || char(9, 10, 13)), 1, {MAX_INDEXED_CHARS}) from (\
            select case \
                when {row}.role <> 'user' then raw \
                when instr(raw, '<system_notification>') > 0 then null \
                when instr(raw, '<user_query>') > 0 and instr(raw, '</user_query>') > instr(raw, '<user_query>') \
                    then substr(raw, instr(raw, '<user_query>') + 12, instr(raw, '</user_query>') - instr(raw, '<user_query>') - 12) \
                when instr(raw, char(10, 10) || '<file path=\"') > 0 then substr(raw, 1, instr(raw, char(10, 10) || '<file path=\"') - 1) \
                else raw end as clean \
            from (select group_concat(txt, char(10)) as raw from (\
                select case when j.type = 'object' then \
                    case when json_extract(j.value, '$.type') = 'text' and json_type(j.value, '$.text') = 'text' then json_extract(j.value, '$.text') end \
                  end as txt \
                from json_each({doc}, '$.parts') j order by j.id)) \
            where not coalesce(json_extract({doc}, '$.meta.compacted'), 0)))"
    )
}

/// `select id, chat_id, role, model, text` for the rows of `messages` that have searchable text. `from` is empty for a
/// trigger (the row is `new`) or `from messages m` for a backfill.
fn index_rows_sql(row: &str, from: &str) -> String {
    let doc = doc_sql(row);
    format!(
        "select id, chat_id, role, model, text from (\
            select {row}.id as id, {row}.chat_id as chat_id, {row}.role as role, \
                   nullif(case when json_type({doc}, '$.meta.model') = 'text' then json_extract({doc}, '$.meta.model') end, '') as model, \
                   {text} as text {from}) \
         where text is not null and text <> ''",
        text = text_sql(row),
    )
}

fn insert_index_sql(row: &str, from: &str) -> String {
    format!("insert into messages_fts(rowid, chat_id, role, model, text) {}", index_rows_sql(row, from))
}

const SEARCH_OBJECTS: [&str; 4] = ["messages_fts", "messages_fts_ai", "messages_fts_ad", "messages_fts_au"];

/// Idempotent migration. Does nothing when the index exists, is complete and has the current version; otherwise
/// (first start after the upgrade, a version bump, a missing trigger) rebuilds table, triggers and contents from
/// `messages` in one transaction, so a failure leaves the old state untouched.
fn init_search(conn: &Connection) -> rusqlite::Result<()> {
    let stored: Option<String> = conn
        .query_row("select value from settings where key = ?", [SEARCH_VERSION_KEY], |r| r.get(0))
        .optional()?;
    let present: i64 = conn.query_row(
        "select count(*) from sqlite_master where name in ('messages_fts', 'messages_fts_ai', 'messages_fts_ad', 'messages_fts_au')",
        [],
        |r| r.get(0),
    )?;
    if stored.as_deref() == Some(SEARCH_VERSION.to_string().as_str()) && present == SEARCH_OBJECTS.len() as i64 {
        return Ok(());
    }

    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(&format!(
        "drop trigger if exists messages_fts_ai;
         drop trigger if exists messages_fts_ad;
         drop trigger if exists messages_fts_au;
         drop table if exists messages_fts;
         create virtual table messages_fts using fts5(
           text, chat_id unindexed, role unindexed, model unindexed,
           tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
         create trigger messages_fts_ai after insert on messages begin
           {on_insert};
         end;
         create trigger messages_fts_ad after delete on messages begin
           delete from messages_fts where rowid = old.id;
         end;
         create trigger messages_fts_au after update of id, chat_id, role, content on messages begin
           delete from messages_fts where rowid = old.id;
           {on_update};
         end;
         {backfill};",
        on_insert = insert_index_sql("new", ""),
        on_update = insert_index_sql("new", ""),
        backfill = insert_index_sql("m", "from messages m"),
    ))?;
    tx.execute(
        "insert into settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value",
        params![SEARCH_VERSION_KEY, SEARCH_VERSION.to_string()],
    )?;
    tx.commit()
}

/// Turns what the user typed into a safe FTS5 MATCH expression, or `None` when nothing searchable is left.
///
/// Every term becomes a quoted FTS5 string, so operators and syntax characters (`AND`, `OR`, `NOT`, `NEAR`, `-`, `^`,
/// `:`, `*`, parentheses, unbalanced quotes ...) are plain text and can never produce a syntax error. Terms are
/// whitespace-separated and all must match. `"double quoted"` text is an exact phrase. Other terms also match as
/// prefixes (`func` finds `function`), which suits search-as-you-type and inflected languages. Terms without a
/// letter or digit are dropped because they would not produce any token.
pub fn fts_match(query: &str) -> Option<String> {
    let chars: Vec<char> = query.chars().take(MAX_QUERY_CHARS).map(|c| if c.is_control() { ' ' } else { c }).collect();
    let mut terms: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() && terms.len() < MAX_QUERY_TERMS {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        let quoted = chars[i] == '"';
        if quoted {
            i += 1;
        }
        let start = i;
        while i < chars.len() && if quoted { chars[i] != '"' } else { !chars[i].is_whitespace() && chars[i] != '"' } {
            i += 1;
        }
        let text: String = chars[start..i].iter().collect();
        if quoted && i < chars.len() {
            i += 1; // closing quote
        }
        if !text.chars().any(char::is_alphanumeric) {
            continue;
        }
        let prefix = !quoted && text.chars().count() >= 2;
        terms.push(format!("{}{}", fts_quote(&text), if prefix { "*" } else { "" }));
    }
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

/// An FTS5 string literal: wrapped in double quotes, with embedded quotes doubled.
fn fts_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub message_id: i64,
    pub chat_id: i64,
    pub chat_title: String,
    pub project_id: Option<i64>,
    pub project_name: Option<String>,
    pub archived: bool,
    pub role: String,
    /// Model recorded with the message (assistant replies); `None` for user messages and imports.
    pub model: Option<String>,
    pub created_at: i64,
    /// Text around the match with the matches wrapped in `MARK_OPEN` / `MARK_CLOSE`.
    pub snippet: String,
}

const SEARCH_SQL: &str = "
select h.rowid as message_id, h.chat_id, h.role, h.model, h.snip as snippet, m.created_at,
       c.title as chat_title, c.project_id, c.archived, p.name as project_name
from (
  select rowid, chat_id, role, model, rank as score, snippet(messages_fts, 0, ?2, ?3, '…', 24) as snip
  from messages_fts
  where messages_fts match ?1
    and (?4 is null or model = ?4)
    and (?5 is null or chat_id in (select id from chats where project_id = ?5))
  order by rank, rowid desc
  limit ?6
) h
join messages m on m.id = h.rowid
join chats c on c.id = h.chat_id
left join projects p on p.id = c.project_id
order by h.score, h.rowid desc";

/// Best matches first (bm25), newest first among equals. `project_id` / `model` narrow the results when given;
/// the model filter keeps messages recorded with that model (assistant replies).
pub fn search(conn: &Connection, query: &str, project_id: Option<i64>, model: Option<&str>, limit: usize) -> Result<Vec<SearchHit>, String> {
    let Some(expr) = fts_match(query) else { return Ok(Vec::new()) };
    let model = model.filter(|m| !m.is_empty());
    let limit = limit.clamp(1, MAX_RESULTS) as i64;
    let run = || -> rusqlite::Result<Vec<SearchHit>> {
        let mut stmt = conn.prepare_cached(SEARCH_SQL)?;
        let rows = stmt.query_map(
            params![expr, MARK_OPEN.to_string(), MARK_CLOSE.to_string(), model, project_id, limit],
            |r| {
                Ok(SearchHit {
                    message_id: r.get("message_id")?,
                    chat_id: r.get("chat_id")?,
                    chat_title: r.get("chat_title")?,
                    project_id: r.get("project_id")?,
                    project_name: r.get("project_name")?,
                    archived: r.get::<_, i64>("archived")? != 0,
                    role: r.get("role")?,
                    model: r.get("model")?,
                    created_at: r.get("created_at")?,
                    snippet: r.get("snippet")?,
                })
            },
        )?;
        rows.collect()
    };
    match run() {
        Ok(hits) => Ok(hits),
        // `fts_match` quotes everything, so this should be unreachable; never let an FTS parser error reach the UI.
        Err(e) if e.to_string().contains("fts5: syntax error") => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Distinct models that have indexed messages, for the search filter.
pub fn indexed_models(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("select distinct model from messages_fts where model is not null order by model")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

// These run on a worker thread (`async`) so a large search cannot freeze the webview; they only read.
#[tauri::command(async)]
pub fn search_messages(db: State<Db>, query: String, project_id: Option<i64>, model: Option<String>, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
    search(&lock(&db), &query, project_id, model.as_deref(), limit.unwrap_or(DEFAULT_RESULTS))
}

#[tauri::command(async)]
pub fn search_models(db: State<Db>) -> Result<Vec<String>, String> {
    indexed_models(&lock(&db))
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

    // Same statements as src/agent/agentRunsDb.ts.
    const UPSERT_RUN: &str = "insert into agent_runs(id, chat_id, title, type, model, status, started_at, ended_at, tokens, tool_uses, error, report, provider_id, project_root, created_at, changed_json, warnings_json) \
        values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
        on conflict(id) do update set title = excluded.title, model = excluded.model, status = excluded.status, started_at = excluded.started_at, ended_at = excluded.ended_at, \
        tokens = excluded.tokens, tool_uses = excluded.tool_uses, error = excluded.error, report = coalesce(excluded.report, agent_runs.report), \
        changed_json = excluded.changed_json, warnings_json = excluded.warnings_json";
    const INSERT_MESSAGE: &str = "insert or replace into agent_messages(run_id, seq, role, parts_json, created_at) values(?, ?, ?, ?, ?)";
    const PRUNE_RUNS: &str = "delete from agent_runs where status not in ('queued', 'running') and id not in \
        (select id from agent_runs where status not in ('queued', 'running') order by created_at desc, id desc limit ?)";
    const DELETE_FINISHED: &str = "delete from agent_runs where status not in ('queued', 'running') and (? is null or project_root = ?)";

    fn run_row(conn: &Connection, id: &str, chat: Option<i64>, status: &str, created: i64, report: Option<&str>) {
        let chat = chat.map(|c| json!(c)).unwrap_or(Value::Null);
        let report = report.map(|r| json!(r)).unwrap_or(Value::Null);
        execute(conn, UPSERT_RUN, vec![json!(id), chat, json!("t"), json!("explore"), json!("m"), json!(status), json!(1), Value::Null, json!(5), json!(2), Value::Null, report, json!("p"), json!("/proj"), json!(created), Value::Null, Value::Null]).unwrap();
    }

    #[test]
    fn agent_tables_are_added_to_an_old_database_and_keep_their_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.db");
        let conn = open(&path).unwrap();
        run_row(&conn, "r1", None, "completed", 1, Some("report"));
        execute(&conn, INSERT_MESSAGE, vec![json!("r1"), json!(0), json!("user"), json!("[]"), json!(1)]).unwrap();
        drop(conn);

        // Re-opening is a no-op for existing tables.
        let conn = open(&path).unwrap();
        assert_eq!((count(&conn, "agent_runs"), count(&conn, "agent_messages")), (1, 1));
        // An older database (created before these tables existed) just gets them.
        conn.execute_batch("drop trigger agent_runs_chat_deleted; drop table agent_messages; drop table agent_runs;").unwrap();
        drop(conn);
        let conn = open(&path).unwrap();
        assert_eq!((count(&conn, "agent_runs"), count(&conn, "agent_messages")), (0, 0));
        init(&conn).unwrap();
        init(&conn).unwrap();
        run_row(&conn, "r2", None, "running", 2, None);
        assert_eq!(count(&conn, "agent_runs"), 1);
    }

    #[test]
    fn agent_run_upsert_keeps_the_stored_report_and_messages_follow_their_run() {
        let conn = memory();
        run_row(&conn, "r1", None, "running", 1, None);
        run_row(&conn, "r1", None, "completed", 1, Some("final report"));
        run_row(&conn, "r1", None, "completed", 1, None); // a later update without a report keeps it
        let rows = select(&conn, "select status, report from agent_runs where id = 'r1'", vec![]).unwrap();
        assert_eq!((rows[0]["status"].clone(), rows[0]["report"].clone()), (json!("completed"), json!("final report")));

        execute(&conn, INSERT_MESSAGE, vec![json!("r1"), json!(0), json!("user"), json!("[{\"type\":\"text\",\"text\":\"a\"}]"), json!(1)]).unwrap();
        execute(&conn, INSERT_MESSAGE, vec![json!("r1"), json!(0), json!("user"), json!("[]"), json!(2)]).unwrap(); // same seq replaces
        execute(&conn, INSERT_MESSAGE, vec![json!("r1"), json!(1), json!("assistant"), json!("[]"), json!(3)]).unwrap();
        assert_eq!(count(&conn, "agent_messages"), 2);
        let order = select(&conn, "select seq from agent_messages where run_id = 'r1' order by seq", vec![]).unwrap();
        assert_eq!(order.iter().map(|r| r["seq"].as_i64().unwrap()).collect::<Vec<_>>(), vec![0, 1]);
        // A message of a run that does not exist is rejected (the app writes the run row first).
        assert!(execute(&conn, INSERT_MESSAGE, vec![json!("ghost"), json!(0), json!("user"), json!("[]"), json!(1)]).is_err());

        execute(&conn, "delete from agent_runs where id = 'r1'", vec![]).unwrap();
        assert_eq!(count(&conn, "agent_messages"), 0, "messages are deleted with their run");
    }

    #[test]
    fn deleting_a_chat_removes_the_agent_runs_it_started() {
        let conn = memory();
        let project = execute(&conn, "insert into projects(name, created_at) values('p', 1)", vec![]).unwrap().1;
        let chat = execute(&conn, "insert into chats(project_id, title, created_at, updated_at) values(?, 't', 1, 1)", vec![json!(project)]).unwrap().1;
        let other = new_chat(&conn);
        run_row(&conn, "mine", Some(chat), "completed", 1, None);
        run_row(&conn, "theirs", Some(other), "completed", 2, None);
        run_row(&conn, "loose", None, "completed", 3, None);
        execute(&conn, INSERT_MESSAGE, vec![json!("mine"), json!(0), json!("user"), json!("[]"), json!(1)]).unwrap();
        // Through the project cascade too.
        execute(&conn, "delete from projects where id = ?", vec![json!(project)]).unwrap();
        let ids = select(&conn, "select id from agent_runs order by id", vec![]).unwrap();
        assert_eq!(ids.iter().map(|r| r["id"].as_str().unwrap().to_string()).collect::<Vec<_>>(), vec!["loose", "theirs"]);
        assert_eq!(count(&conn, "agent_messages"), 0);
    }

    #[test]
    fn agent_run_retention_keeps_active_runs_and_the_newest_finished_ones() {
        let conn = memory();
        for i in 0..10 {
            run_row(&conn, &format!("d{i}"), None, "completed", 100 + i, None);
            execute(&conn, INSERT_MESSAGE, vec![json!(format!("d{i}")), json!(0), json!("user"), json!("[]"), json!(1)]).unwrap();
        }
        run_row(&conn, "live", None, "running", 1, None);
        run_row(&conn, "queued", None, "queued", 2, None);
        execute(&conn, PRUNE_RUNS, vec![json!(3)]).unwrap();
        let ids = select(&conn, "select id from agent_runs order by created_at", vec![]).unwrap();
        assert_eq!(ids.iter().map(|r| r["id"].as_str().unwrap().to_string()).collect::<Vec<_>>(), vec!["live", "queued", "d7", "d8", "d9"]);
        assert_eq!(count(&conn, "agent_messages"), 3);

        // "Clear" removes finished runs of one project (or of all), never active ones.
        execute(&conn, DELETE_FINISHED, vec![json!("/other"), json!("/other")]).unwrap();
        assert_eq!(count(&conn, "agent_runs"), 5);
        execute(&conn, DELETE_FINISHED, vec![Value::Null, Value::Null]).unwrap();
        assert_eq!(count(&conn, "agent_runs"), 2);
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

    // ---- full-text search ----

    fn project(conn: &Connection, name: &str) -> i64 {
        execute(conn, "insert into projects(name, created_at) values(?, 1)", vec![json!(name)]).unwrap().1
    }

    fn chat_in(conn: &Connection, project: Option<i64>, title: &str) -> i64 {
        execute(
            conn,
            "insert into chats(project_id, title, created_at, updated_at) values(?, ?, 1, 1)",
            vec![json!(project), json!(title)],
        )
        .unwrap()
        .1
    }

    /// Stores a message the way `addMessage` in `src/lib/data.ts` does: role plus JSON `{ role, parts, meta }`.
    fn add_json(conn: &Connection, chat: i64, role: &str, content: &str) -> i64 {
        let (changes, id) = execute(
            conn,
            "insert into messages(chat_id, role, content, created_at) values(?, ?, ?, 1)",
            vec![json!(chat), json!(role), json!(content)],
        )
        .unwrap();
        assert_eq!(changes, 1, "trigger changes are not counted");
        id
    }

    fn add_text(conn: &Connection, chat: i64, role: &str, text: &str, model: Option<&str>) -> i64 {
        let meta = model.map(|m| json!({ "provider": "p", "model": m })).unwrap_or(Value::Null);
        let content = json!({ "role": role, "parts": [{ "type": "text", "text": text }], "meta": meta });
        add_json(conn, chat, role, &content.to_string())
    }

    /// Ids of the matching messages in ranking order.
    fn ranked(conn: &Connection, query: &str) -> Vec<i64> {
        search(conn, query, None, None, 100).unwrap().iter().map(|h| h.message_id).collect()
    }

    /// Ids of the matching messages, ascending (for assertions that do not care about the ranking).
    fn found(conn: &Connection, query: &str) -> Vec<i64> {
        let mut ids = ranked(conn, query);
        ids.sort();
        ids
    }

    fn indexed_text(conn: &Connection, id: i64) -> Option<String> {
        let rows = select(conn, "select text from messages_fts where rowid = ?", vec![json!(id)]).unwrap();
        rows.first().map(|r| r["text"].as_str().unwrap().to_string())
    }

    fn drop_search_index(conn: &Connection) {
        conn.execute_batch(
            "drop trigger messages_fts_ai; drop trigger messages_fts_ad; drop trigger messages_fts_au;
             drop table messages_fts; delete from settings where key = 'searchIndexVersion';",
        )
        .unwrap();
    }

    #[test]
    fn fts5_and_json_functions_are_available_without_extra_cargo_features() {
        // The bundled SQLite of rusqlite (feature `bundled`, see Cargo.toml) is compiled with FTS5 and JSON.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("create virtual table t using fts5(a); insert into t values('hello world')").unwrap();
        let n: i64 = conn.query_row("select count(*) from t where t match 'hello'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let v: String = conn.query_row("select json_extract('{\"a\":[1,{\"b\":\"x\"}]}', '$.a[1].b')", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "x");
    }

    #[test]
    fn search_index_is_backfilled_for_an_existing_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.db");
        let conn = open(&path).unwrap();
        let chat = chat_in(&conn, None, "old chat");
        // A database from before search existed: no index, no triggers, no version row.
        drop_search_index(&conn);
        let a = add_text(&conn, chat, "user", "remember the pineapple plan", None);
        let b = add_text(&conn, chat, "assistant", "the pineapple plan is ready", Some("m1"));
        let image = add_json(
            &conn,
            chat,
            "user",
            &json!({ "role": "user", "parts": [{ "type": "image", "data": "QUJDREVGRw==" }], "meta": {} }).to_string(),
        );
        let tool = add_json(
            &conn,
            chat,
            "tool",
            &json!({ "role": "tool", "parts": [{ "type": "tool_result", "id": "1", "name": "run", "output": "pineapple in tool output" }], "meta": {} }).to_string(),
        );
        assert!(select(&conn, "select 1 from sqlite_master where name = 'messages_fts'", vec![]).unwrap().is_empty());
        drop(conn);

        let conn = open(&path).unwrap();
        assert_eq!(found(&conn, "pineapple"), vec![a, b], "text parts are indexed, tool output is not");
        assert_eq!(indexed_text(&conn, image), None);
        assert_eq!(indexed_text(&conn, tool), None);
        assert_eq!(count(&conn, "messages"), 4, "backfill does not touch messages");
        // Data written after the migration is indexed by the triggers.
        let c = add_text(&conn, chat, "user", "pineapple again", None);
        assert_eq!(found(&conn, "pineapple"), vec![a, b, c]);
    }

    #[test]
    fn search_migration_is_idempotent_and_rebuilds_a_damaged_index() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.db");
        let conn = open(&path).unwrap();
        let chat = chat_in(&conn, None, "t");
        let a = add_text(&conn, chat, "user", "alpha beta", None);
        assert_eq!(count(&conn, "messages_fts"), 1);

        // Running it again (same process or after a restart) neither duplicates rows nor rebuilds.
        init(&conn).unwrap();
        init(&conn).unwrap();
        execute(&conn, "insert into messages_fts(rowid, chat_id, role, model, text) values(999, 1, 'user', null, 'sentinel')", vec![]).unwrap();
        init(&conn).unwrap();
        drop(conn);
        let conn = open(&path).unwrap();
        assert_eq!(count(&conn, "messages_fts"), 2, "a complete, current index is left alone");
        assert_eq!(found(&conn, "alpha"), vec![a]);

        // A newer SEARCH_VERSION (simulated by an older stored one) rebuilds from the messages table.
        execute(&conn, "update settings set value = '0' where key = 'searchIndexVersion'", vec![]).unwrap();
        init(&conn).unwrap();
        assert_eq!(count(&conn, "messages_fts"), 1, "sentinel row is gone after the rebuild");
        assert_eq!(found(&conn, "alpha"), vec![a]);
        let version = select(&conn, "select value from settings where key = 'searchIndexVersion'", vec![]).unwrap();
        assert_eq!(version[0]["value"], json!(SEARCH_VERSION.to_string()));

        // A missing trigger is repaired too (otherwise new messages would silently stay unsearchable).
        conn.execute_batch("drop trigger messages_fts_ai").unwrap();
        let b = add_text(&conn, chat, "user", "gamma delta", None);
        assert!(found(&conn, "gamma").is_empty(), "precondition: without the trigger the message is not indexed");
        init(&conn).unwrap();
        assert_eq!(found(&conn, "gamma"), vec![b]);
        add_text(&conn, chat, "user", "epsilon", None);
        execute(&conn, "update messages set content = replace(content, 'epsilon', 'zeta') where id = (select max(id) from messages)", vec![]).unwrap();
        assert_eq!(found(&conn, "zeta").len(), 1);
        assert_eq!(found(&conn, "epsilon").len(), 0);
    }

    #[test]
    fn search_index_follows_inserts_updates_and_deletes() {
        let conn = memory();
        let chat = chat_in(&conn, None, "t");
        let other = chat_in(&conn, None, "other");
        let a = add_text(&conn, chat, "user", "first draft about kiwis", None);
        let b = add_text(&conn, chat, "assistant", "kiwis are green", Some("m1"));
        let c = add_text(&conn, other, "user", "kiwi elsewhere", None);
        assert_eq!(found(&conn, "kiwi"), vec![a, b, c]);

        // addMessage's last_insert_rowid must be the message id even though a trigger inserts into another table.
        let (_, id) = execute(&conn, "insert into messages(chat_id, role, content, created_at) values(?, 'user', ?, 1)", vec![json!(chat), json!(r#"{"role":"user","parts":[{"type":"text","text":"limes"}]}"#)]).unwrap();
        assert_eq!(found(&conn, "limes"), vec![id]);

        // restoreContext-style rewrite of `content`.
        let rewritten = json!({ "role": "user", "parts": [{ "type": "text", "text": "first draft about mangos" }], "meta": {} }).to_string();
        execute(&conn, "update messages set content = ? where chat_id = ? and id = ?", vec![json!(rewritten), json!(chat), json!(a)]).unwrap();
        assert_eq!(found(&conn, "mangos"), vec![a]);
        assert_eq!(found(&conn, "kiwis"), vec![b], "the old text is no longer indexed");

        // Updates of unrelated columns keep the row, and a rewrite to unsearchable content drops it.
        execute(&conn, "update chats set title = 'renamed' where id = ?", vec![json!(chat)]).unwrap();
        assert_eq!(found(&conn, "mangos"), vec![a]);
        let blank = json!({ "role": "user", "parts": [{ "type": "image", "data": "AAAA" }] }).to_string();
        execute(&conn, "update messages set content = ? where id = ?", vec![json!(blank), json!(a)]).unwrap();
        assert!(found(&conn, "mangos").is_empty());

        // Rewinding: deleteMessagesFrom.
        execute(&conn, "delete from messages where chat_id = ? and id >= ?", vec![json!(chat), json!(b)]).unwrap();
        assert_eq!(found(&conn, "kiwi"), vec![c]);
        assert_eq!(count(&conn, "messages_fts"), 1);
    }

    #[test]
    fn deleting_a_chat_or_project_removes_its_messages_from_the_index() {
        let conn = memory();
        let p = project(&conn, "proj");
        let in_project = chat_in(&conn, Some(p), "a");
        let loose = chat_in(&conn, None, "b");
        add_text(&conn, in_project, "user", "banana one", None);
        add_text(&conn, in_project, "assistant", "banana two", Some("m"));
        let keep = add_text(&conn, loose, "user", "banana three", None);
        assert_eq!(found(&conn, "banana").len(), 3);

        // chat -> messages is ON DELETE CASCADE and still fires the delete trigger.
        let doomed = chat_in(&conn, None, "c");
        add_text(&conn, doomed, "user", "banana four", None);
        execute(&conn, "delete from chats where id = ?", vec![json!(doomed)]).unwrap();
        assert_eq!(found(&conn, "banana").len(), 3);

        // project -> chats -> messages cascades two levels.
        execute(&conn, "delete from projects where id = ?", vec![json!(p)]).unwrap();
        assert_eq!(found(&conn, "banana"), vec![keep]);
        assert_eq!(count(&conn, "messages_fts"), 1);
        assert_eq!(count(&conn, "messages"), 1);
    }

    #[test]
    fn only_readable_text_is_extracted() {
        let conn = memory();
        let chat = chat_in(&conn, None, "t");
        let part = |t: &str, text: &str| json!({ "type": t, "text": text });
        let msg = |role: &str, parts: Vec<Value>, meta: Value| json!({ "role": role, "parts": parts, "meta": meta }).to_string();

        let plain = add_json(&conn, chat, "user", &msg("user", vec![part("text", "hello world")], json!({})));
        assert_eq!(indexed_text(&conn, plain).as_deref(), Some("hello world"));

        // Text next to an image: the base64 payload never reaches the index.
        let mixed = add_json(&conn, chat, "user", &msg("user", vec![part("text", "look at this"), json!({ "type": "image", "data": "SECRETBASE64DATA" })], json!({})));
        assert_eq!(indexed_text(&conn, mixed).as_deref(), Some("look at this"));
        assert!(found(&conn, "SECRETBASE64DATA").is_empty());

        // Assistant message with tool calls and activities: only the prose.
        let agent = add_json(
            &conn,
            chat,
            "assistant",
            &msg(
                "assistant",
                vec![
                    part("text", "let me check"),
                    json!({ "type": "tool_call", "id": "1", "name": "fs_read", "args": { "path": "TOOLARGUMENT" } }),
                    json!({ "type": "activity", "id": "2", "name": "sh", "args": {}, "status": "success", "output": "ACTIVITYOUTPUT" }),
                    part("text", "and then fix it"),
                ],
                json!({ "provider": "p", "model": "m" }),
            ),
        );
        assert_eq!(indexed_text(&conn, agent).as_deref(), Some("let me check\nand then fix it"), "text parts joined in order");
        assert!(found(&conn, "TOOLARGUMENT").is_empty() && found(&conn, "ACTIVITYOUTPUT").is_empty());

        // Role 'tool' messages hold results only.
        let tool = add_json(&conn, chat, "tool", &msg("tool", vec![json!({ "type": "tool_result", "id": "1", "name": "x", "output": "RESULTOUTPUT" })], json!({})));
        assert_eq!(indexed_text(&conn, tool), None);

        // `@file` mentions append `<file>` blocks to the stored user text; they are not part of the question.
        let mention = add_json(&conn, chat, "user", &msg("user", vec![part("text", "fix this\n\n<file path=\"a.ts\">\nFILEBODYMARKER\n</file>")], json!({})));
        assert_eq!(indexed_text(&conn, mention).as_deref(), Some("fix this"));
        // ...but an assistant may legitimately write such text.
        let quoted = add_json(&conn, chat, "assistant", &msg("assistant", vec![part("text", "see\n\n<file path=\"x\"> tag usage")], json!({})));
        assert_eq!(indexed_text(&conn, quoted).as_deref(), Some("see\n\n<file path=\"x\"> tag usage"));

        // Imported Cursor turns: unwrap <user_query>, skip system notifications.
        let cursor = add_json(&conn, chat, "user", &msg("user", vec![part("text", "<timestamp>Monday</timestamp>\n<user_query>\nbuild the thing\n</user_query>")], json!({ "imported": "cursor" })));
        assert_eq!(indexed_text(&conn, cursor).as_deref(), Some("build the thing"));
        assert!(found(&conn, "Monday").is_empty());
        let notification = add_json(&conn, chat, "user", &msg("user", vec![part("text", "<system_notification>shell finished</system_notification>")], json!({})));
        assert_eq!(indexed_text(&conn, notification), None);

        // Compaction summaries repeat messages that are indexed themselves.
        let summary = add_json(&conn, chat, "user", &msg("user", vec![part("text", "SUMMARYTEXT of the chat")], json!({ "compacted": true, "model": "m" })));
        assert_eq!(indexed_text(&conn, summary), None);

        // Nothing readable left: no row.
        let blank = add_json(&conn, chat, "assistant", &msg("assistant", vec![part("text", " \n\t ")], json!({})));
        assert_eq!(indexed_text(&conn, blank), None);
    }

    #[test]
    fn malformed_message_content_never_breaks_writes() {
        let conn = memory();
        let chat = chat_in(&conn, None, "t");
        let odd = [
            "not json at all",
            "",
            "null",
            "5",
            "\"just a string\"",
            "[]",
            "[1, 2]",
            "{}",
            r#"{"parts": "oops"}"#,
            r#"{"parts": {"type": "text", "text": "object, not array"}}"#,
            r#"{"parts": [1, "x", null, [], {"type": "text"}, {"type": "text", "text": 5}, {"type": 7, "text": "n"}]}"#,
            r#"{"parts": [{"type": "text", "text": "ok"}], "meta": "not an object"}"#,
            r#"{"parts": [{"type": "text", "text": "ok2"}], "meta": {"model": 7, "compacted": "yes"}}"#,
        ];
        for content in odd {
            let id = add_json(&conn, chat, "assistant", content);
            execute(&conn, "update messages set content = content || ' ' where id = ?", vec![json!(id)]).unwrap();
        }
        assert_eq!(count(&conn, "messages"), odd.len() as i64);
        // The two well-formed-enough rows are searchable ("ok" also matches "ok2" as a prefix): one has a string
        // `meta`, the other odd meta values (a string `compacted` is not the boolean true; the integer model is ignored).
        assert_eq!(found(&conn, "ok").len(), 2);
        assert_eq!(found(&conn, "ok2").len(), 1);
        assert!(found(&conn, "object").is_empty());
    }

    #[test]
    fn query_escaping_produces_safe_fts_expressions() {
        assert_eq!(fts_match("foo bar").as_deref(), Some(r#""foo"* "bar"*"#));
        assert_eq!(fts_match("  spaced   out ").as_deref(), Some(r#""spaced"* "out"*"#));
        assert_eq!(fts_match(r#""exact phrase" tail"#).as_deref(), Some(r#""exact phrase" "tail"*"#));
        assert_eq!(fts_match(r#""unterminated phrase"#).as_deref(), Some(r#""unterminated phrase""#));
        assert_eq!(fts_match(r#"foo"bar"#).as_deref(), Some(r#""foo"* "bar""#));
        assert_eq!(fts_match("a").as_deref(), Some(r#""a""#), "one-letter terms are not prefix-expanded");
        assert_eq!(fts_match("AND OR NOT NEAR").as_deref(), Some(r#""AND"* "OR"* "NOT"* "NEAR"*"#), "operators are plain words");
        assert_eq!(fts_match("text:foo -bar ^baz").as_deref(), Some(r#""text:foo"* "-bar"* "^baz"*"#));
        assert_eq!(fts_match("snake_case C++ a.b").as_deref(), Some(r#""snake_case"* "C++"* "a.b"*"#));
        assert_eq!(fts_match("привет мир").as_deref(), Some(r#""привет"* "мир"*"#));
        for nothing in ["", "   ", "\"", "\"\"", "- * ( ) { } : ^ ~ + ;", "\t\n", "\u{0}"] {
            assert_eq!(fts_match(nothing), None, "{nothing:?}");
        }
        assert_eq!(fts_quote("a\"b"), "\"a\"\"b\"", "embedded quotes are doubled");
        let many = (0..100).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ");
        assert_eq!(fts_match(&many).unwrap().matches(' ').count() + 1, MAX_QUERY_TERMS);
        let long = "x".repeat(10_000);
        assert!(fts_match(&long).unwrap().len() <= MAX_QUERY_CHARS + 4);
    }

    #[test]
    fn hostile_queries_never_error() {
        let conn = memory();
        let chat = chat_in(&conn, None, "t");
        let id = add_text(&conn, chat, "assistant", "foo not bar and some words; DROP TABLE messages", None);
        let nasty = [
            "\"", "\"\"", "\"\"\"", "\"unbalanced", "unbalanced\"", "AND", "OR", "NOT", "a AND", "AND a", "a OR OR b", "NOT NOT", "NEAR(a b)",
            "NEAR/2", "a NEAR/0 b", "-foo", "foo*", "*", "**", "^foo", "text:foo", "text : foo", "{text}: foo", "(", ")", "(foo", "foo)", "((()))",
            "{", "}", "[", "]", "'", "''", "foo'bar", "a;b", "; DROP TABLE messages; --", "%", "_", "\\", "\\\"", "?", "!", "~", "+", "foo +bar", "foo\u{0}bar",
            "\u{1}", "\u{2}", "é", "ё", "日本語", "😀", "a\nb", "a\tb",
        ];
        for q in nasty {
            let res = search(&conn, q, None, None, 10);
            assert!(res.is_ok(), "query {q:?} failed: {:?}", res.err());
        }
        // Long and many-term queries.
        assert!(search(&conn, &"foo ".repeat(5_000), None, None, 10).is_ok());
        assert!(search(&conn, &"\"a b\" ".repeat(500), Some(1), Some("m"), 10).is_ok());
        // Operators are literal text: "foo NOT bar" needs the word `not` to be present, it does not exclude `bar`.
        assert_eq!(found(&conn, "foo NOT bar"), vec![id]);
        assert!(found(&conn, "foo NOT baz").is_empty());
        assert_eq!(found(&conn, "DROP TABLE"), vec![id]);
        assert_eq!(count(&conn, "messages"), 1, "the table is still there");
        // A model or project id that matches nothing is just an empty result.
        assert!(search(&conn, "foo", Some(12345), Some("nope"), 10).unwrap().is_empty());
        assert!(search(&conn, "", None, None, 10).unwrap().is_empty());
    }

    #[test]
    fn search_filters_by_project_and_model() {
        let conn = memory();
        let p1 = project(&conn, "Alpha project");
        let p2 = project(&conn, "Beta project");
        let c1 = chat_in(&conn, Some(p1), "Plan the launch");
        let c2 = chat_in(&conn, Some(p2), "Other work");
        let c3 = chat_in(&conn, None, "Loose chat");
        let q1 = add_text(&conn, c1, "user", "pelican question", None);
        let a1 = add_text(&conn, c1, "assistant", "pelican answer", Some("m1"));
        let a2 = add_text(&conn, c2, "assistant", "pelican reply", Some("m2"));
        let a3 = add_text(&conn, c3, "assistant", "pelican note", Some("m1"));
        let ids = |hits: Vec<SearchHit>| {
            let mut v: Vec<i64> = hits.iter().map(|h| h.message_id).collect();
            v.sort();
            v
        };

        assert_eq!(ids(search(&conn, "pelican", None, None, 50).unwrap()), vec![q1, a1, a2, a3]);
        assert_eq!(ids(search(&conn, "pelican", Some(p1), None, 50).unwrap()), vec![q1, a1]);
        assert_eq!(ids(search(&conn, "pelican", Some(p2), None, 50).unwrap()), vec![a2]);
        assert_eq!(ids(search(&conn, "pelican", None, Some("m1"), 50).unwrap()), vec![a1, a3]);
        assert_eq!(ids(search(&conn, "pelican", Some(p1), Some("m1"), 50).unwrap()), vec![a1]);
        assert!(search(&conn, "pelican", Some(p2), Some("m1"), 50).unwrap().is_empty());
        assert!(search(&conn, "pelican", None, Some("m3"), 50).unwrap().is_empty());
        assert_eq!(ids(search(&conn, "pelican", None, Some(""), 50).unwrap()), vec![q1, a1, a2, a3], "an empty model means no filter");

        // Result fields come from the joined chat/project rows.
        let hits = search(&conn, "pelican answer", Some(p1), None, 50).unwrap();
        let hit = hits.iter().find(|h| h.message_id == a1).unwrap();
        assert_eq!((hit.chat_id, hit.chat_title.as_str(), hit.project_id), (c1, "Plan the launch", Some(p1)));
        assert_eq!((hit.project_name.as_deref(), hit.role.as_str(), hit.model.as_deref()), (Some("Alpha project"), "assistant", Some("m1")));
        assert!(!hit.archived);
        let loose = search(&conn, "pelican note", None, None, 50).unwrap();
        assert_eq!((loose[0].project_id, loose[0].project_name.clone()), (None, None));
        let user_hit = search(&conn, "pelican question", None, None, 50).unwrap();
        assert_eq!(user_hit[0].model, None);

        // Archived chats stay searchable and are flagged.
        execute(&conn, "update chats set archived = 1 where id = ?", vec![json!(c2)]).unwrap();
        let archived = search(&conn, "reply", None, None, 50).unwrap();
        assert!(archived[0].archived);

        // Models offered by the filter: only models that have indexed messages.
        assert_eq!(indexed_models(&conn).unwrap(), vec!["m1".to_string(), "m2".to_string()]);
    }

    #[test]
    fn results_are_ranked_limited_and_have_marked_snippets() {
        let conn = memory();
        let chat = chat_in(&conn, None, "t");
        let first = add_text(&conn, chat, "user", "same words here", None);
        let second = add_text(&conn, chat, "user", "same words here", None);
        let strong = add_text(&conn, chat, "user", "words", None);
        let hits = ranked(&conn, "words");
        assert_eq!(hits[0], strong, "a shorter, denser match ranks first");
        assert_eq!(&hits[1..], &[second, first], "equal scores: newest first");
        assert_eq!(search(&conn, "words", None, None, 2).unwrap().len(), 2);
        assert_eq!(search(&conn, "words", None, None, 0).unwrap().len(), 1, "limit is clamped to at least one");
        assert_eq!(search(&conn, "words", None, None, 1_000_000).unwrap().len(), 3);

        let long = format!("{} the needle is right here {}", "filler ".repeat(200), "more ".repeat(200));
        add_text(&conn, chat, "assistant", &long, Some("m"));
        let hit = &search(&conn, "needle", None, None, 5).unwrap()[0];
        assert!(hit.snippet.contains(&format!("{MARK_OPEN}needle{MARK_CLOSE}")), "{:?}", hit.snippet);
        assert!(hit.snippet.contains('…'), "long messages are shortened around the match");
        assert!(hit.snippet.chars().count() < 400);
        // Prefix matching marks the whole word that matched.
        let prefix = &search(&conn, "needl", None, None, 5).unwrap()[0];
        assert!(prefix.snippet.contains(&format!("{MARK_OPEN}needle{MARK_CLOSE}")));
        // Phrases match exactly, in order.
        assert_eq!(search(&conn, "\"needle is right\"", None, None, 5).unwrap().len(), 1);
        assert!(search(&conn, "\"right needle\"", None, None, 5).unwrap().is_empty());
    }

    #[test]
    fn matching_is_case_and_accent_insensitive_and_handles_cyrillic() {
        let conn = memory();
        let chat = chat_in(&conn, None, "t");
        let ru = add_text(&conn, chat, "user", "Привет, как дела? Ёлка во дворе", None);
        let fr = add_text(&conn, chat, "assistant", "Un café très agréable", Some("m"));
        // (Case folding covers Cyrillic; `ё` is not folded to `е` by the unicode61 tokenizer, so those stay distinct.)
        for q in ["привет", "ПРИВЕТ", "Привет", "приве", "дела", "ёлка", "ЁЛКА"] {
            assert_eq!(found(&conn, q), vec![ru], "{q}");
        }
        for q in ["cafe", "CAFÉ", "agreable", "tres"] {
            assert_eq!(found(&conn, q), vec![fr], "{q}");
        }
        assert!(found(&conn, "привет cafe").is_empty(), "all terms must match");
    }

    #[test]
    fn very_long_messages_are_cut_in_the_index_only() {
        let conn = memory();
        let chat = chat_in(&conn, None, "t");
        let text = format!("{} tailmarker", "x".repeat(MAX_INDEXED_CHARS + 50_000));
        let id = add_text(&conn, chat, "assistant", &text, None);
        let rows = select(&conn, "select length(text) as n from messages_fts where rowid = ?", vec![json!(id)]).unwrap();
        assert_eq!(rows[0]["n"], json!(MAX_INDEXED_CHARS as i64));
        assert!(found(&conn, "tailmarker").is_empty(), "text past the cap is not searchable");
        let stored = select(&conn, "select length(content) as n from messages where id = ?", vec![json!(id)]).unwrap();
        assert!(stored[0]["n"].as_i64().unwrap() > MAX_INDEXED_CHARS as i64, "the message itself is untouched");
    }
}
