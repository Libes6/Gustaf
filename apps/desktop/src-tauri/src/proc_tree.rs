//! Kills a process and everything below it. The shell plugin's `child.kill()` ends only the direct child, so a CLI
//! subagent (Codex, Claude Code, Cursor Agent) that is stopped or over its budget would leave the commands it started
//! running. The commands only touch descendants of this app: a pid that is not one is refused. Stopping is graceful
//! (`term`) or forced (`kill`); the process ledger (proc_ledger.rs) uses the same paths on quit and after a crash.

use std::collections::HashMap;

/// Descendants of `root` taken from a `(pid, parent pid)` table, deepest first (children before their parents), without `root`.
pub fn descendants(table: &[(u32, u32)], root: u32) -> Vec<u32> {
    let mut kids: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, ppid) in table {
        if pid != ppid {
            kids.entry(ppid).or_default().push(pid);
        }
    }
    let mut order = Vec::new();
    let mut queue = vec![root];
    while let Some(p) = queue.pop() {
        for &c in kids.get(&p).into_iter().flatten() {
            // A pid table read while processes come and go can contain a cycle; never visit one twice.
            if c != root && !order.contains(&c) {
                order.push(c);
                queue.push(c);
            }
        }
    }
    order.reverse();
    order
}

/// Parses the output of `ps -A -o pid=,ppid=`.
#[cfg_attr(not(unix), allow(dead_code))] // the `ps` parsing is only used by the unix snapshot (tests run everywhere)
pub fn parse_ps(out: &str) -> Vec<(u32, u32)> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
        })
        .collect()
}

#[cfg(unix)]
fn process_table() -> Result<Vec<(u32, u32)>, String> {
    let out = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,ppid="])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("ps failed".into());
    }
    Ok(parse_ps(&String::from_utf8_lossy(&out.stdout)))
}

/// How a tree is stopped: `Term` asks every process to exit (SIGTERM; `taskkill /T` without /F on Windows), `Kill`
/// ends them (SIGKILL; `taskkill /T /F`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TreeSignal {
    Term,
    Kill,
}

/// A signal sent while stopping a tree (Unix names; the Windows path only uses the plan's shape in tests).
#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sig {
    Term,
    Cont,
    Kill,
}

/// pid 1 (init/launchd), pid 0 (the whole process group on Unix) and the app itself are never signalled. Windows
/// reserves pids up to 4 (Idle, System).
pub fn refused(app: u32, pid: u32) -> bool {
    let floor = if cfg!(windows) { 4 } else { 1 };
    pid <= floor || pid == app
}

/// What may be signalled through the command: only a real descendant of the app.
#[cfg_attr(not(unix), allow(dead_code))] // the descendant check needs the unix process table
pub fn check_target(table: &[(u32, u32)], app: u32, pid: u32) -> Result<(), String> {
    if refused(app, pid) {
        return Err("refusing to signal that process".into());
    }
    if !descendants(table, app).contains(&pid) {
        return Err("not a child process of this app".into());
    }
    Ok(())
}

/// The signals sent to a frozen tree, `pids` deepest first with the root last.
///
/// `Kill`: SIGKILL each. `Term`: SIGTERM each while everything is still stopped (the signal stays pending), then
/// SIGCONT deepest first, so children wake up and handle their SIGTERM before the parent resumes and could react to a
/// dead child by starting a new one.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn signal_plan(signal: TreeSignal, pids: &[u32]) -> Vec<(u32, Sig)> {
    match signal {
        TreeSignal::Kill => pids.iter().map(|&p| (p, Sig::Kill)).collect(),
        TreeSignal::Term => pids
            .iter()
            .map(|&p| (p, Sig::Term))
            .chain(pids.iter().map(|&p| (p, Sig::Cont)))
            .collect(),
    }
}

