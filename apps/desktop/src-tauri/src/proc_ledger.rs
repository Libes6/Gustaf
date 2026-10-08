//! Process ledger: every agent process the UI starts (CLI turns, live sessions, the sidecar) is recorded here with its
//! start time, in memory and in `process-ledger.json` in the app data folder. On quit the app stops the trees of its
//! live entries (SIGTERM, a short grace, then SIGKILL). After a crash or a force quit the next start finds the entries
//! of the dead run and stops whatever is left of them.
//!
//! Identity is always a pid together with its start time, so a pid the OS has given to another process is never
//! touched: an entry is acted on only when its owner app (pid + start time) is gone and the recorded process still runs
//! with the same start time. pid <= 1 and this app are refused. Modelled on T3 Code's OpenCodeServerLedger (MIT).

use crate::proc_tree::{self, ProcState, TreeSignal};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const FILE: &str = "process-ledger.json";
const VERSION: u32 = 1;
/// How long processes get to exit after SIGTERM on quit and on recovery before they are killed.
const GRACE: Duration = Duration::from_millis(1000);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub pid: u32,
    pub start_time: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub pid: u32,
    pub start_time: String,
    /// The command name (diagnostics only; never used to decide anything).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// The app process that started it. Entries of a live owner are never touched.
    pub owner: Identity,
}

#[derive(Serialize, Deserialize)]
struct LedgerFile {
    version: u32,
    entries: Vec<Entry>,
}

/// Reads the file's content. Anything unreadable (an older or newer format, a torn write) is treated as empty: the
/// ledger only ever adds safety, losing it must not stop the app.
pub fn parse(text: &str) -> Vec<Entry> {
    match serde_json::from_str::<LedgerFile>(text) {
        Ok(f) if f.version == VERSION => f.entries,
        _ => Vec::new(),
    }
}

pub fn serialize(entries: &[Entry]) -> String {
    serde_json::to_string_pretty(&LedgerFile {
        version: VERSION,
        entries: entries.to_vec(),
    })
    .unwrap_or_default()
}

/// Whether `id` names a process that runs now (a zombie has exited).
pub fn is_live(id: &Identity, table: &HashMap<u32, ProcState>) -> bool {
    table
        .get(&id.pid)
        .is_some_and(|s| !s.zombie && !id.start_time.is_empty() && s.start == id.start_time)
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// The owner (this app or another live instance) still runs: leave the entry alone.
    Keep,
    /// The owner is gone and so is the process (or its pid now belongs to another process): forget the entry.
    Drop,
    /// The owner is gone and the process still runs with the recorded start time: stop its tree, then forget it.
    Stop,
}

/// What a start does with an entry found in the file, given the current process table and this app's identity.
pub fn decide(entry: &Entry, me: &Identity, table: &HashMap<u32, ProcState>) -> Verdict {
    if entry.owner == *me || is_live(&entry.owner, table) {
        return Verdict::Keep;
    }
    if proc_tree::refused(me.pid, entry.pid) {
        return Verdict::Drop;
    }
    let id = Identity {
        pid: entry.pid,
        start_time: entry.start_time.clone(),
    };
    if is_live(&id, table) {
        Verdict::Stop
    } else {
        Verdict::Drop
    }
}

/// The ledger of this app run. `me` has an empty start time when it could not be read; nothing is recorded then.
pub struct Ledger {
    path: PathBuf,
    me: Identity,
    /// This run's entries. The lock also serialises writes of the file.
    entries: Mutex<Vec<Entry>>,
}

impl Ledger {
    pub fn new(path: PathBuf, me: Identity) -> Self {
        Self {
            path,
            me,
            entries: Mutex::new(Vec::new()),
        }
    }

    fn read_file(&self) -> Vec<Entry> {
        std::fs::read_to_string(&self.path)
            .map(|t| parse(&t))
            .unwrap_or_default()
    }

