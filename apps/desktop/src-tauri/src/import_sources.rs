//! Scanners and bounded readers for the history importers (Claude Code, Codex CLI, ChatGPT export).
//!
//! Everything here is read-only and runs on a worker thread. The commands return small summaries (title, project
//! directory, message count, timestamps) and raw file text; turning that text into chat messages is done by the pure
//! parsers in `src/lib/importers`. Nothing in these files is trusted: every line, file and result is size-bounded,
//! malformed lines are skipped, and project directories found in a file are only reported as text, never opened.

use serde::de::{IgnoredAny, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Value};
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

/// A line longer than this is skipped (counted as malformed).
const MAX_LINE: usize = 4 * 1024 * 1024;
/// A session is summarized from at most this many bytes; the rest only marks the summary `truncated`.
const MAX_SCAN_BYTES: u64 = 64 * 1024 * 1024;
/// Largest session text handed to the importer; longer files are cut at a line boundary and flagged.
const MAX_READ_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SESSIONS: usize = 3000;
const MAX_DIRS: usize = 2000;
const MAX_TITLE_CHARS: usize = 120;
/// ChatGPT export: whole file limit, a single conversation limit, and the total returned by one read.
const MAX_EXPORT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_CONVERSATION_BYTES: usize = 24 * 1024 * 1024;
const MAX_READ_TOTAL: usize = 64 * 1024 * 1024;
const MAX_EXPORT_CONVERSATIONS: usize = 100_000;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSession {
    /// Source specific id (session id, or the conversation id for ChatGPT).
    pub id: String,
    /// Absolute path of the session file (Claude Code and Codex); empty for ChatGPT.
    pub path: String,
    pub title: String,
    pub project_path: Option<String>,
    pub message_count: i64,
    /// Milliseconds since the epoch; 0 when unknown.
    pub created_at: i64,
    pub updated_at: i64,
    pub size_bytes: i64,
    /// The file was only partly scanned (very large); the count is a lower bound.
    pub truncated: bool,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionText {
    pub text: String,
    pub truncated: bool,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConversationBatch {
    pub conversations: Vec<String>,
    /// Ids that were too large, or did not fit in the size budget of this call.
    pub skipped: Vec<String>,
}

// ---------------------------------------------------------------------------------------------------------------
// Time

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Parses `2026-01-05T09:00:00(.123)(Z|±hh:mm)` into milliseconds since the epoch.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19
        || b[4] != b'-'
        || b[7] != b'-'
        || !(b[10] == b'T' || b[10] == b' ')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let n = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (
        n(0, 4)?,
        n(5, 7)?,
        n(8, 10)?,
        n(11, 13)?,
        n(14, 16)?,
        n(17, 19)?,
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut rest = &s[19..];
    let mut ms = 0;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            return None;
        }
        let mut padded = digits.clone();
        padded.truncate(3);
        while padded.len() < 3 {
            padded.push('0');
        }
        ms = padded.parse::<i64>().ok()?;
        rest = &frac[digits.len()..];
    }
    let offset = match rest {
        "" | "Z" | "z" => 0,
        o if o.len() == 6
            && (o.starts_with('+') || o.starts_with('-'))
            && o.as_bytes()[3] == b':' =>
        {
            let v = o[1..3].parse::<i64>().ok()? * 60 + o[4..6].parse::<i64>().ok()?;
            if o.starts_with('-') {
                -v
            } else {
                v
            }
        }
        _ => return None,
    };
    Some(((days_from_civil(y, mo, d) * 24 + h) * 60 + mi - offset) * 60_000 + se * 1000 + ms)
}

