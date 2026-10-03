//! Live view of the subagents of a Codex run, read from Codex's own session files.
//!
//! `codex exec --json` does not report spawned agents, but Codex writes every thread to
//! `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl` while it runs. The parent thread's file holds
//! the `spawn_agent` calls; every child agent is a file of its own whose first `session_meta` names its parent.
//! `codex_agents_scan` reads those files incrementally (per-file byte offsets and parsed state are cached) and returns
//! one summary per agent. Read-only and defensive: only files under the sessions folder, symlinks are never followed,
//! unknown or malformed lines are skipped, and the result is bounded (50 agents, 4 MB per file per call).
//! The file format belongs to Codex and may change between versions; anything unexpected becomes a `notes` entry.

use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// At most this much of one file is read per scan; the rest follows on the next one.
const MAX_READ: u64 = 4 * 1024 * 1024;
/// A line longer than this is skipped unparsed.
const MAX_LINE: usize = 1024 * 1024;
const MAX_AGENTS: usize = 50;
/// Newest files of one day folder that are looked at.
const MAX_DAY_FILES: usize = 1000;
/// First lines read per scan from files not seen before.
const MAX_HEADS_PER_SCAN: usize = 400;
const MAX_CACHE: usize = 600;
const MAX_DAYS: i64 = 8;
/// A child file is written after the run started; a little slack for clock rounding.
const SLACK_MS: i64 = 5_000;
const MAX_NOTES: usize = 8;
const SUMMARY_CHARS: usize = 300;
const REPORT_CHARS: usize = 4000;
const STEP_CHARS: usize = 120;

/// Lines that cannot matter are not parsed (messages, world state, turn context make most of a rollout).
const RELEVANT: [&str; 9] = ["session_meta", "task_started", "task_complete", "token_count", "custom_tool_call", "function_call", "turn_aborted", "\"error\"", "shutdown"];
/// Model-facing tools that steer agents; they are not the agent's own work.
const CONTROL_TOOLS: [&str; 10] = ["spawn_agent", "wait_agent", "send_input", "send_message", "followup_task", "resume_agent", "close_agent", "interrupt_agent", "list_agents", "update_plan"];

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cached: u64,
    pub reasoning: u64,
    pub total: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    /// The agent's thread id; `pending:<parent>:<task>` while only the `spawn_agent` call exists.
    pub id: String,
    /// Stable across polls (the pending entry and the later thread are the same agent): `<parent thread>:<task name>`, else the thread id.
    pub key: String,
    pub thread_id: Option<String>,
    pub parent_thread_id: String,
    pub depth: u32,
    pub nickname: Option<String>,
    pub agent_path: Option<String>,
    pub task_name: Option<String>,
    pub role: Option<String>,
    /// The `message` of the `spawn_agent` call, clipped.
    pub message: Option<String>,
    /// starting | running | completed | failed | shutdown
    pub state: String,
    pub started_at_ms: Option<i64>,
    pub ended_at_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub last_message: Option<String>,
    pub error: Option<String>,
    pub tool_uses: u32,
    pub step: Option<String>,
    pub tokens: Tokens,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub parent_found: bool,
    pub agents: Vec<Agent>,
    /// More than 50 agents existed.
    pub truncated: bool,
    /// Short debug notes (unexpected format, unreadable lines); shown in the raw CLI log, never to the user.
    pub notes: Vec<String>,
}

// ---- pure helpers ----

fn is_id(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
}

fn clip(s: &str, n: usize) -> String {
    let t = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= n {
        t
    } else {
        let mut o: String = t.chars().take(n.saturating_sub(1)).collect();
        o.push('…');
        o
    }
}

/// Like `clip` but keeps line breaks (a report).
fn clip_text(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        t.to_string()
    } else {
        let mut o: String = t.chars().take(n.saturating_sub(1)).collect();
        o.push('…');
        o
    }
}

fn secret_patterns() -> &'static Vec<(Regex, &'static str)> {
    static P: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    P.get_or_init(|| {
        [
            (r"(?i)(api[_-]?key|token|secret|passw(?:or)?d|authorization|auth)(\s*[=:]\s*)[^\s'\x22&;]+", "${1}${2}***"),
            (r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{8,}", "Bearer ***"),
            (r"\bsk-[A-Za-z0-9_-]{16,}", "sk-***"),
            (r"\bgh[pousr]_[A-Za-z0-9]{20,}", "gh_***"),
            (r"\bAKIA[0-9A-Z]{16}\b", "AKIA***"),
            (r"://[^/\s:@]+:[^/\s@]+@", "://***@"),
        ]
        .into_iter()
        .filter_map(|(re, to)| Regex::new(re).ok().map(|r| (r, to)))
        .collect()
    })
}

/// Obvious secrets (key=value pairs, bearer tokens, common key formats, URL credentials) replaced by `***`.
pub fn redact(s: &str) -> String {
    let mut out = s.to_string();
    for (re, to) in secret_patterns() {
        out = re.replace_all(&out, *to).into_owned();
    }
    out
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `2026-10-03T15:49:41.123Z` to Unix milliseconds (UTC; an offset other than Z is not expected and reads as None).
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut ms = 0;
    let mut i = 19;
    if b[i] == b'.' {
        let mut digits = 0;
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            if digits < 3 {
                ms = ms * 10 + (b[i] - b'0') as i64;
                digits += 1;
            }
            i += 1;
        }
        while digits < 3 {
            ms *= 10;
            digits += 1;
        }
    }
    if s.get(i..)? != "Z" {
        return None;
    }
    Some(((days_from_civil(y, mo, d) * 24 + h) * 60 + mi) * 60_000 + se * 1000 + ms)
}