    /// Writes this run's entries next to the other owners' entries in the file (another instance of the app may share
    /// it); `drop` removes stale entries of dead owners. Atomic: a temp file renamed over the old one.
    fn persist(&self, ours: &[Entry], drop: &[Entry]) {
        let mut all: Vec<Entry> = self
            .read_file()
            .into_iter()
            .filter(|e| e.owner != self.me && !drop.contains(e))
            .collect();
        all.extend(ours.iter().cloned());
        if all.is_empty() {
            let _ = std::fs::remove_file(&self.path);
            return;
        }
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, serialize(&all)).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }

    /// Records `pid` when it is a running descendant of this app (anything else is refused, so the file can never make
    /// a later start signal a stranger).
    pub fn add(&self, pid: u32, table: &HashMap<u32, ProcState>) -> Result<(), String> {
        if self.me.start_time.is_empty() {
            return Err("the process ledger is unavailable".into());
        }
        let pairs: Vec<(u32, u32)> = table.iter().map(|(&p, s)| (p, s.ppid)).collect();
        proc_tree::check_target(&pairs, self.me.pid, pid)?;
        let state = table.get(&pid).ok_or("no such process")?;
        let entry = Entry {
            pid,
            start_time: state.start.clone(),
            command: Some(state.command.clone()).filter(|c| !c.is_empty()),
            owner: self.me.clone(),
        };
        let mut ours = self.entries.lock().map_err(|e| e.to_string())?;
        ours.retain(|e| e.pid != pid);
        ours.push(entry);
        self.persist(&ours, &[]);
        Ok(())
    }

    pub fn remove(&self, pid: u32) {
        proc_tree::forget_termed(pid);
        if let Ok(mut ours) = self.entries.lock() {
            let before = ours.len();
            ours.retain(|e| e.pid != pid);
            if ours.len() != before {
                self.persist(&ours, &[]);
            }
        }
    }

    /// On start: forgets the entries of dead owners and returns those whose process still runs, to be stopped.
    pub fn take_stale(&self, table: &HashMap<u32, ProcState>) -> Vec<Entry> {
        let Ok(ours) = self.entries.lock() else {
            return Vec::new();
        };
        let mut stale = Vec::new();
        let mut gone = Vec::new();
        for e in self.read_file() {
            match decide(&e, &self.me, table) {
                Verdict::Keep => {}
                Verdict::Drop => gone.push(e),
                Verdict::Stop => {
                    gone.push(e.clone());
                    stale.push(e);
                }
            }
        }
        if !gone.is_empty() {
            self.persist(&ours, &gone);
        }
        stale
    }

    /// On quit: this run's entries, forgotten in memory and in the file.
    pub fn take_own(&self) -> Vec<Entry> {
        let Ok(mut ours) = self.entries.lock() else {
            return Vec::new();
        };
        let taken = std::mem::take(&mut *ours);
        if !taken.is_empty() {
            self.persist(&[], &[]);
        }
        taken
    }
}

/// SIGTERM to the tree of every entry that still runs with its recorded start time, up to `GRACE` for them to exit,
/// then SIGKILL to what is left (including members that ignored SIGTERM after their parent exited).
fn stop_entries(entries: &[Entry]) {
    let app = std::process::id();
    let ids = |list: &[Entry]| -> Vec<Identity> {
        list.iter()
            .map(|e| Identity {
                pid: e.pid,
                start_time: e.start_time.clone(),
            })
            .collect()
    };
    let Ok(table) = proc_tree::proc_states() else {
        return;
    };
    let live: Vec<Identity> = ids(entries)
        .into_iter()
        .filter(|id| is_live(id, &table) && !proc_tree::refused(app, id.pid))
        .collect();
    if live.is_empty() {
        return;
    }
    for id in &live {
        let _ = proc_tree::signal_tree(app, id.pid, TreeSignal::Term, false);
    }
    let deadline = Instant::now() + GRACE;
    let mut table = proc_tree::proc_states().unwrap_or_default();
    while live.iter().any(|id| is_live(id, &table)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
        table = proc_tree::proc_states().unwrap_or_default();
    }
    for id in &live {
        if is_live(id, &table) {
            let _ = proc_tree::signal_tree(app, id.pid, TreeSignal::Kill, false);
        } else {
            // The root exited (its pid may already belong to someone else): only members recorded at SIGTERM time
            // that still run with the same start time are killed.
            proc_tree::kill_termed(app, id.pid);
        }
    }
}

fn own_identity() -> Identity {
    let pid = std::process::id();
    let start_time = proc_tree::proc_states()
        .ok()
        .and_then(|t| t.get(&pid).map(|s| s.start.clone()))
        .unwrap_or_default();
    Identity { pid, start_time }
}

