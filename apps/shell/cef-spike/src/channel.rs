//! The two pipes the server's `DesktopBrowserChannel` expects from the app that started it:
//! newline-delimited `DesktopBrowserEvent`s out, `DesktopBrowserCommand`s in
//! (`packages/contracts/src/desktopBrowser.ts`). The spike starts a driver script in the
//! server's place and hands it the pipes as fds 3 and 4.

use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
use std::sync::Mutex;

use serde_json::Value;

pub const EVENTS_FD: RawFd = 3;
pub const COMMANDS_FD: RawFd = 4;

pub struct Channel {
    events: Mutex<File>,
    pub driver: Mutex<Child>,
}

/// A pipe whose ends sit above the fds the child is given, so `dup2` cannot clobber one.
fn pipe() -> std::io::Result<(RawFd, RawFd)> {
    let mut ends = [0; 2];
    if unsafe { libc::pipe(ends.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let lift = |fd: RawFd| unsafe {
        let lifted = libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10);
        libc::close(fd);
        lifted
    };
    Ok((lift(ends[0]), lift(ends[1])))
}

impl Channel {
    /// Starts `program args…` and calls `on_command` (on a reader thread) for each command line.
    pub fn start(
        program: &str,
        args: &[String],
        on_command: impl Fn(Value) + Send + 'static,
    ) -> std::io::Result<Self> {
        let (events_read, events_write) = pipe()?;
        let (commands_read, commands_write) = pipe()?;
        let mut command = Command::new(program);
        command
            .args(args)
            .env("GUSTAF_DESKTOP_BROWSER_FD", EVENTS_FD.to_string())
            .env("GUSTAF_DESKTOP_BROWSER_CONTROL_FD", COMMANDS_FD.to_string());
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(events_read, EVENTS_FD) < 0
                    || libc::dup2(commands_write, COMMANDS_FD) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let driver = command.spawn()?;
        // SAFETY: each fd is owned here and wrapped exactly once.
        let (events, commands) = unsafe {
            libc::close(events_read);
            libc::close(commands_write);
            (
                File::from_raw_fd(events_write),
                File::from_raw_fd(commands_read),
            )
        };
        std::thread::spawn(move || {
            for line in BufReader::new(commands).lines().map_while(Result::ok) {
                if let Ok(command) = serde_json::from_str::<Value>(&line) {
                    on_command(command);
                }
            }
        });
        Ok(Self {
            events: Mutex::new(events),
            driver: Mutex::new(driver),
        })
    }

    pub fn send(&self, event: &Value) {
        if let Ok(mut events) = self.events.lock() {
            let _ = writeln!(events, "{event}");
        }
    }
}