/// Day folders (`YYYY/MM/DD`) that can hold files of a run started at `start_ms` and still going at `now_ms`:
/// one day before the start (folders follow local or UTC time) to one day after now, at most `MAX_DAYS`.
fn day_dirs(start_ms: i64, now_ms: i64) -> Vec<(i64, i64, i64)> {
    let first = start_ms.div_euclid(86_400_000) - 1;
    let last = (now_ms.max(start_ms)).div_euclid(86_400_000) + 1;
    let first = first.max(last - (MAX_DAYS - 1));
    (first..=last).rev().map(civil_from_days).collect()
}

/// The command text of an `exec` call: Codex's code-mode tool takes JavaScript such as
/// `text(await tools.exec_command({cmd:"ls -la", ...}))`; anything else reads as its own text.
fn exec_text(input: &str) -> String {
    let find = |key: &str| input.find(key).map(|i| i + key.len());
    let start = find("cmd:").or_else(|| find("\"cmd\":")).or_else(|| find("cmd :"));
    if let Some(mut i) = start {
        let b = input.as_bytes();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < b.len() && matches!(b[i], b'"' | b'\'' | b'`') {
            let quote = b[i] as char;
            let mut out = String::new();
            let mut chars = input[i + 1..].chars();
            while let Some(c) = chars.next() {
                match c {
                    '\\' => match chars.next() {
                        Some('n') | Some('t') | Some('r') => out.push(' '),
                        Some(o) => out.push(o),
                        None => break,
                    },
                    c if c == quote => return out,
                    c => out.push(c),
                }
            }
            if !out.is_empty() {
                return out;
            }
        }
    }
    input.to_string()
}

/// What an agent is doing, for one line: the command (secrets removed) or the tool name.
fn describe_step(name: &str, input: &str) -> String {
    let text = if name == "exec" { exec_text(input) } else { name.to_string() };
    clip(&redact(&text), STEP_CHARS)
}

// ---- per-file state ----

#[derive(Debug, Clone, Default)]
struct Meta {
    id: String,
    parent: Option<String>,
    nickname: Option<String>,
    agent_path: Option<String>,
    role: Option<String>,
    depth: u32,
    created_ms: Option<i64>,
}

