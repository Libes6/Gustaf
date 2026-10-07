//! Runs one user-defined hook command (see docs/features/hooks.md). Like `tools::run_command` it uses the platform shell,
//! but the hook gets a JSON document on stdin, a scrubbed environment (a short allowlist plus the `GUSTAF_*` variables the
//! caller passes), a hard timeout of at most 60 s and, on timeout, the whole process tree is killed.

use crate::shell::Shell;
use serde::Serialize;
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const MAX_TIMEOUT_MS: u64 = 60_000;
const MAX_OUTPUT: usize = 64 * 1024;
/// Variables a hook may inherit: enough to find tools and behave like a normal shell, nothing that holds credentials.
const INHERIT: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SHELL",
    "TERM",
    "SystemRoot",
    "ComSpec",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "PATHEXT",
];

#[derive(Serialize)]
pub struct HookResult {
    code: Option<i32>,
    output: String,
    timed_out: bool,
}

fn clip(mut s: String) -> String {
    if s.len() > MAX_OUTPUT {
        let mut cut = MAX_OUTPUT;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n[output truncated]");
    }
    s
}

/// The environment of a hook: the allowlisted variables of this process plus the `GUSTAF_*` pairs (anything else is dropped).
pub fn hook_env(
    extra: &[(String, String)],
    parent: impl Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = INHERIT
        .iter()
        .filter_map(|k| parent(k).map(|v| (k.to_string(), v)))
        .collect();
    out.extend(
        extra
            .iter()
            .filter(|(k, _)| k.starts_with("GUSTAF_"))
            .cloned(),
    );
    out
}

fn kill_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
}

pub fn exec(
    root: &str,
    command: &str,
    timeout_ms: u64,
    stdin: String,
    env: Vec<(String, String)>,
) -> Result<HookResult, String> {
    let shell = Shell::current();
    let merged = shell.merges_stderr_itself();
    let mut cmd = Command::new(shell.program());
    cmd.args(shell.flags())
        .arg(shell.script(command))
        .current_dir(root)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if merged {
            Stdio::inherit()
        } else {
            Stdio::piped()
        });
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    if let Some(mut input) = child.stdin.take() {
        // Written on its own thread: a hook that never reads its stdin must not block the timeout.
        std::thread::spawn(move || {
            let _ = input.write_all(stdin.as_bytes());
        });
    }
    let Some(mut stdout) = child.stdout.take() else {
        kill_tree(pid);
        let _ = child.wait();
        return Err("failed to capture hook output".into());
    };
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err_reader = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf);
            buf
        })
    });
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.clamp(100, MAX_TIMEOUT_MS));
    let (code, timed_out) = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break (s.code(), false);
        }
        if Instant::now() > deadline {
            kill_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
            break (None, true);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // The pipes close once every process of the tree is gone; after a timeout they are closed by the kill above.
    let mut bytes = reader.join().unwrap_or_default();
    if let Some(r) = err_reader {
        bytes.extend(r.join().unwrap_or_default());
    }
    Ok(HookResult {
        code,
        output: clip(String::from_utf8_lossy(&bytes).into_owned()),
        timed_out,
    })
}

#[tauri::command]
pub async fn run_hook(
    root: String,
    command: String,
    timeout_ms: u64,
    stdin: String,
    env: Vec<(String, String)>,
) -> Result<HookResult, String> {
    let env = hook_env(&env, |k| std::env::var(k).ok());
    exec(&root, &command, timeout_ms, stdin, env)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn run(command: &str, timeout_ms: u64, stdin: &str, env: &[(&str, &str)]) -> HookResult {
        let extra: Vec<(String, String)> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        exec(
            "/tmp",
            command,
            timeout_ms,
            stdin.into(),
            hook_env(&extra, |k| std::env::var(k).ok()),
        )
        .unwrap()
    }

    #[test]
    fn stdin_env_and_exit_code() {
        let r = run(
            "cat; echo \"$GUSTAF_EVENT\"; exit 2",
            5000,
            "{\"a\":1}",
            &[("GUSTAF_EVENT", "pre_tool"), ("OTHER", "x")],
        );
        assert_eq!(r.code, Some(2));
        assert!(r.output.contains("{\"a\":1}") && r.output.contains("pre_tool"));
        assert!(!r.timed_out);
    }

    #[test]
    fn only_allowlisted_variables_reach_the_hook() {
        std::env::set_var("GUSTAF_TEST_SECRET_TOKEN", "hunter2");
        let r = run(
            "env",
            5000,
            "",
            &[("NOT_GUSTAF", "1"), ("GUSTAF_TOOL", "edit_file")],
        );
        assert!(r.output.contains("GUSTAF_TOOL=edit_file"));
        assert!(!r.output.contains("hunter2") && !r.output.contains("NOT_GUSTAF"));
    }

    #[test]
    fn timeout_kills_the_process_tree() {
        let marker = format!("/tmp/gustaf-hook-{}", std::process::id());
        let started = Instant::now();
        let r = run(
            &format!("(sleep 3; touch {marker}) & sleep 30"),
            300,
            "",
            &[],
        );
        assert!(r.timed_out && r.code.is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(3500));
        assert!(
            !std::path::Path::new(&marker).exists(),
            "a child of the hook survived the timeout"
        );
    }
}