#[cfg(unix)]
fn signal_pid(pid: u32, sig: i32) {
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

/// Freezes `pid` and every descendant (SIGSTOP, parents before children, re-reading the table until no new descendant
/// shows up) and returns them deepest first with `pid` last. A frozen tree cannot start new children while it is
/// signalled: stopping a live tree child-first would let a parent that is still running (a shell loop, a CLI that
/// restarts its tool) start a new child after the table was read, and that child would survive.
#[cfg(unix)]
fn freeze(pid: u32, table: Vec<(u32, u32)>) -> Vec<u32> {
    signal_pid(pid, libc::SIGSTOP);
    let mut frozen: Vec<u32> = Vec::new();
    let mut table = table;
    for round in 0..5 {
        // Parents first: `descendants` lists children before parents, so walk it backwards.
        let fresh: Vec<u32> = descendants(&table, pid)
            .into_iter()
            .rev()
            .filter(|p| !frozen.contains(p))
            .collect();
        if fresh.is_empty() {
            break;
        }
        for &p in &fresh {
            signal_pid(p, libc::SIGSTOP);
        }
        frozen.extend(fresh);
        if round < 4 {
            table = process_table().unwrap_or_default();
        }
    }
    // Deepest first: every frozen pid, ordered by the last table where possible, then the root.
    let mut order = descendants(&table, pid);
    for p in frozen {
        if !order.contains(&p) {
            order.insert(0, p);
        }
    }
    order.push(pid);
    order
}

/// Members of trees that were sent `Term`, by root pid, with their start times. A later `Kill` of the same root also
/// kills these when they still run with the same start time: a member that ignored SIGTERM after its parent exited is
/// no longer below the root (it was reparented to init), and would otherwise survive the escalation.
#[cfg(unix)]
type Termed = HashMap<u32, Vec<(u32, String)>>;

#[cfg(unix)]
static TERMED: std::sync::Mutex<Option<Termed>> = std::sync::Mutex::new(None);

#[cfg(unix)]
fn remember_termed(root: u32, pids: &[u32]) {
    let Ok(states) = proc_states() else { return };
    let members: Vec<(u32, String)> = pids
        .iter()
        .filter_map(|p| Some((*p, states.get(p)?.start.clone())))
        .collect();
    if let Ok(mut m) = TERMED.lock() {
        m.get_or_insert_with(HashMap::new).insert(root, members);
    }
}

/// Forgets what a `Term` of `root` signalled (the root has exited and its ledger entry is gone).
pub fn forget_termed(root: u32) {
    #[cfg(unix)]
    if let Ok(mut m) = TERMED.lock() {
        if let Some(m) = m.as_mut() {
            m.remove(&root);
        }
    }
    #[cfg(not(unix))]
    let _ = root;
}

/// Kills members remembered from an earlier `Term` of `root` that still run with the same start time.
#[cfg(unix)]
pub fn kill_termed(app: u32, root: u32) -> Vec<u32> {
    let members = TERMED
        .lock()
        .ok()
        .and_then(|mut m| m.as_mut()?.remove(&root))
        .unwrap_or_default();
    if members.is_empty() {
        return Vec::new();
    }
    let Ok(states) = proc_states() else {
        return Vec::new();
    };
    let mut killed = Vec::new();
    for (p, start) in members {
        if refused(app, p) {
            continue;
        }
        if states
            .get(&p)
            .is_some_and(|s| s.start == start && !s.zombie)
        {
            signal_pid(p, libc::SIGKILL);
            killed.push(p);
        }
    }
    killed
}

/// Signals `pid` and its descendants. With `require_descendant` the root must be below `app` (the command path);
/// without it the caller has verified the process by its start time (the ledger: a leftover of a crashed run is no
/// longer below this app). pid <= 1 and the app itself are always refused. Returns the pids signalled.
#[cfg(unix)]
pub fn signal_tree(
    app: u32,
    pid: u32,
    signal: TreeSignal,
    require_descendant: bool,
) -> Result<Vec<u32>, String> {
    if refused(app, pid) {
        return Err("refusing to signal that process".into());
    }
    let table = process_table()?;
    let checked = if require_descendant {
        check_target(&table, app, pid)
    } else if table.iter().any(|&(p, _)| p == pid) {
        Ok(())
    } else {
        Err("no such process".into())
    };
    if let Err(e) = checked {
        // The root may be gone while members that ignored SIGTERM still run: the escalation still reaches them.
        if signal == TreeSignal::Kill {
            let extra = kill_termed(app, pid);
            if !extra.is_empty() {
                return Ok(extra);
            }
        }
        return Err(e);
    }
    let order = freeze(pid, table);
    for (p, s) in signal_plan(signal, &order) {
        signal_pid(
            p,
            match s {
                Sig::Term => libc::SIGTERM,
                Sig::Cont => libc::SIGCONT,
                Sig::Kill => libc::SIGKILL,
            },
        );
    }
    let mut signalled = order;
    match signal {
        TreeSignal::Term => remember_termed(pid, &signalled),
        TreeSignal::Kill => signalled.extend(kill_termed(app, pid)),
    }
    Ok(signalled)
}

/// Windows: `taskkill /T` follows the live parent links only; nothing is remembered.
#[cfg(windows)]
pub fn kill_termed(_app: u32, _root: u32) -> Vec<u32> {
    Vec::new()
}

#[cfg(windows)]
pub fn signal_tree(
    app: u32,
    pid: u32,
    signal: TreeSignal,
    _require_descendant: bool,
) -> Result<Vec<u32>, String> {
    if refused(app, pid) {
        return Err("refusing to signal that process".into());
    }
    let pid_s = pid.to_string();
    let mut args = vec!["/PID", pid_s.as_str(), "/T"];
    if signal == TreeSignal::Kill {
        args.push("/F");
    }
    let out = std::process::Command::new("taskkill")
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(vec![pid])
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Kills `pid` and its descendants when `pid` is a descendant of `app`. Returns the pids signalled.
#[cfg(any(unix, windows))]
pub fn kill_tree_below(app: u32, pid: u32) -> Result<Vec<u32>, String> {
    signal_tree(app, pid, TreeSignal::Kill, true)
}

/// What the ledger needs to know about a running process. `start` identifies it together with the pid: a pid reused
/// by a later process has a different start time.
#[derive(Clone, Debug, PartialEq)]
pub struct ProcState {
    pub ppid: u32,
    /// `ps -o lstart` in the C locale and UTC (whole seconds) on Unix; .NET ticks of the UTC start time on Windows.
    pub start: String,
    pub command: String,
    pub zombie: bool,
}

/// Parses `ps -A -o pid=,ppid=,stat=,lstart=,comm=` (lstart is five words, e.g. `Mon Oct  5 09:46:13 2026`; the
/// command is the rest of the line and may contain spaces).
#[cfg_attr(not(unix), allow(dead_code))]
pub fn parse_states(out: &str) -> HashMap<u32, ProcState> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid: u32 = it.next()?.parse().ok()?;
            let ppid: u32 = it.next()?.parse().ok()?;
            let stat = it.next()?;
            let start: Vec<&str> = it.by_ref().take(5).collect();
            if start.len() < 5 {
                return None;
            }
            let command = it.collect::<Vec<_>>().join(" ");
            Some((
                pid,
                ProcState {
                    ppid,
                    start: start.join(" "),
                    command,
                    zombie: stat.starts_with('Z'),
                },
            ))
        })
        .collect()
}

