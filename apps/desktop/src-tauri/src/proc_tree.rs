//! Kills a process and everything below it. The shell plugin's `child.kill()` ends only the direct child, so a CLI
//! subagent (Codex, Claude Code, Cursor Agent) that is stopped or over its budget would leave the commands it started
//! running. The command only touches descendants of this app: a pid that is not one is refused.

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

#[cfg(unix)]
fn signal_pid(pid: u32, sig: i32) {
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

/// Kills `pid` and its descendants when `pid` is `app` itself's descendant. Returns the pids signalled.
///
/// The tree is frozen first (SIGSTOP, parents before children, re-reading the table until no new descendant shows up),
/// then killed deepest first. Killing a live tree child-first would let a parent that is still running (a shell loop, a
/// CLI that restarts its tool) start a new child after the table was read, and that child would survive.
#[cfg(unix)]
pub fn kill_tree_below(app: u32, pid: u32) -> Result<Vec<u32>, String> {
    if pid <= 1 || pid == app {
        return Err("refusing to kill that process".into());
    }
    let table = process_table()?;
    if !descendants(&table, app).contains(&pid) {
        return Err("not a child process of this app".into());
    }
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
    let mut killed = descendants(&table, pid);
    for p in frozen {
        if !killed.contains(&p) {
            killed.insert(0, p);
        }
    }
    killed.push(pid);
    for &p in &killed {
        signal_pid(p, libc::SIGKILL);
    }
    Ok(killed)
}

#[cfg(windows)]
pub fn kill_tree_below(app: u32, pid: u32) -> Result<Vec<u32>, String> {
    if pid <= 4 || pid == app {
        return Err("refusing to kill that process".into());
    }
    let out = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(vec![pid])
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
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

const MAX_COMMAND: usize = 400;

/// `[[dd-]hh:]mm:ss` as printed by `ps -o etime`.
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
}