#[derive(Debug, Clone, Default)]
struct Spawn {
    call_id: String,
    task_name: String,
    message: String,
    ts: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
enum Life {
    #[default]
    None,
    Started,
    Complete,
    Error,
    Shutdown,
}

#[derive(Debug, Default)]
struct FileState {
    offset: u64,
    skipping: bool,
    head_done: bool,
    meta: Option<Meta>,
    start_ordinal: i64,
    spawns: Vec<Spawn>,
    life: Life,
    first_started_ms: Option<i64>,
    ended_ms: Option<i64>,
    duration_ms: Option<i64>,
    last_message: Option<String>,
    error: Option<String>,
    tool_uses: u32,
    step: Option<String>,
    tokens: Tokens,
    bad_lines: u32,
    last_used: u64,
}

fn s(v: &Value) -> Option<String> {
    v.as_str().filter(|x| !x.is_empty()).map(String::from)
}

/// Unix seconds (or milliseconds) to milliseconds.
fn secs_to_ms(v: &Value) -> Option<i64> {
    v.as_i64().map(|n| if n > 100_000_000_000 { n } else { n * 1000 })
}

fn parse_meta(p: &Value) -> Option<Meta> {
    let spawn = &p["source"]["subagent"]["thread_spawn"];
    let id = s(&p["id"])?;
    if !is_id(&id) {
        return None;
    }
    let parent = s(&p["parent_thread_id"]).or_else(|| s(&spawn["parent_thread_id"])).filter(|x| is_id(x));
    Some(Meta {
        id,
        parent,
        nickname: s(&p["agent_nickname"]).or_else(|| s(&spawn["agent_nickname"])),
        agent_path: s(&p["agent_path"]).or_else(|| s(&spawn["agent_path"])),
        role: s(&spawn["agent_role"]),
        depth: spawn["depth"].as_u64().unwrap_or(1) as u32,
        created_ms: s(&p["timestamp"]).and_then(|t| parse_iso_ms(&t)),
    })
}

/// A tool output is a string, or a list of `{text}` parts.
fn output_text(v: &Value) -> String {
    match v {
        Value::String(t) => t.clone(),
        Value::Array(a) => a.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn ingest(st: &mut FileState, line: &str) {
    if !RELEVANT.iter().any(|k| line.contains(k)) {
        return;
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            st.bad_lines += 1;
            return;
        }
    };
    let p = &v["payload"];
    let ty = v["type"].as_str().unwrap_or("");
    if ty == "session_meta" {
        // A forked child repeats its parent's session_meta afterwards; the first one is its own.
        if st.meta.is_none() {
            st.meta = parse_meta(p);
            st.start_ordinal = p["subagent_history_start_ordinal"].as_i64().unwrap_or(0);
        }
        return;
    }
    // Entries copied from the parent's history (forked children) are not this agent's work.
    if v["ordinal"].as_i64().is_some_and(|o| o < st.start_ordinal) {
        return;
    }
    let ts = v["timestamp"].as_str().and_then(parse_iso_ms);
    let pty = p["type"].as_str().unwrap_or("");
    match (ty, pty) {
        ("event_msg", "task_started") => {
            let started = secs_to_ms(&p["started_at"]).or(ts);
            st.life = Life::Started;
            st.first_started_ms = st.first_started_ms.or(started);
            st.ended_ms = None;
            st.duration_ms = None;
            st.error = None;
        }
        ("event_msg", "task_complete") => {
            st.life = Life::Complete;
            st.ended_ms = secs_to_ms(&p["completed_at"]).or(ts);
            st.duration_ms = p["duration_ms"].as_i64();
            if let Some(m) = s(&p["last_agent_message"]) {
                st.last_message = Some(clip_text(&redact(&m), REPORT_CHARS));
            }
        }
        ("event_msg", "error") | ("event_msg", "turn_aborted") => {
            st.life = Life::Error;
            st.ended_ms = ts;
            st.error = Some(clip(&redact(&s(&p["message"]).or_else(|| s(&p["reason"])).unwrap_or_else(|| pty.to_string())), SUMMARY_CHARS));
        }
        ("event_msg", "shutdown_complete") => {
            st.life = Life::Shutdown;
            st.ended_ms = ts;
        }
        ("event_msg", "token_count") => {
            let u = &p["info"]["total_token_usage"];
            if u.is_object() {
                let n = |k: &str| u[k].as_u64().unwrap_or(0);
                st.tokens = Tokens { input: n("input_tokens"), output: n("output_tokens"), cached: n("cached_input_tokens"), reasoning: n("reasoning_output_tokens"), total: n("total_tokens") };
            }
        }
        ("response_item", "custom_tool_call") => {
            st.tool_uses += 1;
            let name = p["name"].as_str().unwrap_or("tool");
            st.step = Some(describe_step(name, p["input"].as_str().unwrap_or("")));
        }
        ("response_item", "function_call") => {
            let name = p["name"].as_str().unwrap_or("");
            if name == "spawn_agent" {
                let a: Value = p["arguments"].as_str().and_then(|x| serde_json::from_str(x).ok()).unwrap_or(Value::Null);
                if let Some(task_name) = s(&a["task_name"]).or_else(|| s(&a["name"])) {
                    st.spawns.push(Spawn {
                        call_id: p["call_id"].as_str().unwrap_or("").to_string(),
                        task_name,
                        message: clip(&redact(&s(&a["message"]).or_else(|| s(&a["prompt"])).unwrap_or_default()), SUMMARY_CHARS),
                        ts,
                    });
                }
            } else if !name.is_empty() && !CONTROL_TOOLS.contains(&name) {
                st.tool_uses += 1;
                st.step = Some(clip(name, STEP_CHARS));
            }
        }
        ("response_item", "function_call_output") => {
            // The call's own answer names the task it created (it wins over the arguments).
            let call = p["call_id"].as_str().unwrap_or("");
            if let Some(sp) = st.spawns.iter_mut().find(|x| !x.call_id.is_empty() && x.call_id == call) {
                let text = output_text(&p["output"]);
                if let Some(t) = serde_json::from_str::<Value>(&text).ok().and_then(|o| s(&o["task_name"])) {
                    sp.task_name = t;
                }
            }
        }
        _ => {}
    }
}

fn open_nofollow(path: &Path) -> std::io::Result<File> {
    let mut o = OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW);
    }
    o.open(path)
}

/// Reads what was appended since the last call (at most `MAX_READ`), up to the last complete line. `head_only` stops after
/// the first line, which is all that is needed to tell whether a file belongs to the run.
fn refresh(path: &Path, st: &mut FileState, head_only: bool) {
    if head_only && st.head_done {
        return;
    }
    let md = match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_file() && !m.file_type().is_symlink() => m,
        _ => return,
    };
    let len = md.len();
    if len < st.offset {
        let used = st.last_used;
        *st = FileState { last_used: used, ..Default::default() };
    }
    if len == st.offset {
        return;
    }
    let Ok(mut f) = open_nofollow(path) else { return };
    if !f.metadata().map(|m| m.is_file()).unwrap_or(false) || f.seek(SeekFrom::Start(st.offset)).is_err() {
        return;
    }
    let mut buf = Vec::new();
    if f.take(MAX_READ).read_to_end(&mut buf).is_err() {
        return;
    }
    let mut pos = 0usize;
    while pos < buf.len() {
        match buf[pos..].iter().position(|&c| c == b'\n') {
            Some(i) => {
                let line = &buf[pos..pos + i];
                pos += i + 1;
                if st.skipping {
                    st.skipping = false;
                } else if line.len() <= MAX_LINE {
                    ingest(st, &String::from_utf8_lossy(line));
                }
                st.head_done = true;
                if head_only {
                    break;
                }
            }
            None => {
                if st.skipping || buf.len() - pos > MAX_LINE {
                    st.skipping = true;
                    pos = buf.len();
                }
                break;
            }
        }
    }
    st.offset += pos as u64;
}

// ---- scan ----

type Cache = HashMap<PathBuf, FileState>;

fn real_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.is_dir() && !m.file_type().is_symlink()).unwrap_or(false)
}

