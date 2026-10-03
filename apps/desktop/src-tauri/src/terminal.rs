//! User-operated PTY sessions. No agent tool exposes write/create commands.
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{collections::{HashMap, VecDeque}, io::{Read, Write}, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}};
use tauri::{ipc::Channel, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    #[cfg(unix)]
    pid: Option<u32>,
}
impl Drop for Session { fn drop(&mut self) {
    let _ = self.killer.kill();
    #[cfg(unix)]
    unsafe {
        // A running job can hold the slave open after the shell exits. Kill its own PTY group too.
        if let Some(group) = self.master.process_group_leader() {
            if group > 1 && group != libc::getpgrp() { libc::kill(-group, libc::SIGKILL); }
        }
        if let Some(pid) = self.pid { if pid > 1 { libc::kill(pid as i32, libc::SIGKILL); } }
    }
} }
#[derive(Default)]
pub struct Terminals(Arc<Mutex<HashMap<u64, Session>>>, Arc<Mutex<HashMap<u64, Transcript>>>);
struct Transcript { root: String, bytes: VecDeque<u8>, open: bool }
const MAX_TRANSCRIPT: usize = 1024 * 1024;
fn append(transcript: &mut Transcript, data: &[u8]) {
    transcript.bytes.extend(data.iter().copied());
    let extra = transcript.bytes.len().saturating_sub(MAX_TRANSCRIPT);
    transcript.bytes.drain(..extra);
}
fn plain_terminal(bytes: &[u8]) -> String {
    let raw = String::from_utf8_lossy(bytes);
    let mut out = String::new();
    let mut escape = 0u8;
    for c in raw.chars() {
        match escape {
            1 => { escape = if c == '[' { 2 } else if c == ']' { 3 } else { 0 }; },
            2 => { if ('@'..='~').contains(&c) { escape = 0; } },
            3 => { if c == '\u{7}' { escape = 0; } else if c == '\u{1b}' { escape = 4; } },
            4 => { escape = if c == '\\' { 0 } else { 3 }; },
            _ => { if c == '\u{1b}' { escape = 1; } else if c == '\r' { out.push('\r'); } else if !c.is_control() || c == '\n' || c == '\t' { out.push(c); } }
        }
    }
    out.replace("\r\n", "\n").replace('\r', "\n")
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo { id: u64, root: String, open: bool }
#[tauri::command]
pub fn terminal_list(state: State<'_, Terminals>, root: String) -> Result<Vec<TerminalInfo>, String> {
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    let transcripts = state.1.lock().map_err(|e| e.to_string())?;
    let mut out: Vec<_> = transcripts.iter().filter(|(_, t)| t.root == root).map(|(id, t)| TerminalInfo { id: *id, root: t.root.clone(), open: t.open }).collect();
    out.sort_by_key(|t| t.id); Ok(out)
}
#[tauri::command]
pub fn terminal_tail(state: State<'_, Terminals>, root: String, id: u64, lines: usize) -> Result<String, String> {
    if !(1..=500).contains(&lines) { return Err("Terminal line count must be 1..500".into()); }
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    let transcripts = state.1.lock().map_err(|e| e.to_string())?;
    let t = transcripts.get(&id).ok_or("Terminal transcript unavailable")?;
    tail_for_root(&root, t, lines)
}
fn tail_for_root(root: &str, t: &Transcript, lines: usize) -> Result<String, String> {
    if !(1..=500).contains(&lines) { return Err("Terminal line count must be 1..500".into()); }
    if t.root != root { return Err("Terminal belongs to another project/workspace".into()); }
    let output = plain_terminal(&t.bytes.iter().copied().collect::<Vec<_>>());
    let last: Vec<_> = output.lines().rev().take(lines).collect();
    let text = last.into_iter().rev().collect::<Vec<_>>().join("\n");
    let chars: Vec<_> = text.chars().collect();
    if chars.len() > 30000 { Ok(format!("[earlier output truncated]\n{}", chars[chars.len()-30000..].iter().collect::<String>())) } else { Ok(text) }
}
static NEXT: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEvent {
    id: u64,
    data: Vec<u8>,
    exit_code: Option<u32>,
    error: Option<String>,
}
fn size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(2..=500).contains(&cols) || !(2..=300).contains(&rows) { return Err("Invalid terminal dimensions".into()); }
    Ok(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })
}
#[tauri::command]
pub fn terminal_create(state: State<'_, Terminals>, root: String, cols: u16, rows: u16, output: Channel<TerminalEvent>) -> Result<u64, String> {
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !root.is_dir() { return Err("Terminal working directory must be a directory".into()); }
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    if sessions.len() >= 16 { return Err("Close a terminal before opening another (maximum 16)".into()); }
    let pair = native_pty_system().openpty(size(cols, rows)?).map_err(|e| e.to_string())?;
    let mut command = CommandBuilder::new(crate::shell::Shell::current().program());
    #[cfg(unix)]
    command.args(["-l", "-i"]);
    #[cfg(windows)]
    command.args(["-NoLogo"]);
    command.cwd(&root);
    command.env("TERM", "xterm-256color");
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    sessions.insert(id, Session { master: pair.master, writer, killer: child.clone_killer(),
        #[cfg(unix)] pid: child.process_id(),
    });
    drop(pair.slave);
    drop(sessions);
    {
        let mut transcripts = state.1.lock().map_err(|e| e.to_string())?;
        if transcripts.len() >= 32 {
            if let Some(oldest) = transcripts.iter().filter(|(_, t)| !t.open).map(|(id, _)| *id).min() { transcripts.remove(&oldest); }
        }
        transcripts.insert(id, Transcript { root: root.to_string_lossy().into_owned(), bytes: VecDeque::new(), open: true });
    }
    let store = state.0.clone();
    let transcripts = state.1.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut logs) = transcripts.lock() { if let Some(t) = logs.get_mut(&id) { append(t, &buffer[..n]); } }
                    if output.send(TerminalEvent { id, data: buffer[..n].to_vec(), exit_code: None, error: None }).is_err() { break; }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                // PTY masters on Unix commonly signal EOF with EIO after the slave closes.
                Err(e) if e.raw_os_error() == Some(5) => break,
                Err(e) => { let _ = output.send(TerminalEvent { id, data: vec![], exit_code: None, error: Some(e.to_string()) }); break; }
            }
        }
        if let Ok(mut sessions) = store.lock() { sessions.remove(&id); }
        if let Ok(mut logs) = transcripts.lock() { if let Some(t) = logs.get_mut(&id) { t.open = false; } }
        let result = child.wait();
        let _ = output.send(TerminalEvent { id, data: vec![], exit_code: result.as_ref().ok().map(|s| s.exit_code()), error: result.err().map(|e| e.to_string()) });
    });
    Ok(id)
}
#[tauri::command]
pub fn terminal_write(state: State<'_, Terminals>, id: u64, data: String) -> Result<(), String> {
    if data.len() > 1024 * 1024 { return Err("Terminal input too large".into()); }
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("Terminal is closed")?;
    session.writer.write_all(data.as_bytes()).and_then(|_| session.writer.flush()).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn terminal_resize(state: State<'_, Terminals>, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.0.lock().map_err(|e| e.to_string())?;
    sessions.get(&id).ok_or("Terminal is closed")?.master.resize(size(cols, rows)?).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn terminal_close(state: State<'_, Terminals>, id: u64) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    if let Ok(mut logs) = state.1.lock() { if let Some(t) = logs.get_mut(&id) { t.open = false; } }
    Ok(())
}
pub fn shutdown(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<Terminals>() {
        if let Ok(mut sessions) = state.0.lock() { sessions.clear(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn dimensions_are_bounded() {
        assert!(size(80, 24).is_ok());
        assert!(size(0, 24).is_err());
        assert!(size(80, 301).is_err());
    }
    #[cfg(unix)]
    #[test] fn closing_session_terminates_shell() {
        let pair = native_pty_system().openpty(size(80,24).unwrap()).unwrap();
        let writer = pair.master.take_writer().unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-i"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let session = Session { master: pair.master, writer, killer: child.clone_killer(), pid: child.process_id() };
        drop(session);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            if child.try_wait().unwrap().is_some() { break; }
            assert!(std::time::Instant::now() < deadline, "shell survived session close");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    #[cfg(unix)]
    #[test] fn pty_streams_output_from_requested_directory() {
        let temp = tempfile::tempdir().unwrap();
        let pair = native_pty_system().openpty(size(80,24).unwrap()).unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "printf 'PTY_OK\\n'; pwd"]);
        cmd.cwd(temp.path());
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut bytes = vec![];
        let mut chunk = [0u8; 1024];
        loop { match reader.read(&mut chunk) { Ok(0) | Err(_) => break, Ok(n) => bytes.extend_from_slice(&chunk[..n]) } }
        assert!(child.wait().unwrap().success());
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("PTY_OK"));
        assert!(text.contains(temp.path().canonicalize().unwrap().to_str().unwrap()));
    }
    #[test] fn transcript_is_bounded_and_removes_terminal_control_sequences() {
        let mut t = Transcript { root: "root".into(), bytes: VecDeque::new(), open: true };
        append(&mut t, &vec![b'x'; MAX_TRANSCRIPT + 20]);
        assert_eq!(t.bytes.len(), MAX_TRANSCRIPT);
        assert_eq!(plain_terminal(b"\x1b[31merror\x1b[0m\r\n\x1b]0;title\x07next"), "error\nnext");
        assert_eq!(plain_terminal("привет\nмир".as_bytes()), "привет\nмир");
        assert_eq!(plain_terminal(b"a\n\nb"), "a\n\nb");
    }

    #[test] fn terminal_tail_is_workspace_scoped_and_counts_sanitized_lines() {
        let mut t = Transcript { root:"/root".into(), bytes:VecDeque::new(), open:false };
        append(&mut t, "first\n\u{1b}[31mошибка\u{1b}[0m\nlast\n".as_bytes());
        assert_eq!(tail_for_root("/root",&t,2).unwrap(), "ошибка\nlast");
        assert!(tail_for_root("/other",&t,2).is_err());
        assert!(tail_for_root("/root",&t,501).is_err());
        assert!(tail_for_root("/root",&t,0).is_err());
    }

}
