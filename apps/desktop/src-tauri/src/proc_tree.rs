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
    let out = std::process::Command::new("ps").args(["-A", "-o", "pid=,ppid="]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("ps failed".into());
    }
    Ok(parse_ps(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(unix)]
fn kill_pid(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

/// Kills `pid` and its descendants (deepest first) when `pid` is `app` itself's descendant. Returns the pids signalled.
#[cfg(unix)]
pub fn kill_tree_below(app: u32, pid: u32) -> Result<Vec<u32>, String> {
    if pid <= 1 || pid == app {
        return Err("refusing to kill that process".into());
    }
    let table = process_table()?;
    if !descendants(&table, app).contains(&pid) {
        return Err("not a child process of this app".into());
    }
    let mut killed = descendants(&table, pid);
    killed.push(pid);
    for &p in &killed {
        kill_pid(p);
    }
    Ok(killed)
}

#[cfg(windows)]
pub fn kill_tree_below(app: u32, pid: u32) -> Result<Vec<u32>, String> {
    if pid <= 4 || pid == app {
        return Err("refusing to kill that process".into());
    }
    let out = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(vec![pid]) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
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
        let table = [(1, 0), (10, 1), (11, 10), (12, 11), (13, 12), (14, 10), (20, 1), (21, 20)];
        let d = descendants(&table, 10);
        assert_eq!(d.len(), 4);
        assert!(!d.contains(&10) && !d.contains(&20) && !d.contains(&21));
        let pos = |p: u32| d.iter().position(|&x| x == p).unwrap();
        assert!(pos(13) < pos(12) && pos(12) < pos(11), "children before parents: {d:?}");
        assert!(descendants(&table, 99).is_empty());
    }

    #[test]
    fn a_cycle_in_the_table_terminates() {
        let table = [(2, 3), (3, 2), (5, 2)];
        let d = descendants(&table, 2);
        assert!(d.contains(&3) && d.contains(&5));
    }

    #[test]
    fn parses_ps_output() {
        assert_eq!(parse_ps("  1     0\n 42     1\nbad line\n"), vec![(1, 0), (42, 1)]);
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
        let mut child = Command::new("sh").args(["-c", "sleep 60 & sleep 60 & wait"]).stdout(Stdio::null()).spawn().unwrap();
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
        assert!(grandchildren.len() >= 2, "the shell should have started two sleeps");
        assert!(kill_tree_below(me, 1).is_err(), "pid 1 is refused");
        assert!(kill_tree_below(me, me).is_err(), "the app itself is refused");
        let killed = kill_tree_below(me, pid).unwrap();
        assert!(killed.contains(&pid) && grandchildren.iter().all(|g| killed.contains(g)));
        child.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while grandchildren.iter().any(|&g| alive(g) && !is_zombie(g)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(grandchildren.iter().all(|&g| !alive(g) || is_zombie(g)), "grandchildren are gone");
        assert!(kill_tree_below(me, pid).is_err(), "a finished process is not ours any more");
    }

    /// A killed grandchild stays a zombie until init reaps it; it is dead for our purposes.
    #[cfg(unix)]
    fn is_zombie(pid: u32) -> bool {
        let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
        let s = String::from_utf8_lossy(&out.stdout);
        s.trim().is_empty() || s.trim().starts_with('Z')
    }
}