/// Parses `pid|ppid|startTicks|name` lines printed by the PowerShell query below.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_windows_states(out: &str) -> HashMap<u32, ProcState> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.trim().splitn(4, '|');
            let pid: u32 = it.next()?.trim().parse().ok()?;
            let ppid: u32 = it.next()?.trim().parse().unwrap_or(0);
            let start = it.next()?.trim().to_string();
            if start.is_empty() {
                return None;
            }
            let command = it.next().unwrap_or("").trim().to_string();
            Some((
                pid,
                ProcState {
                    ppid,
                    start,
                    command,
                    zombie: false,
                },
            ))
        })
        .collect()
}

/// Every running process with its parent, start time and command name.
#[cfg(unix)]
pub fn proc_states() -> Result<HashMap<u32, ProcState>, String> {
    let out = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,stat=,lstart=,comm="])
        // lstart is printed in local time: a fixed locale and zone keep it identical across runs and DST changes.
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("ps failed".into());
    }
    Ok(parse_states(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(windows)]
pub fn proc_states() -> Result<HashMap<u32, ProcState>, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // One CIM query: parent pid and creation time for every process (protected ones without a time are skipped; the
    // ledger never records them).
    let script = "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks, $_.Name } }";
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("process query failed".into());
    }
    Ok(parse_windows_states(&String::from_utf8_lossy(&out.stdout)))
}