fn file_times(path: &Path) -> (i64, i64) {
    let ms = |t: io::Result<std::time::SystemTime>| {
        t.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    };
    match std::fs::metadata(path) {
        Ok(m) => (ms(m.created()), ms(m.modified())),
        Err(_) => (0, 0),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Bounded line reading

/// Reads one line without ever holding more than `max` bytes. Returns `Ok(None)` at EOF, otherwise the number of bytes
/// consumed; `buf` is cleared if the line was longer than `max` (the rest of it is discarded) and `over` is set.
fn read_line_bounded<R: BufRead>(
    r: &mut R,
    buf: &mut Vec<u8>,
    max: usize,
    over: &mut bool,
) -> io::Result<Option<u64>> {
    buf.clear();
    *over = false;
    let mut consumed = 0u64;
    loop {
        let (used, done) = {
            let chunk = r.fill_buf()?;
            if chunk.is_empty() {
                return Ok(if consumed == 0 { None } else { Some(consumed) });
            }
            match chunk.iter().position(|&c| c == b'\n') {
                Some(i) => {
                    if !*over {
                        buf.extend_from_slice(&chunk[..i]);
                    }
                    (i + 1, true)
                }
                None => {
                    if !*over {
                        buf.extend_from_slice(chunk);
                    }
                    (chunk.len(), false)
                }
            }
        };
        if buf.len() > max {
            *over = true;
            buf.clear();
        }
        r.consume(used);
        consumed += used as u64;
        if done {
            return Ok(Some(consumed));
        }
    }
}

fn clip(s: &str, max: usize) -> String {
    let one_line: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    one_line.chars().take(max).collect()
}

fn has_jsonl_ext(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code: <root>/<encoded project>/<session>.jsonl

fn text_of_blocks(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(a) => {
            let t: Vec<&str> = a
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect();
            if t.is_empty() {
                None
            } else {
                Some(t.join("\n"))
            }
        }
        _ => None,
    }
}

/// Wrappers Claude Code stores as user lines that are not something the user typed.
fn claude_noise(text: &str) -> bool {
    let t = text.trim_start();
    [
        "<local-command-",
        "<command-",
        "<system-reminder>",
        "Caveat: The messages below",
        "[Request interrupted",
    ]
    .iter()
    .any(|p| t.starts_with(p))
}

pub fn scan_claude_file(path: &Path) -> Option<SourceSession> {
    let file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let mut r = BufReader::with_capacity(64 * 1024, file.take(MAX_SCAN_BYTES));
    let (mut buf, mut over) = (Vec::new(), false);
    let (mut count, mut first_ts, mut last_ts) = (0i64, 0i64, 0i64);
    let (mut id, mut cwd, mut custom, mut summary, mut first_user) = (
        stem,
        None::<String>,
        None::<String>,
        None::<String>,
        None::<String>,
    );
    while let Ok(Some(_)) = read_line_bounded(&mut r, &mut buf, MAX_LINE, &mut over) {
        if over || buf.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(&buf) else {
            continue;
        };
        match v["type"].as_str() {
            Some("custom-title") => {
                custom = v["customTitle"]
                    .as_str()
                    .map(|s| clip(s, MAX_TITLE_CHARS))
                    .filter(|s| !s.is_empty())
            }
            Some("summary") => {
                summary = summary.or_else(|| {
                    v["summary"]
                        .as_str()
                        .map(|s| clip(s, MAX_TITLE_CHARS))
                        .filter(|s| !s.is_empty())
                })
            }
            Some(kind @ ("user" | "assistant")) => {
                if v["isSidechain"] == true || v["isMeta"] == true || v["isCompactSummary"] == true
                {
                    continue;
                }
                if let Some(s) = v["sessionId"].as_str() {
                    if count == 0 && !s.is_empty() {
                        id = s.to_string();
                    }
                }
                if cwd.is_none() {
                    cwd = v["cwd"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(String::from);
                }
                let ts = v["timestamp"].as_str().and_then(parse_iso_ms).unwrap_or(0);
                let text =
                    text_of_blocks(&v["message"]["content"]).filter(|t| !t.trim().is_empty());
                let real = match (&text, kind) {
                    (Some(t), "user") => !claude_noise(t),
                    (Some(_), _) => true,
                    _ => false,
                };
                if ts > 0 {
                    if first_ts == 0 {
                        first_ts = ts;
                    }
                    last_ts = last_ts.max(ts);
                }
                if real {
                    count += 1;
                    if kind == "user" && first_user.is_none() {
                        first_user = text.map(|t| clip(&t, MAX_TITLE_CHARS));
                    }
                }
            }
            _ => {}
        }
    }
    if count == 0 {
        return None;
    }
    let (created, modified) = file_times(path);
    Some(SourceSession {
        id,
        path: path.to_string_lossy().to_string(),
        title: custom.or(summary).or(first_user).unwrap_or_default(),
        project_path: cwd,
        message_count: count,
        created_at: if first_ts > 0 { first_ts } else { created },
        updated_at: if last_ts > 0 { last_ts } else { modified },
        size_bytes: size as i64,
        truncated: size > MAX_SCAN_BYTES,
    })
}

pub fn scan_claude(root: &Path) -> Vec<SourceSession> {
    let mut out = Vec::new();
    let Ok(dirs) = std::fs::read_dir(root) else {
        return out;
    };
    for dir in dirs.flatten().take(MAX_DIRS) {
        let Ok(ft) = dir.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        for f in files.flatten() {
            let p = f.path();
            let name = f.file_name().to_string_lossy().to_string();
            // Sub-agent transcripts (agent-*.jsonl) belong to a parent session; symlinks are never followed.
            if !f.file_type().is_ok_and(|t| t.is_file())
                || !has_jsonl_ext(&p)
                || name.starts_with("agent-")
            {
                continue;
            }
            if let Some(s) = scan_claude_file(&p) {
                out.push(s);
            }
            if out.len() >= MAX_SESSIONS * 4 {
                break;
            }
        }
    }
    finish(out)
}

fn finish(mut v: Vec<SourceSession>) -> Vec<SourceSession> {
    v.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    v.truncate(MAX_SESSIONS);
    v
}

// ---------------------------------------------------------------------------------------------------------------
// Codex CLI: <root>/YYYY/MM/DD/rollout-*.jsonl

fn codex_noise(text: &str) -> bool {
    let t = text.trim_start();
    [
        "<environment_context>",
        "<user_instructions>",
        "<permissions",
        "<collaboration_mode>",
        "<dynamic_tools>",
        "<recommended_plugins>",
        "<turn_aborted>",
        "# AGENTS.md instructions",
        "<INSTRUCTIONS>",
    ]
    .iter()
    .any(|p| t.starts_with(p))
}

pub fn scan_codex_file(path: &Path) -> Option<SourceSession> {
    let file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let mut r = BufReader::with_capacity(64 * 1024, file.take(MAX_SCAN_BYTES));
    let (mut buf, mut over) = (Vec::new(), false);
    let (mut count, mut first_ts, mut last_ts, mut lines) = (0i64, 0i64, 0i64, 0);
    let (mut id, mut cwd, mut first_user) = (None::<String>, None::<String>, None::<String>);
    while let Ok(Some(_)) = read_line_bounded(&mut r, &mut buf, MAX_LINE, &mut over) {
        if over || buf.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(&buf) else {
            continue;
        };
        lines += 1;
        let ts = v["timestamp"].as_str().and_then(parse_iso_ms).unwrap_or(0);
        if ts > 0 {
            if first_ts == 0 {
                first_ts = ts;
            }
            last_ts = last_ts.max(ts);
        }
        let meta = if v["type"] == "session_meta" {
            &v["payload"]
        } else if lines == 1 && v["type"].is_null() {
            &v
        } else {
            &Value::Null
        };
        if !meta.is_null() && id.is_none() {
            // Sub-agent threads (source is an object, or a parent thread is named) belong to their parent session.
            if meta["source"].is_object() || meta["parent_thread_id"].is_string() {
                return None;
            }
            id = meta["id"].as_str().map(String::from);
            cwd = meta["cwd"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(String::from);
            if let Some(t) = meta["timestamp"].as_str().and_then(parse_iso_ms) {
                first_ts = t;
            }
            continue;
        }
        // Current files wrap items in `response_item`; older ones store the item itself.
        let item = match v["type"].as_str() {
            Some("response_item") => &v["payload"],
            Some("message") => &v,
            _ => &Value::Null,
        };
        if item["type"] == "message" {
            let role = item["role"].as_str().unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }
            let text = item["content"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|b| b["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .filter(|t| !t.trim().is_empty());
            let Some(text) = text else { continue };
            if role == "user" && codex_noise(&text) {
                continue;
            }
            count += 1;
            if role == "user" && first_user.is_none() {
                first_user = Some(clip(&text, MAX_TITLE_CHARS));
            }
        }
    }
    if count == 0 {
        return None;
    }
    let (created, modified) = file_times(path);
    let stem = path.file_stem()?.to_string_lossy().to_string();
    Some(SourceSession {
        id: id.unwrap_or(stem),
        path: path.to_string_lossy().to_string(),
        title: first_user.unwrap_or_default(),
        project_path: cwd,
        message_count: count,
        created_at: if first_ts > 0 { first_ts } else { created },
        updated_at: if last_ts > 0 { last_ts } else { modified },
        size_bytes: size as i64,
        truncated: size > MAX_SCAN_BYTES,
    })
}

fn collect_rollouts(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 5 || out.len() >= MAX_SESSIONS * 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let p = e.path();
        if ft.is_dir() {
            collect_rollouts(&p, depth + 1, out);
        } else if ft.is_file()
            && has_jsonl_ext(&p)
            && e.file_name().to_string_lossy().starts_with("rollout-")
        {
            out.push(p);
        }
    }
}

pub fn scan_codex(root: &Path) -> Vec<SourceSession> {
    let mut files = Vec::new();
    collect_rollouts(root, 0, &mut files);
    finish(files.iter().filter_map(|p| scan_codex_file(p)).collect())
}

// ---------------------------------------------------------------------------------------------------------------
// Reading one session file

/// Reads a session file that lives under `root`, at most `MAX_READ_BYTES`, cut at a line boundary.
pub fn read_session(root: &Path, path: &Path) -> Result<SessionText, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "history folder not found".to_string())?;
    let real = path.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&root) || !has_jsonl_ext(&real) {
        return Err("not a session file".into());
    }
    let file = File::open(&real).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("not a session file".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_READ_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let truncated = bytes.len() as u64 > MAX_READ_BYTES;
    if truncated {
        bytes.truncate(MAX_READ_BYTES as usize);
        if let Some(i) = bytes.iter().rposition(|&b| b == b'\n') {
            bytes.truncate(i + 1);
        }
    }
    Ok(SessionText {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// ChatGPT export: one JSON array of conversations, streamed so a huge file never has to fit in memory at once.

struct Count(usize);
impl<'de> Deserialize<'de> for Count {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Count;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a mapping")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<Count, A::Error> {
                #[derive(Deserialize)]
                struct Node {
                    message: Option<IgnoredAny>,
                }
                let mut n = 0;
                while let Some((_, node)) = m.next_entry::<IgnoredAny, Node>()? {
                    if node.message.is_some() {
                        n += 1;
                    }
                }
                Ok(Count(n))
            }
            fn visit_unit<E>(self) -> Result<Count, E> {
                Ok(Count(0))
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Deserialize)]
struct ConvSummary {
    id: Option<String>,
    conversation_id: Option<String>,
    title: Option<String>,
    create_time: Option<f64>,
    update_time: Option<f64>,
    mapping: Option<Count>,
}

fn secs_to_ms(v: Option<f64>) -> i64 {
    match v {
        Some(s) if s.is_finite() && s > 0.0 && s < 8.0e12 => (s * 1000.0) as i64,
        _ => 0,
    }
}

struct EachElement<F>(F);
impl<'de, F: FnMut(Box<RawValue>) -> Result<bool, String>> Visitor<'de> for EachElement<F> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("an array of conversations")
    }
    fn visit_seq<A: SeqAccess<'de>>(mut self, mut seq: A) -> Result<(), A::Error> {
        while let Some(raw) = seq.next_element::<Box<RawValue>>()? {
            match (self.0)(raw) {
                Ok(true) => {}
                // Stopping early leaves the array unfinished; `each_conversation` knows and ignores that error.
                Ok(false) => return Ok(()),
                Err(e) => return Err(serde::de::Error::custom(e)),
            }
        }
        Ok(())
    }
}

fn open_export(path: &Path) -> Result<BufReader<File>, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_EXPORT_BYTES {
        return Err("file too large".into());
    }
    let mut r = BufReader::with_capacity(256 * 1024, File::open(path).map_err(|e| e.to_string())?);
    // Skip a UTF-8 byte order mark.
    if r.fill_buf()
        .map_err(|e| e.to_string())?
        .starts_with(&[0xEF, 0xBB, 0xBF])
    {
        r.consume(3);
    }
    Ok(r)
}

