//! Secret redaction for everything the server sends to a phone. A port of `redactSecrets` in `src/lib/exportChats.ts`
//! (the helper the chat export and the share dialog use); keep the two in step. Best effort by nature: tool output is
//! free-form (`cat .env`), so known token shapes, `Bearer` values, URL credentials and `KEY=value` assignments are blanked.

use regex::{Captures, Regex};
use std::sync::OnceLock;

pub const REDACTED: &str = "[REDACTED]";

struct Patterns {
    tokens: Vec<Regex>,
    bearer: Regex,
    url_credentials: Regex,
    assignment: Regex,
    not_a_secret: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| {
        let re = |s: &str| Regex::new(s).expect("redaction pattern");
        Patterns {
            tokens: vec![
                re(r"-----BEGIN [A-Z ]*PRIVATE KEY-----(?s:.)*?(?:-----END [A-Z ]*PRIVATE KEY-----|\z)"),
                re(r"(?-u:\b)sk-[A-Za-z0-9_-]{20,}"),
                re(r"(?-u:\b)[sr]k_(?:live|test)_[A-Za-z0-9]{16,}"),
                re(r"(?-u:\b)AIza[0-9A-Za-z_-]{30,}"),
                re(r"(?-u:\b)gh[pousr]_[A-Za-z0-9]{30,}"),
                re(r"(?-u:\b)github_pat_[A-Za-z0-9_]{20,}"),
                re(r"(?-u:\b)glpat-[A-Za-z0-9_-]{20,}"),
                re(r"(?-u:\b)xox[abeoprs]-[A-Za-z0-9-]{10,}"),
                re(r"(?-u:\b)AKIA[0-9A-Z]{16}(?-u:\b)"),
                re(r"(?-u:\b)(?:npm|hf)_[A-Za-z0-9]{30,}"),
                re(r"(?-u:\b)eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
            ],
            bearer: re(r"(?-u:\b)(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{16,}"),
            url_credentials: re(r"(?i)((?-u:\b)[a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s@/]+@"),
            // The TypeScript version has `token(?!s)` and `(?![\w.$-]*\()` (a value that is a function call is not a secret);
            // the regex crate has no look-ahead: the first is spelled out in the pattern, the second is checked on the match.
            assignment: re(
                r#"(?i)((?:(?:api[_-]?key|apikey|secret|passw(?:or)?d|passwd|authorization|credentials?|private[_-]?key|access[_-]?key)[A-Za-z0-9_-]*|token(?:[0-9A-RT-Za-rt-z_-][A-Za-z0-9_-]*)?)["']?\s*[:=]\s*["']?)((?:(?:Bearer|Basic|Token)\s+)?[^\s"'`,;&)}\]]{6,})"#,
            ),
            not_a_secret: re(r"(?i)^(?:string|number|boolean|undefined|null|true|false|none|required|optional|any|object|unknown)$"),
        }
    })
}

fn looks_like_call(value: &str) -> bool {
    let mut chars = value.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '$' | '-') {
            chars.next();
        } else {
            break;
        }
    }
    chars.peek() == Some(&'(')
}

pub fn redact_secrets(text: &str) -> String {
    let p = patterns();
    let mut out = text.to_string();
    for re in &p.tokens {
        out = re.replace_all(&out, REDACTED).into_owned();
    }
    out = p
        .bearer
        .replace_all(&out, |c: &Captures| format!("{}{}{REDACTED}", &c[1], &c[2]))
        .into_owned();
    out = p
        .url_credentials
        .replace_all(&out, |c: &Captures| format!("{}{REDACTED}@", &c[1]))
        .into_owned();
    p.assignment
        .replace_all(&out, |c: &Captures| {
            let (whole, head, value) = (&c[0], &c[1], &c[2]);
            if looks_like_call(value)
                || value.contains("[REDACTED")
                || p.not_a_secret.is_match(value)
                || value.starts_with(['$', '<', '{', '%', '(', '*'])
            {
                whole.to_string()
            } else {
                format!("{head}{REDACTED}")
            }
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_token_shapes_are_blanked() {
        for secret in [
            "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
            "sk_live_abcdefghijklmnop1234",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "github_pat_11ABCDEFG0abcdefghijklmnopqrstuv",
            "AKIAABCDEFGHIJKLMNOP",
            "xoxb-1234567890-abcdefghij",
            "AIzaSyA-abcdefghijklmnopqrstuvwxyz012345",
            "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4",
        ] {
            let out = redact_secrets(&format!("key is {secret} ok"));
            assert_eq!(out, format!("key is {REDACTED} ok"), "{secret}");
        }
    }

    #[test]
    fn private_key_blocks_are_cut_even_when_unterminated() {
        let out = redact_secrets("before\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----\nafter");
        assert_eq!(out, format!("before\n{REDACTED}\nafter"));
        assert_eq!(
            redact_secrets("x\n-----BEGIN PRIVATE KEY-----\nMIIabc"),
            format!("x\n{REDACTED}")
        );
    }

    #[test]
    fn bearer_and_url_credentials() {
        assert_eq!(
            redact_secrets("Authorization: Bearer abcdefghijklmnopqrstu"),
            format!("Authorization: Bearer {REDACTED}")
        );
        assert_eq!(
            redact_secrets("curl https://user:hunter2pw@example.com/x"),
            format!("curl https://user:{REDACTED}@example.com/x")
        );
    }

    #[test]
    fn assignments_are_blanked_unless_they_are_placeholders_or_calls() {
        assert_eq!(
            redact_secrets("API_KEY=abcdef123456"),
            format!("API_KEY={REDACTED}")
        );
        assert_eq!(
            redact_secrets("password: hunter2hunter"),
            format!("password: {REDACTED}")
        );
        assert_eq!(
            redact_secrets(r#""apiKey": "abcdef123456""#),
            format!(r#""apiKey": "{REDACTED}""#)
        );
        assert_eq!(
            redact_secrets("const token = getToken();"),
            "const token = getToken();"
        );
        assert_eq!(redact_secrets("secret: string;"), "secret: string;");
        assert_eq!(redact_secrets("token=$TOKEN_VALUE"), "token=$TOKEN_VALUE");
        assert_eq!(redact_secrets("tokens: 123456789"), "tokens: 123456789");
        assert_eq!(
            redact_secrets("password=shorter"),
            format!("password={REDACTED}")
        );
        assert_eq!(
            redact_secrets("password=abc"),
            "password=abc",
            "values under six characters are left alone"
        );
    }

    #[test]
    fn ordinary_text_is_untouched() {
        let s = "Fixed the bug in src/main.rs: the loop never ended.\nUse `cargo test` to check. Ünïcödé и русский тоже.";
        assert_eq!(redact_secrets(s), s);
    }
}
