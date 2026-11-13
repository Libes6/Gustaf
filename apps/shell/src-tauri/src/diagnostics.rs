//! Logs for "Report a problem". Nothing here leaves the computer unless the user ticks
//! "Attach logs"; what does leave is redacted of obvious secrets and capped.

use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Mutex;

/// Server output and shell messages, newest last. The shell writes no log file of its own.
static OUTPUT: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
const OUTPUT_LINES: usize = 2000;
const LINE_CHARS: usize = 4000;
/// Each section is capped separately so one noisy source cannot push out the other.
const SECTION_BYTES: usize = 100 * 1024;
/// Only the end of the trace is read; failures of interest are recent.
const TRACE_TAIL_BYTES: u64 = 2 * 1024 * 1024;
const TRACE_FILE: &str = "userdata/logs/server.trace.ndjson";
const REDACTED: &str = "[redacted]";

/// Key fragments whose values are hidden: `token=…`, `"apiKey": "…"`, `client_secret: …`.
const SENSITIVE_KEYS: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "apikey",
    "api_key",
    "api-key",
    "authorization",
    "cookie",
    "credential",
    "private_key",
    "privatekey",
];
/// Well-known credential formats that show up without a key in front of them.
const TOKEN_PREFIXES: &[&str] = &[
    "sk-",
    "sk_",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "glpat-",
    "xoxb-",
    "xoxp-",
    "gdt_",
    "AKIA",
    "AIza",
    "eyJ",
];
const MIN_TOKEN_TAIL: usize = 16;

pub(crate) fn record(line: &str) {
    if let Ok(mut output) = OUTPUT.lock() {
        if output.len() == OUTPUT_LINES {
            output.pop_front();
        }
        output.push_back(line.chars().take(LINE_CHARS).collect());
    }
}

/// The redacted, capped log text attached to a report, or `None` when there is nothing to send.
pub(crate) fn collect(data_dir: Option<&Path>) -> Option<String> {
    let output = OUTPUT
        .lock()
        .map(|output| output.iter().cloned().collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    let failures = data_dir
        .and_then(|dir| read_tail(&dir.join(TRACE_FILE), TRACE_TAIL_BYTES))
        .map(|trace| failed_spans(&trace))
        .unwrap_or_default();
    let home = home_dir();
    let mut sections = Vec::new();
    for (title, text) in [
        ("Shell and server output", output),
        ("Recent failed server operations", failures),
    ] {
        if !text.trim().is_empty() {
            let text = redact(&text, home.as_deref());
            sections.push(format!(
                "== {title} ==\n{}",
                tail_bytes(&text, SECTION_BYTES)
            ));
        }
    }
    (!sections.is_empty()).then(|| sections.join("\n\n"))
}

pub(crate) fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
}

fn read_tail(path: &Path, bytes: u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(bytes)))
        .ok()?;
    let mut raw = Vec::new();
    file.read_to_end(&mut raw).ok()?;
    Some(String::from_utf8_lossy(&raw).into_owned())
}