fn each_conversation(
    path: &Path,
    mut f: impl FnMut(Box<RawValue>) -> Result<bool, String>,
) -> Result<(), String> {
    let stopped = std::cell::Cell::new(false);
    let mut seen = 0usize;
    let mut de = serde_json::Deserializer::from_reader(open_export(path)?);
    let result = serde::Deserializer::deserialize_seq(
        &mut de,
        EachElement(|raw: Box<RawValue>| {
            seen += 1;
            let more = seen <= MAX_EXPORT_CONVERSATIONS && f(raw)?;
            stopped.set(!more);
            Ok(more)
        }),
    );
    match result {
        Ok(()) => Ok(()),
        Err(_) if stopped.get() => Ok(()),
        Err(e) => Err(format!("not a ChatGPT conversations.json: {e}")),
    }
}

pub fn scan_chatgpt(path: &Path) -> Result<Vec<SourceSession>, String> {
    let mut out = Vec::new();
    each_conversation(path, |raw| {
        let bytes = raw.get().len() as i64;
        if let Ok(c) = serde_json::from_str::<ConvSummary>(raw.get()) {
            let count = c.mapping.map(|m| m.0).unwrap_or(0) as i64;
            if let (Some(id), true) = (c.id.or(c.conversation_id), count > 0) {
                out.push(SourceSession {
                    id,
                    path: String::new(),
                    title: clip(c.title.as_deref().unwrap_or(""), MAX_TITLE_CHARS),
                    project_path: None,
                    message_count: count,
                    created_at: secs_to_ms(c.create_time),
                    updated_at: secs_to_ms(c.update_time).max(secs_to_ms(c.create_time)),
                    size_bytes: bytes,
                    truncated: bytes as usize > MAX_CONVERSATION_BYTES,
                });
            }
        }
        Ok(true)
    })?;
    Ok(finish(out))
}