/// Opens the ledger in `dir` and, in the background, stops what a crashed earlier run left behind.
pub fn init(app: &tauri::App, dir: &Path) {
    use tauri::Manager;
    let ledger = Ledger::new(dir.join(FILE), own_identity());
    app.manage(ledger);
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        let ledger = handle.state::<Ledger>();
        let Ok(table) = proc_tree::proc_states() else {
            return;
        };
        let stale = ledger.take_stale(&table);
        stop_entries(&stale);
    });
}

/// Stops every live process this run recorded. Called on app exit (and when the main window is destroyed); safe to
/// call more than once.
pub fn shutdown(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(ledger) = app.try_state::<Ledger>() {
        stop_entries(&ledger.take_own());
    }
}

/// Records an agent process started by the UI (see processHost.ts).
#[tauri::command]
pub async fn process_ledger_add(app: tauri::AppHandle, pid: u32) -> Result<(), String> {
    crate::git::blocking(move || {
        use tauri::Manager;
        let table = proc_tree::proc_states()?;
        app.state::<Ledger>().add(pid, &table)
    })
    .await
}

/// Forgets a process that has exited.
#[tauri::command]
pub async fn process_ledger_remove(app: tauri::AppHandle, pid: u32) -> Result<(), String> {
    crate::git::blocking(move || {
        use tauri::Manager;
        app.state::<Ledger>().remove(pid);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(ppid: u32, start: &str) -> ProcState {
        ProcState {
            ppid,
            start: start.into(),
            command: "x".into(),
            zombie: false,
        }
    }

    fn id(pid: u32, start: &str) -> Identity {
        Identity {
            pid,
            start_time: start.into(),
        }
    }

    fn entry(pid: u32, start: &str, owner: Identity) -> Entry {
        Entry {
            pid,
            start_time: start.into(),
            command: Some("claude".into()),
            owner,
        }
    }

    #[test]
    fn the_file_round_trips_and_garbage_reads_as_empty() {
        let e = vec![
            entry(
                42,
                "Mon Oct  5 09:46:13 2026",
                id(10, "Mon Oct  5 09:00:00 2026"),
            ),
            Entry {
                command: None,
                ..entry(43, "s", id(10, "o"))
            },
        ];
        let text = serialize(&e);
        assert!(text.contains("\"startTime\"") && text.contains("\"owner\""));
        assert!(!text.contains("\"command\": null"), "{text}");
        assert_eq!(parse(&text), e);
        assert!(parse("").is_empty());
        assert!(parse("{not json").is_empty());
        assert!(parse(r#"{"version":2,"entries":[]}"#).is_empty());
    }

    #[test]
    fn stale_entries_are_stopped_only_when_owner_is_dead_and_the_start_time_matches() {
        let me = id(500, "now");
        let table: HashMap<u32, ProcState> = [
            (1, st(0, "boot")),
            (500, st(1, "now")),
            (600, st(1, "other-app")),
            (42, st(1, "t42")),
            (43, st(1, "reused")),
            (
                44,
                ProcState {
                    zombie: true,
                    ..st(1, "t44")
                },
            ),
        ]
        .into_iter()
        .collect();
        let dead_owner = id(300, "gone");
        // Owner dead, process alive with the same start time: stop it.
        assert_eq!(
            decide(&entry(42, "t42", dead_owner.clone()), &me, &table),
            Verdict::Stop
        );
        // Owner dead, pid reused by another process: never touch it.
        assert_eq!(
            decide(&entry(43, "t43", dead_owner.clone()), &me, &table),
            Verdict::Drop
        );
        // Owner dead, process gone or a zombie.
        assert_eq!(
            decide(&entry(45, "t45", dead_owner.clone()), &me, &table),
            Verdict::Drop
        );
        assert_eq!(
            decide(&entry(44, "t44", dead_owner.clone()), &me, &table),
            Verdict::Drop
        );
        // The owner's pid is in use by a later process (different start time): the owner is dead.
        assert_eq!(
            decide(&entry(42, "t42", id(600, "old-app")), &me, &table),
            Verdict::Stop
        );
        // A live owner (another instance) and this app's own entries are kept.
        assert_eq!(
            decide(&entry(42, "t42", id(600, "other-app")), &me, &table),
            Verdict::Keep
        );
        assert_eq!(
            decide(&entry(42, "t42", me.clone()), &me, &table),
            Verdict::Keep
        );
        // init and the app itself are never stopped, whatever the file says.
        assert_eq!(
            decide(&entry(1, "boot", dead_owner.clone()), &me, &table),
            Verdict::Drop
        );
        assert_eq!(
            decide(&entry(500, "now", dead_owner.clone()), &me, &table),
            Verdict::Drop
        );
        assert_eq!(
            decide(&entry(0, "", dead_owner), &me, &table),
            Verdict::Drop
        );
    }

    #[test]
    fn the_ledger_keeps_other_owners_and_drops_stale_entries_from_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        let me = id(500, "now");
        let other = entry(77, "t77", id(600, "other-app"));
        let stale = entry(42, "t42", id(300, "gone"));
        let gone = entry(43, "t43", id(300, "gone"));
        std::fs::write(&path, serialize(&[other.clone(), stale.clone(), gone])).unwrap();
        let table: HashMap<u32, ProcState> = [
            (1, st(0, "boot")),
            (500, st(1, "now")),
            (600, st(1, "other-app")),
            (42, st(1, "t42")),
            (501, st(500, "child")),
            (502, st(1, "stranger")),
        ]
        .into_iter()
        .collect();
        let ledger = Ledger::new(path.clone(), me.clone());
        assert_eq!(ledger.take_stale(&table), vec![stale]);
        let read = || parse(&std::fs::read_to_string(&path).unwrap());
        assert_eq!(read(), vec![other.clone()]);

        assert!(ledger.add(502, &table).is_err(), "not a descendant");
        assert!(ledger.add(1, &table).is_err());
        assert!(ledger.add(500, &table).is_err());
        ledger.add(501, &table).unwrap();
        ledger.add(501, &table).unwrap();
        let file = read();
        assert_eq!(file.len(), 2, "{file:?}");
        assert_eq!(file[1].pid, 501);
        assert_eq!(file[1].start_time, "child");
        assert_eq!(file[1].owner, me);

        ledger.remove(501);
        assert_eq!(read(), vec![other.clone()]);
        ledger.add(501, &table).unwrap();
        assert_eq!(ledger.take_own().len(), 1);
        assert_eq!(read(), vec![other]);

        let unknown = Ledger::new(dir.path().join("x.json"), id(500, ""));
        assert!(unknown.add(501, &table).is_err(), "no identity, no records");
    }

    #[test]
    fn an_empty_ledger_removes_its_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        let table: HashMap<u32, ProcState> = [(500, st(1, "now")), (501, st(500, "c"))]
            .into_iter()
            .collect();
        let ledger = Ledger::new(path.clone(), id(500, "now"));
        ledger.add(501, &table).unwrap();
        assert!(path.exists());
        ledger.remove(501);
        assert!(!path.exists());
    }

    /// A crashed run's leftover: an orphaned tree (not below this process) whose owner is dead is stopped on start.
    #[cfg(unix)]
    #[test]
    fn stops_the_tree_of_a_dead_owner_on_start() {
        use std::process::{Command, Stdio};
        let marker = format!("{}.{}", 31, std::process::id() % 1000);
        let mut child = Command::new("sh")
            .args(["-c", &format!("sleep {marker} & sleep {marker} & wait")])
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let deadline = Instant::now() + Duration::from_secs(5);
        let table = loop {
            let t = proc_tree::proc_states().unwrap();
            let kids = t.values().filter(|s| s.ppid == pid).count();
            if kids >= 2 || Instant::now() > deadline {
                break t;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        let start = table[&pid].start.clone();
        std::fs::write(&path, serialize(&[entry(pid, &start, id(999_999, "gone"))])).unwrap();
        let ledger = Ledger::new(path.clone(), own_identity());
        let stale = ledger.take_stale(&table);
        assert_eq!(stale.len(), 1);
        assert!(!path.exists(), "the stale entry is forgotten");
        stop_entries(&stale);
        child.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let left = loop {
            let out = Command::new("pgrep")
                .args(["-f", &format!("sleep {marker}")])
                .output()
                .unwrap();
            let t = proc_tree::proc_states().unwrap();
            let left: Vec<u32> = String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|l| l.trim().parse().ok())
                .filter(|p| t.get(p).is_some_and(|s| !s.zombie))
                .collect();
            if left.is_empty() || Instant::now() > deadline {
                break left;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(left.is_empty(), "no sleep survives: {left:?}");
    }
}