/// One process of this app's tree, for Settings, Diagnostics. Read-only: nothing here can signal or change a process.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub ppid: u32,
    /// `ps` CPU percentage (a decaying average on macOS, lifetime average on Linux): good enough to spot a runaway.
    pub cpu: f32,
    pub rss_kb: u64,
    pub elapsed_secs: u64,
    /// The command line, cut to `MAX_COMMAND` characters. The UI scrubs secrets before showing it; the environment is never read.
    pub command: String,
    /// True for the app's own process.
    pub is_app: bool,
}

#[cfg_attr(not(unix), allow(dead_code))] // the `ps` parsing is only used by the unix snapshot (tests run everywhere)
const MAX_COMMAND: usize = 400;

/// `[[dd-]hh:]mm:ss` as printed by `ps -o etime`.
#[cfg_attr(not(unix), allow(dead_code))] // the `ps` parsing is only used by the unix snapshot (tests run everywhere)
pub fn parse_etime(s: &str) -> u64 {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().unwrap_or(0), r),
        None => (0, s),
    };
    let mut secs = 0u64;
    for part in rest.split(':') {
        secs = secs * 60 + part.parse::<u64>().unwrap_or(0);
    }
    days * 86_400 + secs
}

/// Parses `ps -A -o pid=,ppid=,pcpu=,rss=,etime=,args=`; the command line is the rest of the line.
#[cfg_attr(not(unix), allow(dead_code))] // the `ps` parsing is only used by the unix snapshot (tests run everywhere)
pub fn parse_snapshot(out: &str) -> Vec<ProcInfo> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let ppid = it.next()?.parse().ok()?;
            let cpu = it.next()?.replace(',', ".").parse().ok()?;
            let rss_kb = it.next()?.parse().ok()?;
            let elapsed_secs = parse_etime(it.next()?);
            let command: String = it
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(MAX_COMMAND)
                .collect();
            Some(ProcInfo {
                pid,
                ppid,
                cpu,
                rss_kb,
                elapsed_secs,
                command,
                is_app: false,
            })
        })
        .collect()
}

/// Keeps only the app process and its descendants (marking the app), so nothing else on the machine is ever returned.
pub fn own_processes(all: Vec<ProcInfo>, app: u32) -> Vec<ProcInfo> {
    let table: Vec<(u32, u32)> = all.iter().map(|p| (p.pid, p.ppid)).collect();
    let mut keep = descendants(&table, app);
    keep.push(app);
    let mut out: Vec<ProcInfo> = all
        .into_iter()
        .filter(|p| keep.contains(&p.pid))
        .map(|mut p| {
            p.is_app = p.pid == app;
            p
        })
        .collect();
    out.sort_by_key(|p| (!p.is_app, p.pid));
    out
}