fn rollout_name(n: &str) -> bool {
    n.starts_with("rollout-") && n.ends_with(".jsonl") && n.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

fn mtime_ms(m: &std::fs::Metadata) -> i64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Rollout files of the given day folders, newest name first, bounded per folder; symlinks are ignored.
fn candidates(root: &Path, days: &[(i64, i64, i64)], min_mtime: Option<i64>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for (y, m, d) in days {
        let dir = root.join(format!("{y:04}")).join(format!("{m:02}")).join(format!("{d:02}"));
        if !real_dir(root) || !real_dir(&root.join(format!("{y:04}"))) || !real_dir(&root.join(format!("{y:04}")).join(format!("{m:02}"))) || !real_dir(&dir) {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut names: Vec<(String, std::fs::Metadata)> = rd
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                let md = std::fs::symlink_metadata(e.path()).ok()?;
                (rollout_name(&name) && md.is_file() && !md.file_type().is_symlink()).then_some((name, md))
            })
            .collect();
        names.sort_by(|a, b| b.0.cmp(&a.0));
        names.truncate(MAX_DAY_FILES);
        out.extend(names.into_iter().filter(|(_, md)| min_mtime.is_none_or(|t| mtime_ms(md) >= t)).map(|(n, _)| dir.join(n)));
    }
    out
}

fn short(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().chars().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect()).unwrap_or_default()
}

fn task_matches(path: &str, task: &str) -> bool {
    path == task || path.ends_with(&format!("/{task}"))
}

/// Scans one run: `thread_id` is the thread id of the run's `thread.started`, `start_ms` when the run began.
pub fn scan_in(root: &Path, thread_id: &str, start_ms: Option<i64>, now_ms: i64, cache: &mut Cache, tick: u64) -> Result<ScanResult, String> {
    if !is_id(thread_id) {
        return Err("invalid thread id".into());
    }
    let mut res = ScanResult::default();
    let root = match std::fs::canonicalize(root) {
        Ok(r) if r.is_dir() => r,
        _ => {
            res.notes.push("sessions folder not found".into());
            return Ok(res);
        }
    };
    let start = start_ms.unwrap_or(now_ms - 3_600_000);
    let files = candidates(&root, &day_dirs(start, now_ms), start_ms.map(|t| t - SLACK_MS));
    let suffix = format!("-{thread_id}.jsonl");
    let parent_path = files.iter().find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().ends_with(&suffix))).cloned();
    let mut note = |res: &mut ScanResult, t: String| {
        if res.notes.len() < MAX_NOTES && !res.notes.contains(&t) {
            res.notes.push(t);
        }
    };

    // First lines of files not seen before (which thread, whose child).
    let mut heads = 0;
    for p in &files {
        if Some(p) == parent_path.as_ref() {
            continue;
        }
        let known = cache.get(p).is_some_and(|s| s.head_done);
        if !known {
            if heads >= MAX_HEADS_PER_SCAN {
                note(&mut res, "too many new rollout files; some were not checked".into());
                break;
            }
            heads += 1;
        }
        let st = cache.entry(p.clone()).or_default();
        st.last_used = tick;
        refresh(p, st, true);
    }

    // Children by parent chain.
    let mut tree: HashSet<String> = HashSet::from([thread_id.to_string()]);
    let mut kids: Vec<PathBuf> = Vec::new();
    loop {
        let before = tree.len();
        for p in &files {
            if kids.contains(p) || Some(p) == parent_path.as_ref() {
                continue;
            }
            if let Some(m) = cache.get(p).and_then(|s| s.meta.as_ref()) {
                if m.parent.as_ref().is_some_and(|x| tree.contains(x)) && m.id != thread_id {
                    tree.insert(m.id.clone());
                    kids.push(p.clone());
                }
            }
        }
        if tree.len() == before {
            break;
        }
    }

    // Full incremental read of the parent and the children.
    let mut node_of: HashMap<String, PathBuf> = HashMap::new();
    if let Some(p) = &parent_path {
        let st = cache.entry(p.clone()).or_default();
        st.last_used = tick;
        refresh(p, st, false);
        if st.meta.is_none() {
            note(&mut res, format!("{}: no session_meta (rollout format changed?)", short(p)));
        }
        res.parent_found = true;
        node_of.insert(thread_id.to_string(), p.clone());
    } else {
        note(&mut res, "parent rollout not found".into());
    }
    for p in &kids {
        let st = cache.get_mut(p).expect("cached");
        refresh(p, st, false);
        if let Some(m) = &st.meta {
            node_of.insert(m.id.clone(), p.clone());
        }
        if st.bad_lines > 0 {
            let n = st.bad_lines;
            note(&mut res, format!("{}: {n} unreadable line(s)", short(p)));
        }
    }
    if let Some(st) = parent_path.as_ref().and_then(|p| cache.get(p)) {
        if st.bad_lines > 0 {
            let n = st.bad_lines;
            note(&mut res, format!("parent rollout: {n} unreadable line(s)"));
        }
    }

    // Agents: one per child file, plus one per spawn call that has no child yet.
    let mut agents: Vec<(i64, Agent)> = Vec::new();
    let mut claimed: HashSet<(String, usize)> = HashSet::new();
    let mut order: Vec<&PathBuf> = kids.iter().collect();
    order.sort_by_key(|p| cache.get(*p).and_then(|s| s.meta.as_ref()).and_then(|m| m.created_ms).unwrap_or(0));
    for p in order {
        let st = &cache[p];
        let Some(m) = &st.meta else { continue };
        let parent = m.parent.clone().unwrap_or_default();
        let mut spawn: Option<&Spawn> = None;
        if let (Some(path), Some(pst)) = (&m.agent_path, node_of.get(&parent).and_then(|pp| cache.get(pp))) {
            if let Some((i, sp)) = pst.spawns.iter().enumerate().find(|(i, sp)| !claimed.contains(&(parent.clone(), *i)) && task_matches(path, &sp.task_name)) {
                claimed.insert((parent.clone(), i));
                spawn = Some(sp);
            }
        }
        let state = match st.life {
            Life::None => "starting",
            Life::Started => "running",
            Life::Complete => "completed",
            Life::Error => "failed",
            Life::Shutdown => "shutdown",
        };
        let started = st.first_started_ms.or(m.created_ms).or(spawn.and_then(|x| x.ts));
        agents.push((
            started.unwrap_or(0),
            Agent {
                id: m.id.clone(),
                key: spawn.map(|x| format!("{parent}:{}", x.task_name)).unwrap_or_else(|| m.id.clone()),
                thread_id: Some(m.id.clone()),
                parent_thread_id: parent,
                depth: m.depth,
                nickname: m.nickname.clone(),
                agent_path: m.agent_path.clone(),
                task_name: spawn.map(|x| x.task_name.clone()),
                role: m.role.clone(),
                message: spawn.map(|x| x.message.clone()).filter(|x| !x.is_empty()),
                state: state.into(),
                started_at_ms: started,
                ended_at_ms: st.ended_ms,
                duration_ms: st.duration_ms,
                last_message: st.last_message.clone(),
                error: st.error.clone(),
                tool_uses: st.tool_uses,
                step: st.step.clone(),
                tokens: st.tokens.clone(),
            },
        ));
    }
    let mut owners: Vec<(&String, &PathBuf)> = node_of.iter().collect();
    owners.sort();
    for (owner, p) in owners {
        for (i, sp) in cache[p].spawns.iter().enumerate() {
            if claimed.contains(&(owner.clone(), i)) {
                continue;
            }
            agents.push((
                sp.ts.unwrap_or(i64::MAX),
                Agent {
                    id: format!("pending:{owner}:{}", sp.task_name),
                    key: format!("{owner}:{}", sp.task_name),
                    thread_id: None,
                    parent_thread_id: owner.clone(),
                    depth: 1,
                    nickname: None,
                    agent_path: None,
                    task_name: Some(sp.task_name.clone()),
                    role: None,
                    message: Some(sp.message.clone()).filter(|x| !x.is_empty()),
                    state: "starting".into(),
                    started_at_ms: sp.ts,
                    ended_at_ms: None,
                    duration_ms: None,
                    last_message: None,
                    error: None,
                    tool_uses: 0,
                    step: None,
                    tokens: Tokens::default(),
                },
            ));
        }
    }
    agents.sort_by_key(|(t, _)| *t);
    res.truncated = agents.len() > MAX_AGENTS;
    res.agents = agents.into_iter().take(MAX_AGENTS).map(|(_, a)| a).collect();

    // Forget files that were not looked at for a long time.
    if cache.len() > MAX_CACHE {
        let mut by_use: Vec<(u64, PathBuf)> = cache.iter().map(|(p, s)| (s.last_used, p.clone())).collect();
        by_use.sort();
        for (_, p) in by_use.into_iter().take(cache.len() - MAX_CACHE / 2) {
            cache.remove(&p);
        }
    }
    Ok(res)
}