/// Returns the raw JSON of the conversations with the given ids, at most `MAX_READ_TOTAL` bytes per call.
pub fn read_chatgpt(path: &Path, ids: &[String]) -> Result<ConversationBatch, String> {
    let mut want: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut batch = ConversationBatch::default();
    let mut total = 0usize;
    each_conversation(path, |raw| {
        if want.is_empty() {
            return Ok(false);
        }
        #[derive(Deserialize)]
        struct Ids {
            id: Option<String>,
            conversation_id: Option<String>,
        }
        let Ok(Ids {
            id,
            conversation_id,
        }) = serde_json::from_str::<Ids>(raw.get())
        else {
            return Ok(true);
        };
        let Some(id) = id.or(conversation_id) else {
            return Ok(true);
        };
        if !want.remove(id.as_str()) {
            return Ok(true);
        }
        let len = raw.get().len();
        if len > MAX_CONVERSATION_BYTES || total + len > MAX_READ_TOTAL {
            batch.skipped.push(id);
        } else {
            total += len;
            batch.conversations.push(raw.get().to_string());
        }
        Ok(!want.is_empty())
    })?;
    Ok(batch)
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

/// `CLAUDE_CONFIG_DIR` wins; else `~/.claude/projects` (also `%USERPROFILE%\.claude` on Windows); on Linux the
/// XDG location `$XDG_CONFIG_HOME/claude/projects` is used when only that one exists.
fn claude_root_in(
    home: &Path,
    config_dir_env: Option<PathBuf>,
    xdg_config: Option<PathBuf>,
) -> PathBuf {
    if let Some(d) = config_dir_env {
        return d.join("projects");
    }
    let default = home.join(".claude").join("projects");
    if !default.is_dir() {
        if let Some(x) = xdg_config
            .map(|c| c.join("claude").join("projects"))
            .filter(|p| p.is_dir())
        {
            return x;
        }
    }
    default
}

fn claude_root() -> PathBuf {
    let env = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    claude_root_in(&home(), env, dirs::config_dir())
}

fn codex_root() -> PathBuf {
    match std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        Some(d) => PathBuf::from(d).join("sessions"),
        None => home().join(".codex/sessions"),
    }
}