#[cfg(unix)]
fn snapshot() -> Result<Vec<ProcInfo>, String> {
    let out = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,pcpu=,rss=,etime=,args="])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("ps failed".into());
    }
    Ok(parse_snapshot(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(not(unix))]
fn snapshot() -> Result<Vec<ProcInfo>, String> {
    Err("unsupported".into())
}

/// The app process and everything it started (agent CLIs, MCP servers, the sidecar, shells), with CPU and memory.
#[tauri::command]
pub async fn process_snapshot() -> Result<Vec<ProcInfo>, String> {
    crate::git::blocking(|| Ok(own_processes(snapshot()?, std::process::id()))).await
}

/// The folder for application logs (created on demand) so "Open logs folder" always has something to open.
#[tauri::command]
pub fn app_logs_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Stops a CLI subagent's process and all of its children (SIGKILL on Unix, `taskkill /T /F` on Windows).
#[tauri::command]
pub async fn process_kill_tree(pid: u32) -> Result<Vec<u32>, String> {
    crate::git::blocking(move || kill_tree_below(std::process::id(), pid)).await
}

/// Signals a descendant of the app and everything below it: `term` asks them to exit, `kill` ends them (see
/// `signal_tree`). The agent process host sends `term`, waits, then `kill`.
#[tauri::command]
pub async fn process_signal_tree(pid: u32, signal: TreeSignal) -> Result<Vec<u32>, String> {
    crate::git::blocking(move || signal_tree(std::process::id(), pid, signal, true)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descendants_are_deepest_first_and_exclude_the_root() {
        // 10 -> 11 -> 12 -> 13, 10 -> 14, 20 -> 21 (unrelated)
        let table = [
            (1, 0),
            (10, 1),
            (11, 10),
            (12, 11),
            (13, 12),
            (14, 10),
            (20, 1),
            (21, 20),
        ];
        let d = descendants(&table, 10);
        assert_eq!(d.len(), 4);
        assert!(!d.contains(&10) && !d.contains(&20) && !d.contains(&21));
        let pos = |p: u32| d.iter().position(|&x| x == p).unwrap();
        assert!(
            pos(13) < pos(12) && pos(12) < pos(11),
            "children before parents: {d:?}"
        );
        assert!(descendants(&table, 99).is_empty());
    }

    #[test]
    fn a_cycle_in_the_table_terminates() {
        let table = [(2, 3), (3, 2), (5, 2)];
        let d = descendants(&table, 2);
        assert!(d.contains(&3) && d.contains(&5));
    }

    #[test]
    fn parses_a_snapshot_line_with_a_long_command_and_etime_forms() {
        let out = " 42  1  3.5  20480  01:02:03 /usr/bin/node --token=abc def\n 43 42 0.0 10 2-00:00:01 sh\nbad\n";
        let p = parse_snapshot(out);
        assert_eq!(p.len(), 2);
        assert_eq!(
            (p[0].pid, p[0].ppid, p[0].rss_kb, p[0].elapsed_secs),
            (42, 1, 20480, 3723)
        );
        assert_eq!(p[0].command, "/usr/bin/node --token=abc def");
        assert_eq!(p[1].elapsed_secs, 172_801);
        assert_eq!(parse_etime("05:09"), 309);
    }

    #[test]
    fn the_snapshot_keeps_only_the_app_and_its_descendants() {
        let mk = |pid, ppid| ProcInfo {
            pid,
            ppid,
            cpu: 0.0,
            rss_kb: 1,
            elapsed_secs: 1,
            command: String::new(),
            is_app: false,
        };
        // 10 is the app: 10 -> 11 -> 12; 20 -> 21 belongs to somebody else; 1 is init.
        let all = vec![
            mk(21, 20),
            mk(12, 11),
            mk(1, 0),
            mk(10, 1),
            mk(11, 10),
            mk(20, 1),
        ];
        let own = own_processes(all, 10);
        assert_eq!(
            own.iter().map(|p| p.pid).collect::<Vec<_>>(),
            vec![10, 11, 12]
        );
        assert!(own[0].is_app && !own[1].is_app);
        assert!(own_processes(vec![mk(20, 1)], 10).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_live_snapshot_starts_with_this_process() {
        let me = std::process::id();
        let own = own_processes(snapshot().unwrap(), me);
        assert_eq!(own[0].pid, me);
        assert_eq!(own.iter().filter(|p| p.is_app).count(), 1);
    }

    #[test]
    fn parses_ps_output() {
        assert_eq!(
            parse_ps("  1     0\n 42     1\nbad line\n"),
            vec![(1, 0), (42, 1)]
        );
    }

    #[cfg(unix)]
    fn alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[cfg(unix)]
    #[test]
    fn kills_a_child_and_its_grandchildren_but_refuses_strangers() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        // sh runs two background sleeps (its children) and waits for them.
        let mut child = Command::new("sh")
            .args(["-c", "sleep 60 & sleep 60 & wait"])
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let me = std::process::id();
        let deadline = Instant::now() + Duration::from_secs(5);
        let grandchildren = loop {
            let g = descendants(&process_table().unwrap(), pid);
            if g.len() >= 2 || Instant::now() > deadline {
                break g;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(
            grandchildren.len() >= 2,
            "the shell should have started two sleeps"
        );
        assert!(kill_tree_below(me, 1).is_err(), "pid 1 is refused");
        assert!(
            kill_tree_below(me, me).is_err(),
            "the app itself is refused"
        );
        let killed = kill_tree_below(me, pid).unwrap();
        assert!(killed.contains(&pid) && grandchildren.iter().all(|g| killed.contains(g)));
        child.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while grandchildren.iter().any(|&g| alive(g) && !is_zombie(g)) && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            grandchildren.iter().all(|&g| !alive(g) || is_zombie(g)),
            "grandchildren are gone"
        );
        assert!(
            kill_tree_below(me, pid).is_err(),
            "a finished process is not ours any more"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_parent_that_restarts_its_child_leaves_nothing_behind() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        // A loop that starts a new sleep as soon as the old one dies: killed child-first it could respawn one.
        let marker = format!("{}.{}", 600 + std::process::id() % 100, 4242);
        let mut child = Command::new("sh")
            .args(["-c", &format!("while :; do sleep {marker}; done")])
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let deadline = Instant::now() + Duration::from_secs(5);
        while descendants(&process_table().unwrap(), pid).is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        kill_tree_below(std::process::id(), pid).unwrap();
        child.wait().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let out = Command::new("pgrep")
            .args(["-f", &format!("sleep {marker}")])
            .output()
            .unwrap();
        let left: Vec<u32> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().parse().ok())
            .filter(|&p| !is_zombie(p))
            .collect();
        assert!(left.is_empty(), "no sleep survives: {left:?}");
    }

    /// A killed grandchild stays a zombie until init reaps it; it is dead for our purposes.
    #[cfg(unix)]
    fn is_zombie(pid: u32) -> bool {
        let out = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        let s = String::from_utf8_lossy(&out.stdout);
        s.trim().is_empty() || s.trim().starts_with('Z')
    }

    #[test]
    fn refuses_init_the_app_and_strangers() {
        // 10 is the app: 10 -> 11 -> 12; 20 belongs to somebody else.
        let table = [(1, 0), (10, 1), (11, 10), (12, 11), (20, 1)];
        assert!(check_target(&table, 10, 0).is_err());
        assert!(check_target(&table, 10, 1).is_err());
        assert!(check_target(&table, 10, 10).is_err());
        assert!(check_target(&table, 10, 20).is_err());
        assert!(check_target(&table, 10, 99).is_err());
        assert!(check_target(&table, 10, 11).is_ok());
        assert!(check_target(&table, 10, 12).is_ok());
        assert!(refused(10, 1) && refused(10, 10) && !refused(10, 11));
    }

    #[test]
    fn term_signals_everything_before_any_process_resumes_children_first() {
        let tree = [13, 12, 11];
        assert_eq!(
            signal_plan(TreeSignal::Kill, &tree),
            vec![(13, Sig::Kill), (12, Sig::Kill), (11, Sig::Kill)]
        );
        assert_eq!(
            signal_plan(TreeSignal::Term, &tree),
            vec![
                (13, Sig::Term),
                (12, Sig::Term),
                (11, Sig::Term),
                (13, Sig::Cont),
                (12, Sig::Cont),
                (11, Sig::Cont)
            ]
        );
        let s: TreeSignal = serde_json::from_str("\"term\"").unwrap();
        assert_eq!(s, TreeSignal::Term);
        assert!(serde_json::from_str::<TreeSignal>("\"hup\"").is_err());
    }

    #[test]
    fn parses_process_states_with_start_times() {
        let out = "    1     0 Ss   Mon Oct  5 09:46:13 2026     /sbin/launchd\n  42     1 Z+   Thu Oct  8 12:00:01 2026 /Applications/Visual Studio Code.app/x\nbad\n 7 1 S Mon Oct\n";
        let t = parse_states(out);
        assert_eq!(t.len(), 2);
        assert_eq!(t[&1].start, "Mon Oct 5 09:46:13 2026");
        assert_eq!(t[&1].command, "/sbin/launchd");
        assert!(!t[&1].zombie);
        assert_eq!(t[&42].ppid, 1);
        assert!(t[&42].zombie);
        assert_eq!(t[&42].command, "/Applications/Visual Studio Code.app/x");

        let w = parse_windows_states("4|0|638000000000000000|System\r\n100|4|638000000000000001|claude.exe\r\n5|1||x\r\nbad\r\n");
        assert_eq!(w.len(), 2);
        assert_eq!(w[&100].start, "638000000000000001");
        assert_eq!(w[&100].command, "claude.exe");
    }

    #[cfg(unix)]
    #[test]
    fn the_live_state_table_has_this_process_with_a_stable_start_time() {
        let me = std::process::id();
        let a = proc_states().unwrap();
        let b = proc_states().unwrap();
        assert!(!a[&me].start.is_empty());
        assert_eq!(a[&me].start, b[&me].start);
    }

    /// Waits until `pids` are gone (a zombie counts as gone) and returns those still running.
    #[cfg(unix)]
    fn survivors(pids: &[u32]) -> Vec<u32> {
        use std::time::{Duration, Instant};
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let left: Vec<u32> = pids
                .iter()
                .copied()
                .filter(|&p| alive(p) && !is_zombie(p))
                .collect();
            if left.is_empty() || Instant::now() > deadline {
                return left;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    fn spawn_tree(script: &str, kids: usize) -> (std::process::Child, Vec<u32>) {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        let child = Command::new("sh")
            .args(["-c", script])
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let deadline = Instant::now() + Duration::from_secs(5);
        let below = loop {
            let g = descendants(&process_table().unwrap(), pid);
            if g.len() >= kids || Instant::now() > deadline {
                break g;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(
            below.len() >= kids,
            "the shell should have started {kids} children"
        );
        (child, below)
    }

    #[cfg(unix)]
    #[test]
    fn term_stops_a_shell_and_its_background_children() {
        let me = std::process::id();
        let (mut child, kids) = spawn_tree("sleep 30 & sleep 30", 1);
        let pid = child.id();
        assert!(signal_tree(me, 1, TreeSignal::Term, true).is_err());
        assert!(signal_tree(me, me, TreeSignal::Term, true).is_err());
        assert!(signal_tree(me, 1, TreeSignal::Term, false).is_err());
        let signalled = signal_tree(me, pid, TreeSignal::Term, true).unwrap();
        assert!(signalled.contains(&pid));
        child.wait().unwrap();
        assert!(survivors(&kids).is_empty(), "sleeps are gone");
        forget_termed(pid);
    }

    /// Children that ignore SIGTERM survive `term`, even after their parent exited and they were reparented; the
    /// `kill` that follows still reaches them through the start times recorded at `term`.
    #[cfg(unix)]
    #[test]
    fn kill_after_term_reaches_members_that_ignored_it() {
        let me = std::process::id();
        let (mut child, kids) = spawn_tree("trap '' TERM; sleep 30 & sleep 30 & exec sleep 30", 2);
        let pid = child.id();
        signal_tree(me, pid, TreeSignal::Term, true).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            kids.iter().all(|&k| alive(k) && !is_zombie(k)),
            "SIGTERM is ignored"
        );
        signal_tree(me, pid, TreeSignal::Kill, true).unwrap();
        child.wait().unwrap();
        assert!(survivors(&kids).is_empty(), "sleeps are gone");

        // Root gone first: `kill` of a root that already exited kills only the recorded members.
        let (mut child, kids) = spawn_tree("trap '' TERM; sleep 30 & sleep 30 & wait", 2);
        let pid = child.id();
        signal_tree(me, pid, TreeSignal::Term, true).unwrap();
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
        child.wait().unwrap();
        assert!(kids.iter().all(|&k| alive(k) && !is_zombie(k)));
        let killed = signal_tree(me, pid, TreeSignal::Kill, true).unwrap();
        assert!(kids.iter().all(|k| killed.contains(k)), "{killed:?}");
        assert!(survivors(&kids).is_empty(), "orphaned sleeps are gone");
    }
}