fn sessions_root() -> Option<PathBuf> {
    match std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        Some(d) => Some(PathBuf::from(d).join("sessions")),
        None => dirs::home_dir().map(|h| h.join(".codex").join("sessions")),
    }
}

fn global() -> &'static Mutex<(Cache, u64)> {
    static C: OnceLock<Mutex<(Cache, u64)>> = OnceLock::new();
    C.get_or_init(|| Mutex::new((HashMap::new(), 0)))
}

/// Subagents of the Codex run with this thread id (`thread.started`), from its rollout files. `started_at` is when the run
/// began (Unix ms), which limits the day folders and files that are looked at.
#[tauri::command]
pub async fn codex_agents_scan(thread_id: String, started_at: Option<i64>) -> Result<ScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = sessions_root().ok_or_else(|| "no home folder".to_string())?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let mut g = global().lock().map_err(|e| e.to_string())?;
        g.1 += 1;
        let tick = g.1;
        scan_in(&root, &thread_id, started_at, now, &mut g.0, tick)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const PARENT: &str = "01a100cb-2869-7061-b795-f9d0d5d6b40b";
    const C1: &str = "01a100f4-0001-7c80-9a67-a9392614a251";
    const C2: &str = "01a100f4-0002-7c80-9a67-a9392614a252";
    const C3: &str = "01a100f4-0003-7c80-9a67-a9392614a253";
    const OTHER: &str = "01a100ff-0000-7c80-9a67-a9392614a2ff";
    const DAY: &str = "2026/01/05";

    fn start() -> i64 {
        parse_iso_ms("2026-01-05T10:00:00.000Z").unwrap()
    }
    fn now() -> i64 {
        parse_iso_ms("2026-01-05T10:05:00.000Z").unwrap()
    }

    fn day_dir(root: &Path) -> PathBuf {
        let d = root.join(DAY);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn put(root: &Path, id: &str, lines: &[String]) -> PathBuf {
        let p = day_dir(root).join(format!("rollout-2026-01-05T10-00-00-{id}.jsonl"));
        fs::write(&p, lines.join("\n") + "\n").unwrap();
        p
    }
    fn append(p: &Path, lines: &[String]) {
        use std::io::Write;
        let mut f = fs::OpenOptions::new().append(true).open(p).unwrap();
        f.write_all((lines.join("\n") + "\n").as_bytes()).unwrap();
    }
    fn meta(id: &str, parent: &str, nick: &str, path: &str, ordinal: i64, hist: i64) -> String {
        format!(
            r#"{{"timestamp":"2026-01-05T10:00:0{ordinal}.000Z","ordinal":0,"type":"session_meta","payload":{{"id":"{id}","parent_thread_id":"{parent}","forked_from_id":"{parent}","timestamp":"2026-01-05T10:00:0{ordinal}.000Z","agent_nickname":"{nick}","agent_path":"{path}","subagent_history_start_ordinal":{hist},"source":{{"subagent":{{"thread_spawn":{{"parent_thread_id":"{parent}","depth":1,"agent_path":"{path}","agent_nickname":"{nick}","agent_role":null}}}}}}}}}}"#
        )
    }
    fn parent_meta() -> String {
        format!(r#"{{"timestamp":"2026-01-05T10:00:00.000Z","ordinal":0,"type":"session_meta","payload":{{"id":"{PARENT}","timestamp":"2026-01-05T10:00:00.000Z","cwd":"/tmp/x"}}}}"#)
    }
    fn spawn(call: &str, task: &str, msg: &str, ord: i64) -> Vec<String> {
        let args = serde_json::json!({"task_name": task, "message": msg, "fork_turns": "none"}).to_string();
        vec![
            serde_json::json!({"timestamp":"2026-01-05T10:00:02.000Z","ordinal":ord,"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","arguments":args,"call_id":call}}).to_string(),
            serde_json::json!({"timestamp":"2026-01-05T10:00:03.000Z","ordinal":ord+1,"type":"response_item","payload":{"type":"function_call_output","call_id":call,"output":serde_json::json!({"task_name":task}).to_string()}}).to_string(),
        ]
    }
    fn started(ord: i64, at: i64) -> String {
        format!(r#"{{"timestamp":"2026-01-05T10:00:05.000Z","ordinal":{ord},"type":"event_msg","payload":{{"type":"task_started","started_at":{at}}}}}"#)
    }
    fn complete(ord: i64, msg: &str) -> String {
        format!(r#"{{"timestamp":"2026-01-05T10:01:00.000Z","ordinal":{ord},"type":"event_msg","payload":{{"type":"task_complete","last_agent_message":"{msg}","completed_at":1767607260,"duration_ms":55000}}}}"#)
    }
    fn exec(ord: i64, cmd: &str) -> String {
        let input = format!(r#"text(await tools.exec_command({{cmd:{},"workdir":"/tmp"}}))"#, serde_json::to_string(cmd).unwrap());
        serde_json::json!({"timestamp":"2026-01-05T10:00:10.000Z","ordinal":ord,"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"c","input":input}}).to_string()
    }
    fn tokens(ord: i64, input: u64, output: u64) -> String {
        format!(r#"{{"timestamp":"2026-01-05T10:00:11.000Z","ordinal":{ord},"type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{input},"cached_input_tokens":10,"output_tokens":{output},"reasoning_output_tokens":2,"total_tokens":{}}}}}}}}}"#, input + output)
    }

    fn scan(root: &Path, cache: &mut Cache) -> ScanResult {
        scan_in(root, PARENT, Some(start()), now(), cache, 1).unwrap()
    }

    /// Parent with three spawn calls and three children (completed, running, failed).
    fn fixture(root: &Path) {
        let mut lines = vec![parent_meta()];
        lines.extend(spawn("call-1", "alpha_task", "Inspect the alpha module and report", 1));
        lines.extend(spawn("call-2", "beta_task", "Run the beta checks", 3));
        lines.extend(spawn("call-3", "gamma_task", "Check gamma", 5));
        put(root, PARENT, &lines);
        put(root, C1, &[meta(C1, PARENT, "Ada", "/root/alpha_task", 1, 0), started(1, 1767607205), exec(2, "ls -la /tmp"), tokens(3, 1000, 50), complete(4, "alpha done")]);
        put(root, C2, &[meta(C2, PARENT, "Bo", "/root/beta_task", 2, 0), started(1, 1767607206), exec(2, "cargo test --all API_TOKEN=abc123secret"), exec(3, "git status"), tokens(4, 2000, 70)]);
        put(root, C3, &[meta(C3, PARENT, "Cy", "/root/gamma_task", 3, 0), started(1, 1767607207), r#"{"timestamp":"2026-01-05T10:00:30.000Z","ordinal":2,"type":"event_msg","payload":{"type":"error","message":"stream failed"}}"#.into()]);
    }

    #[test]
    fn parent_and_three_children() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let r = scan(dir.path(), &mut Cache::new());
        assert!(r.parent_found);
        assert_eq!(r.agents.len(), 3, "{:?}", r.notes);
        let by = |n: &str| r.agents.iter().find(|a| a.nickname.as_deref() == Some(n)).unwrap();
        let (a, b, c) = (by("Ada"), by("Bo"), by("Cy"));
        assert_eq!((a.state.as_str(), b.state.as_str(), c.state.as_str()), ("completed", "running", "failed"));
        assert_eq!(a.task_name.as_deref(), Some("alpha_task"));
        assert_eq!(a.key, format!("{PARENT}:alpha_task"));
        assert_eq!(a.message.as_deref(), Some("Inspect the alpha module and report"));
        assert_eq!((a.last_message.as_deref(), a.duration_ms, a.tool_uses), (Some("alpha done"), Some(55000), 1));
        assert_eq!(a.tokens, Tokens { input: 1000, output: 50, cached: 10, reasoning: 2, total: 1050 });
        assert_eq!(a.thread_id.as_deref(), Some(C1));
        assert_eq!(b.tool_uses, 2);
        assert_eq!(b.step.as_deref(), Some("git status"));
        assert_eq!(c.error.as_deref(), Some("stream failed"));
        // Ordered by start time.
        assert_eq!(r.agents.iter().map(|x| x.nickname.clone().unwrap()).collect::<Vec<_>>(), ["Ada", "Bo", "Cy"]);
    }

    #[test]
    fn spawn_without_child_is_starting_then_resolves_to_the_same_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut lines = vec![parent_meta()];
        lines.extend(spawn("call-1", "alpha_task", "Do alpha", 1));
        put(dir.path(), PARENT, &lines);
        let mut cache = Cache::new();
        let r = scan(dir.path(), &mut cache);
        assert_eq!(r.agents.len(), 1);
        assert_eq!((r.agents[0].state.as_str(), r.agents[0].thread_id.clone()), ("starting", None));
        let key = r.agents[0].key.clone();
        put(dir.path(), C1, &[meta(C1, PARENT, "Ada", "/root/alpha_task", 1, 0), started(1, 1767607205)]);
        let r = scan(dir.path(), &mut cache);
        assert_eq!(r.agents.len(), 1);
        assert_eq!((r.agents[0].state.as_str(), r.agents[0].key.clone()), ("running", key));
    }

    #[test]
    fn incremental_reads_and_running_to_completed() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let mut cache = Cache::new();
        let first = scan(dir.path(), &mut cache);
        let p2 = day_dir(dir.path()).join(format!("rollout-2026-01-05T10-00-00-{C2}.jsonl"));
        let off = cache[&fs::canonicalize(&p2).unwrap()].offset;
        assert_eq!(off, fs::metadata(&p2).unwrap().len());
        // A partial trailing line is not consumed.
        use std::io::Write;
        fs::OpenOptions::new().append(true).open(&p2).unwrap().write_all(br#"{"timestamp":"2026-01-05T10:02:00.000Z","ordinal":5,"type":"event_msg","payload":{"type":"task_comp"#).unwrap();
        let mid = scan(dir.path(), &mut cache);
        assert_eq!(mid.agents[1].state, "running");
        assert_eq!(cache[&fs::canonicalize(&p2).unwrap()].offset, off);
        // Finish the line.
        append(&p2, &[r#"lete","last_agent_message":"beta ok","completed_at":1767607320,"duration_ms":1}}"#.into()]);
        let last = scan(dir.path(), &mut cache);
        assert_eq!(first.agents[1].state, "running");
        assert_eq!((last.agents[1].state.as_str(), last.agents[1].last_message.as_deref()), ("completed", Some("beta ok")));
    }

    #[test]
    fn secrets_are_redacted_and_steps_clipped() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let long = "echo ".to_string() + &"x".repeat(400);
        let p = day_dir(dir.path()).join(format!("rollout-2026-01-05T10-00-00-{C2}.jsonl"));
        let r = scan(dir.path(), &mut Cache::new());
        let bo = r.agents.iter().find(|a| a.nickname.as_deref() == Some("Bo")).unwrap();
        assert!(!format!("{bo:?}").contains("abc123secret"));
        append(&p, &[exec(9, &long), exec(10, "curl -H 'Authorization: Bearer sk-abcdefghijklmnop1234' https://x.test")]);
        let mut cache = Cache::new();
        let r = scan(dir.path(), &mut cache);
        let step = r.agents[1].step.clone().unwrap();
        assert!(!step.contains("sk-abcdefghijklmnop1234") && step.contains("***"), "{step}");
        // The long command, parsed on its own, is clipped.
        assert!(describe_step("exec", &format!("text(await tools.exec_command({{cmd:{}}}))", serde_json::to_string(&long).unwrap())).chars().count() <= STEP_CHARS);
    }

    #[test]
    fn malformed_lines_and_foreign_children_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let p = day_dir(dir.path()).join(format!("rollout-2026-01-05T10-00-00-{C1}.jsonl"));
        append(&p, &["not json at all task_started".into(), r#"{"type":"event_msg","payload":"#.into(), "{}".into()]);
        // A child of some other run, a file with garbage, and an empty one.
        put(dir.path(), OTHER, &[meta(OTHER, "01a1ffff-0000-7c80-9a67-a9392614a2aa", "Zed", "/root/zed", 4, 0), started(1, 1767607205)]);
        fs::write(day_dir(dir.path()).join("rollout-2026-01-05T10-00-00-01a1aaaa-0000-0000-0000-000000000001.jsonl"), "garbage\n\n").unwrap();
        fs::write(day_dir(dir.path()).join("rollout-2026-01-05T10-00-00-01a1aaaa-0000-0000-0000-000000000002.jsonl"), "").unwrap();
        fs::write(day_dir(dir.path()).join("notes.txt"), "x").unwrap();
        let r = scan(dir.path(), &mut Cache::new());
        assert_eq!(r.agents.len(), 3);
        assert!(r.agents.iter().all(|a| a.nickname.as_deref() != Some("Zed")));
        assert!(r.notes.iter().any(|n| n.contains("unreadable")), "{:?}", r.notes);
    }

    #[test]
    fn grandchildren_follow_the_parent_chain() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let g = "01a100f4-0009-7c80-9a67-a9392614a259";
        put(dir.path(), g, &[meta(g, C1, "Gus", "/root/alpha_task/deep", 5, 0), started(1, 1767607208)]);
        let r = scan(dir.path(), &mut Cache::new());
        assert_eq!(r.agents.len(), 4);
        assert_eq!(r.agents.iter().find(|a| a.nickname.as_deref() == Some("Gus")).unwrap().parent_thread_id, C1);
    }

    #[test]
    fn forked_history_is_not_counted() {
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), PARENT, &[parent_meta()]);
        // Ordinals below the history start belong to the parent: its task_started/exec must not leak in.
        put(dir.path(), C1, &[meta(C1, PARENT, "Ada", "/root/a", 1, 5), started(2, 1767607200), exec(3, "echo inherited"), complete(4, "inherited"), started(6, 1767607300), exec(7, "echo own")]);
        let r = scan(dir.path(), &mut Cache::new());
        let a = &r.agents[0];
        assert_eq!((a.state.as_str(), a.tool_uses, a.step.as_deref(), a.last_message.clone()), ("running", 1, Some("echo own"), None));
    }

    #[test]
    fn symlinks_are_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fixture(dir.path());
        // A rollout name that links outside of the sessions folder, and a linked day folder.
        let secret = outside.path().join("elsewhere.jsonl");
        fs::write(&secret, meta(OTHER, PARENT, "Evil", "/root/evil", 6, 0) + "\n").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&secret, day_dir(dir.path()).join(format!("rollout-2026-01-05T10-00-00-{OTHER}.jsonl"))).unwrap();
            let linked = dir.path().join("2026/01/06");
            fs::create_dir_all(outside.path().join("day")).unwrap();
            fs::write(outside.path().join("day").join(format!("rollout-2026-01-06T10-00-00-{OTHER}.jsonl")), meta(OTHER, PARENT, "Evil", "/root/evil", 6, 0) + "\n").unwrap();
            std::os::unix::fs::symlink(outside.path().join("day"), &linked).unwrap();
        }
        let r = scan_in(dir.path(), PARENT, Some(start()), parse_iso_ms("2026-01-06T10:00:00.000Z").unwrap(), &mut Cache::new(), 1).unwrap();
        assert_eq!(r.agents.len(), 3);
        assert!(r.agents.iter().all(|a| a.nickname.as_deref() != Some("Evil")));
    }

    #[test]
    fn only_the_run_window_is_searched() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        // The run started days later: the day folder with the files is out of range.
        let late = parse_iso_ms("2026-01-20T10:00:00.000Z").unwrap();
        let r = scan_in(dir.path(), PARENT, Some(late), late + 1000, &mut Cache::new(), 1).unwrap();
        assert!(!r.parent_found && r.agents.is_empty());
        assert!(r.notes.iter().any(|n| n.contains("parent rollout not found")));
    }

    #[test]
    fn bounds_and_validation() {
        let dir = tempfile::tempdir().unwrap();
        assert!(scan_in(dir.path(), "../etc", None, now(), &mut Cache::new(), 1).is_err());
        assert!(scan_in(dir.path(), "", None, now(), &mut Cache::new(), 1).is_err());
        // Missing sessions folder is a note, not an error.
        let r = scan_in(&dir.path().join("none"), PARENT, None, now(), &mut Cache::new(), 1).unwrap();
        assert!(r.agents.is_empty() && !r.notes.is_empty());
        // More than 50 spawns are cut.
        let mut lines = vec![parent_meta()];
        for i in 0..60 {
            lines.extend(spawn(&format!("call-{i}"), &format!("task_{i}"), "m", i * 2 + 1));
        }
        put(dir.path(), PARENT, &lines);
        let r = scan(dir.path(), &mut Cache::new());
        assert_eq!(r.agents.len(), 50);
        assert!(r.truncated);
    }

    #[test]
    fn oversized_lines_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let mut lines = vec![parent_meta()];
        lines.extend(spawn("call-1", "alpha_task", "x", 1));
        put(dir.path(), PARENT, &lines);
        let huge = format!(r#"{{"ordinal":9,"type":"event_msg","payload":{{"type":"task_started","pad":"{}"}}}}"#, "a".repeat(MAX_LINE + 10));
        put(dir.path(), C1, &[meta(C1, PARENT, "Ada", "/root/alpha_task", 1, 0), huge, exec(10, "echo after")]);
        let r = scan(dir.path(), &mut Cache::new());
        let a = &r.agents[0];
        // The huge task_started was skipped (state stays "starting"), the next line is read.
        assert_eq!((a.state.as_str(), a.tool_uses), ("starting", 1));
    }

    #[test]
    fn time_helpers() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(parse_iso_ms("2026-01-05T10:00:00Z"), Some(1767607200000));
        assert_eq!(parse_iso_ms("nonsense"), None);
        assert_eq!(civil_from_days(days_from_civil(2026, 2, 28) + 1), (2026, 3, 1));
        let d = day_dirs(start(), now());
        assert_eq!(d.first(), Some(&(2026, 1, 6)));
        assert_eq!(d.last(), Some(&(2026, 1, 4)));
        assert_eq!(exec_text(r#"text(await tools.exec_command({cmd:"ls \"a b\"\nwc","workdir":"/x"}))"#), "ls \"a b\" wc");
        assert_eq!(exec_text("plain text"), "plain text");
    }
}