/// Trace spans that ended in a failure; successful spans are noise for a bug report.
fn failed_spans(trace: &str) -> String {
    trace
        .lines()
        .filter(|line| line.contains("\"exit\":{\"_tag\":\"Failure\""))
        .map(|line| line.chars().take(LINE_CHARS).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The last `max` bytes, starting at a line boundary when one is near.
fn tail_bytes(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let tail = &text[start..];
    tail.find('\n').map_or(tail, |newline| &tail[newline + 1..])
}

/// Hides bearer tokens, values of secret-looking keys and well-known token formats, and
/// shortens the home directory to `~` so the user name does not travel.
pub(crate) fn redact(text: &str, home: Option<&str>) -> String {
    let text = match home.filter(|home| home.len() > 1) {
        Some(home) => text.replace(home, "~"),
        None => text.to_owned(),
    };
    text.lines().map(redact_line).collect::<Vec<_>>().join("\n")
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

fn is_value_char(c: char) -> bool {
    !c.is_whitespace()
        && !matches!(
            c,
            '"' | '\'' | ',' | ';' | '&' | '}' | ']' | ')' | '<' | '>'
        )
}

fn value_end(chars: &[char], mut at: usize) -> usize {
    while at < chars.len() && is_value_char(chars[at]) {
        at += 1;
    }
    at
}

fn redact_line(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut at = 0;
    while at < chars.len() {
        let starts_word = is_word_char(chars[at]) && (at == 0 || !is_word_char(chars[at - 1]));
        if !starts_word {
            out.push(chars[at]);
            at += 1;
            continue;
        }
        if is_known_token(&chars[at..value_end(&chars, at)]) {
            out.push_str(REDACTED);
            at = value_end(&chars, at);
            continue;
        }
        let mut word_end = at;
        while word_end < chars.len() && is_word_char(chars[word_end]) {
            word_end += 1;
        }
        let key: String = chars[at..word_end].iter().collect();
        match secret_value_start(&chars, word_end, &key.to_ascii_lowercase()) {
            Some(value) => {
                out.extend(&chars[at..value]);
                out.push_str(REDACTED);
                let mut end = value_end(&chars, value);
                // `Authorization: Bearer abc` hides the credential, not just the scheme.
                let scheme: String = chars[value..end].iter().collect();
                if matches!(scheme.to_ascii_lowercase().as_str(), "bearer" | "basic") {
                    let mut next = end;
                    while next < chars.len() && chars[next] == ' ' {
                        next += 1;
                    }
                    end = value_end(&chars, next);
                }
                at = end;
            }
            None => {
                out.push_str(&key);
                at = word_end;
            }
        }
    }
    out
}

fn is_known_token(run: &[char]) -> bool {
    let run: String = run.iter().collect();
    TOKEN_PREFIXES.iter().any(|prefix| {
        run.strip_prefix(prefix).is_some_and(|rest| {
            rest.chars().count() >= MIN_TOKEN_TAIL
                && rest
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c))
        })
    })
}

/// Where a secret value starts after `key`: `Bearer abc`, `token=abc`, `"apiKey": "abc"`.
fn secret_value_start(chars: &[char], mut at: usize, key: &str) -> Option<usize> {
    if key == "bearer" {
        let start = at;
        while at < chars.len() && chars[at] == ' ' {
            at += 1;
        }
        return (at > start && at < chars.len() && is_value_char(chars[at])).then_some(at);
    }
    if !SENSITIVE_KEYS
        .iter()
        .any(|sensitive| key.contains(sensitive))
    {
        return None;
    }
    if at < chars.len() && matches!(chars[at], '"' | '\'') {
        at += 1;
    }
    while at < chars.len() && chars[at] == ' ' {
        at += 1;
    }
    if at >= chars.len() || !matches!(chars[at], '=' | ':') {
        return None;
    }
    at += 1;
    while at < chars.len() && matches!(chars[at], ' ' | '"' | '\'') {
        at += 1;
    }
    (at < chars.len() && is_value_char(chars[at]) && !matches!(chars[at], '{' | '[')).then_some(at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_bearer_tokens_and_secret_values() {
        let cases = [
            (
                "Authorization: Bearer abc.def-123",
                "Authorization: [redacted]",
            ),
            (
                "curl -H 'authorization: Bearer xyz'",
                "curl -H 'authorization: [redacted]'",
            ),
            (
                "sent bearer tok123 to relay",
                "sent bearer [redacted] to relay",
            ),
            (
                "pairingUrl: http://localhost:7445/pair#token=abc&x=1",
                "pairingUrl: http://localhost:7445/pair#token=[redacted]&x=1",
            ),
            (
                r#"{"token":"s3cr3t","n":1}"#,
                r#"{"token":"[redacted]","n":1}"#,
            ),
            (
                r#"{"refreshToken": "abc", "ok": true}"#,
                r#"{"refreshToken": "[redacted]", "ok": true}"#,
            ),
            (
                "CLIENT_SECRET=hunter2 next",
                "CLIENT_SECRET=[redacted] next",
            ),
            ("password: p@ss;", "password: [redacted];"),
            ("x-api-key: 123", "x-api-key: [redacted]"),
            ("Cookie: session=abc", "Cookie: [redacted]"),
        ];
        for (input, expected) in cases {
            assert_eq!(redact_line(input), expected, "{input}");
        }
    }

    #[test]
    fn hides_well_known_token_formats_anywhere() {
        let line = "key sk-ant-api03-abcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwxyz0123 \
                    and gdt_0123456789abcdef0123 and eyJhbGciOiJIUzI1NiJ9.e30.sig";
        let redacted = redact_line(line);
        for secret in ["sk-ant", "ghp_", "gdt_", "eyJ"] {
            assert!(!redacted.contains(secret), "{secret}: {redacted}");
        }
        assert_eq!(redacted.matches(REDACTED).count(), 4);
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        for line in [
            "Server listening on 127.0.0.1:7445",
            "task-runner: sk-short",
            "tokens used: 12 of 100",
            "the token was rejected",
            r#"{"token":{"kind":"x"}}"#,
        ] {
            assert_eq!(redact_line(line), line);
        }
    }

    #[test]
    fn shortens_the_home_directory() {
        assert_eq!(
            redact("open /Users/max/project/a.ts\nok", Some("/Users/max")),
            "open ~/project/a.ts\nok"
        );
        assert_eq!(redact("/ stays", Some("/")), "/ stays");
    }

    #[test]
    fn keeps_the_end_of_long_text_from_a_line_start() {
        let text = (0..100)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let tail = tail_bytes(&text, 30);
        assert!(tail.len() <= 30);
        assert!(tail.starts_with("line "));
        assert!(tail.ends_with("line 99"));
        assert_eq!(tail_bytes("short", 30), "short");
        assert_eq!(tail_bytes("ééééé", 3), "é");
    }

    #[test]
    fn keeps_only_failed_trace_spans() {
        let trace = concat!(
            r#"{"name":"a","exit":{"_tag":"Success"}}"#,
            "\n",
            r#"{"name":"b","exit":{"_tag":"Failure","cause":"boom"}}"#
        );
        assert_eq!(
            failed_spans(trace),
            r#"{"name":"b","exit":{"_tag":"Failure","cause":"boom"}}"#
        );
    }
}