fn root_for(source: &str) -> Result<PathBuf, String> {
    match source {
        "claude" => Ok(claude_root()),
        "codex" => Ok(codex_root()),
        _ => Err("unknown source".into()),
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// Lists sessions of `source` ("claude" or "codex") found in its history folder.
#[tauri::command]
pub async fn import_scan(source: String) -> Result<Vec<SourceSession>, String> {
    let root = root_for(&source)?;
    blocking(move || {
        Ok(if source == "claude" {
            scan_claude(&root)
        } else {
            scan_codex(&root)
        })
    })
    .await
}

/// Raw text of one session file of `source`; the path must be inside that source's history folder.
#[tauri::command]
pub async fn import_read_session(source: String, path: String) -> Result<SessionText, String> {
    let root = root_for(&source)?;
    blocking(move || read_session(&root, Path::new(&path))).await
}

/// Summaries of the conversations in a ChatGPT export file the user picked.
#[tauri::command]
pub async fn import_chatgpt_scan(path: String) -> Result<Vec<SourceSession>, String> {
    blocking(move || scan_chatgpt(Path::new(&path))).await
}

/// Raw JSON of selected conversations of a ChatGPT export file the user picked.
#[tauri::command]
pub async fn import_chatgpt_read(
    path: String,
    ids: Vec<String>,
) -> Result<ConversationBatch, String> {
    blocking(move || read_chatgpt(Path::new(&path), &ids)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(p: &Path, lines: &[&str]) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, lines.join("\n") + "\n").unwrap();
    }

    #[test]
    fn claude_root_resolution() {
        let home = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let default = home.path().join(".claude").join("projects");
        // Nothing exists: the default location.
        assert_eq!(
            claude_root_in(home.path(), None, Some(xdg.path().to_path_buf())),
            default
        );
        // Only the XDG location exists.
        let x = xdg.path().join("claude").join("projects");
        fs::create_dir_all(&x).unwrap();
        assert_eq!(
            claude_root_in(home.path(), None, Some(xdg.path().to_path_buf())),
            x
        );
        // The default wins when both exist.
        fs::create_dir_all(&default).unwrap();
        assert_eq!(
            claude_root_in(home.path(), None, Some(xdg.path().to_path_buf())),
            default
        );
        // An explicit CLAUDE_CONFIG_DIR wins over everything.
        let explicit = PathBuf::from("custom");
        assert_eq!(
            claude_root_in(home.path(), Some(explicit.clone()), None),
            explicit.join("projects")
        );
    }

    #[test]
    fn iso_times() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_iso_ms("2026-01-05T09:00:00.250Z"),
            Some(1_767_603_600_250)
        );
        assert_eq!(
            parse_iso_ms("2026-01-05T11:00:00+02:00"),
            Some(1_767_603_600_000)
        );
        assert_eq!(
            parse_iso_ms("2026-01-05T09:00:00.1Z"),
            Some(1_767_603_600_100)
        );
        assert_eq!(parse_iso_ms("nonsense"), None);
        assert_eq!(parse_iso_ms("2026-13-05T09:00:00Z"), None);
    }

    #[test]
    fn bounded_lines_skip_huge_ones() {
        let mut data = b"short\n".to_vec();
        data.extend(std::iter::repeat(b'x').take(100));
        data.extend(b"\nlast");
        let mut r = BufReader::with_capacity(8, &data[..]);
        let (mut buf, mut over) = (Vec::new(), false);
        assert!(read_line_bounded(&mut r, &mut buf, 20, &mut over)
            .unwrap()
            .is_some());
        assert_eq!((buf.as_slice(), over), (&b"short"[..], false));
        assert!(read_line_bounded(&mut r, &mut buf, 20, &mut over)
            .unwrap()
            .is_some());
        assert!(over && buf.is_empty());
        assert!(read_line_bounded(&mut r, &mut buf, 20, &mut over)
            .unwrap()
            .is_some());
        assert_eq!((buf.as_slice(), over), (&b"last"[..], false));
        assert!(read_line_bounded(&mut r, &mut buf, 20, &mut over)
            .unwrap()
            .is_none());
    }

    #[test]
    fn scans_claude_projects() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("projects");
        write(
            &root.join("-tmp-demo/s1.jsonl"),
            &[
                r#"{"type":"queue-operation","operation":"enqueue"}"#,
                r#"{"type":"user","isSidechain":false,"sessionId":"sess-1","cwd":"/tmp/demo","timestamp":"2026-01-05T09:00:00.000Z","message":{"role":"user","content":"Fix the build"}}"#,
                r#"this line is not json"#,
                r#"{"type":"assistant","isSidechain":false,"timestamp":"2026-01-05T09:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Looking."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#,
                r#"{"type":"user","timestamp":"2026-01-05T09:00:06.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
                r#"{"type":"user","isSidechain":true,"timestamp":"2026-01-05T09:00:07.000Z","message":{"role":"user","content":"sub agent chatter"}}"#,
                r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"meta"}}"#,
                r#"{"type":"user","timestamp":"2026-01-05T09:01:00.000Z","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#,
            ],
        );
        write(
            &root.join("-tmp-demo/agent-abc.jsonl"),
            &[r#"{"type":"user","message":{"role":"user","content":"x"}}"#],
        );
        write(
            &root.join("-tmp-demo/empty.jsonl"),
            &[r#"{"type":"summary","summary":"only a summary"}"#],
        );
        write(&root.join("-tmp-demo/notes.txt"), &["hello"]);
        write(
            &root.join("-tmp-other/s2.jsonl"),
            &[
                r#"{"type":"custom-title","customTitle":"Named session","sessionId":"sess-2"}"#,
                r#"{"type":"user","sessionId":"sess-2","cwd":"/tmp/other","timestamp":"2026-02-01T00:00:00Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}"#,
            ],
        );
        let found = scan_claude(&root);
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(found[0].id, "sess-2");
        assert_eq!(found[0].title, "Named session");
        assert_eq!(found[0].project_path.as_deref(), Some("/tmp/other"));
        let s1 = &found[1];
        assert_eq!(
            (s1.id.as_str(), s1.title.as_str(), s1.message_count),
            ("sess-1", "Fix the build", 2)
        );
        assert_eq!(s1.project_path.as_deref(), Some("/tmp/demo"));
        assert_eq!(s1.created_at, 1_767_603_600_000);
        assert_eq!(s1.updated_at, 1_767_603_600_000 + 60_000);
        assert!(!s1.truncated);
    }

    #[test]
    fn huge_claude_line_is_skipped_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("p/s.jsonl");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut body = String::from(
            r#"{"type":"user","cwd":"/a","timestamp":"2026-01-05T09:00:00Z","message":{"role":"user","content":"first"}}"#,
        );
        body.push('\n');
        body.push_str(&format!(
            r#"{{"type":"user","message":{{"role":"user","content":"{}"}}}}"#,
            "y".repeat(MAX_LINE + 10)
        ));
        body.push('\n');
        body.push_str(r#"{"type":"assistant","timestamp":"2026-01-05T09:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}"#);
        fs::write(&p, body).unwrap();
        let s = scan_claude_file(&p).unwrap();
        assert_eq!(s.message_count, 2);
    }

    #[test]
    fn scans_codex_rollouts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        write(
            &root.join("2026/01/05/rollout-2026-01-05T09-00-00-abc.jsonl"),
            &[
                r#"{"timestamp":"2026-01-05T09:00:00.000Z","type":"session_meta","payload":{"id":"codex-1","cwd":"/tmp/work","timestamp":"2026-01-05T09:00:00.000Z","source":"cli"}}"#,
                r#"{"timestamp":"2026-01-05T09:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n<cwd>/tmp/work</cwd>\n</environment_context>"}]}}"#,
                r#"{"timestamp":"2026-01-05T09:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Add a test"}]}}"#,
                r#"{"timestamp":"2026-01-05T09:00:03.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}","call_id":"c1"}}"#,
                r#"{"timestamp":"2026-01-05T09:00:04.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Added."}]}}"#,
                r#"{"timestamp":"2026-01-05T09:00:05.000Z","type":"event_msg","payload":{"type":"agent_message","message":"duplicate"}}"#,
                "{broken",
            ],
        );
        write(
            &root.join("2026/01/05/rollout-sub.jsonl"),
            &[
                r#"{"timestamp":"2026-01-05T09:00:00.000Z","type":"session_meta","payload":{"id":"sub","cwd":"/x","source":{"subagent":{"other":"guardian"}}}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}"#,
            ],
        );
        write(
            &root.join("2026/01/05/other.jsonl"),
            &[r#"{"type":"session_meta","payload":{"id":"zzz"}}"#],
        );
        // Older format: the first line carries the id, with no type.
        write(
            &root.join("2025/rollout-legacy.jsonl"),
            &[
                r#"{"id":"legacy-1","timestamp":"2025-05-01T10:00:00.000Z","instructions":"x"}"#,
                r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"old"}]}"#,
            ],
        );
        let found = scan_codex(&root);
        // The sub-agent thread and the file without a rollout- name are left out.
        assert_eq!(found.len(), 2, "{found:?}");
        let s = &found[0];
        assert_eq!(
            (s.id.as_str(), s.title.as_str(), s.message_count),
            ("codex-1", "Add a test", 2)
        );
        assert_eq!(s.project_path.as_deref(), Some("/tmp/work"));
        assert_eq!(s.updated_at, 1_767_603_600_000 + 5000);
        assert_eq!(
            (
                found[1].id.as_str(),
                found[1].title.as_str(),
                found[1].message_count
            ),
            ("legacy-1", "old", 1)
        );
    }

    #[test]
    fn reads_only_inside_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("projects");
        write(&root.join("a/s.jsonl"), &["{}"]);
        write(&dir.path().join("outside.jsonl"), &["{}"]);
        write(&root.join("a/notes.txt"), &["x"]);
        assert_eq!(
            read_session(&root, &root.join("a/s.jsonl")).unwrap().text,
            "{}\n"
        );
        assert!(read_session(&root, &dir.path().join("outside.jsonl")).is_err());
        assert!(read_session(&root, &root.join("a/../../outside.jsonl")).is_err());
        assert!(read_session(&root, &root.join("a/notes.txt")).is_err());
        assert!(read_session(&root, &root.join("missing.jsonl")).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("outside.jsonl"), root.join("a/link.jsonl"))
                .unwrap();
            assert!(read_session(&root, &root.join("a/link.jsonl")).is_err());
        }
    }

    fn export_file(dir: &Path) -> PathBuf {
        let p = dir.join("conversations.json");
        fs::write(
            &p,
            r#"[
 {"id":"c1","title":"First chat","create_time":1767603600.5,"update_time":1767603700,
  "mapping":{"root":{"id":"root","message":null,"parent":null,"children":["a"]},
             "a":{"id":"a","message":{"author":{"role":"user"},"content":{"content_type":"text","parts":["hi"]}},"parent":"root","children":[]}}},
 {"conversation_id":"c2","title":null,"create_time":1767603800,"mapping":{"n":{"message":{"author":{"role":"user"}}}}},
 {"id":"c3","title":"Empty","mapping":{}},
 {"title":"No id","mapping":{"n":{"message":{}}}}
]"#,
        )
        .unwrap();
        p
    }

    #[test]
    fn scans_and_reads_chatgpt_export() {
        let dir = tempfile::tempdir().unwrap();
        let p = export_file(dir.path());
        let found = scan_chatgpt(&p).unwrap();
        assert_eq!(
            found.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["c2", "c1"]
        );
        let c1 = found.iter().find(|s| s.id == "c1").unwrap();
        assert_eq!(
            (
                c1.title.as_str(),
                c1.message_count,
                c1.created_at,
                c1.updated_at
            ),
            ("First chat", 1, 1_767_603_600_500, 1_767_603_700_000)
        );
        let batch = read_chatgpt(&p, &["c2".to_string(), "nope".to_string()]).unwrap();
        assert_eq!(batch.conversations.len(), 1);
        assert!(batch.conversations[0].contains("\"conversation_id\":\"c2\""));
        assert!(batch.skipped.is_empty());
    }

    #[test]
    fn rejects_non_array_exports_and_handles_bom() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.json");
        fs::write(&p, r#"{"not":"an array"}"#).unwrap();
        assert!(scan_chatgpt(&p).is_err());
        fs::write(&p, "not json at all").unwrap();
        assert!(scan_chatgpt(&p).is_err());
        assert!(scan_chatgpt(&dir.path().join("missing.json")).is_err());
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend(br#"[{"id":"b","title":"t","mapping":{"n":{"message":{}}}}]"#);
        fs::write(&p, bom).unwrap();
        assert_eq!(scan_chatgpt(&p).unwrap().len(), 1);
    }
}
