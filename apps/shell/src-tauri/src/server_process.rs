//! The bundled server and everything it starts must end with the app, even when the server
//! ignores a polite request to stop or the shell itself dies.

use std::io;
use std::process::{Child, ChildStdout, Command};
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

/// How long the server gets to shut down cleanly before the rest is killed.
pub(crate) const STOP_GRACE: Duration = Duration::from_secs(8);

pub(crate) struct Server {
    child: Child,
    #[cfg(windows)]
    job: windows_job::Job,
}

impl Server {
    pub(crate) fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(command, 0);
        let child = command.spawn()?;
        // Windows has no process group to signal. A job with kill-on-close takes the
        // server's children down with it, also when the shell is killed.
        #[cfg(windows)]
        let job = windows_job::Job::containing(&child)?;
        Ok(Self {
            child,
            #[cfg(windows)]
            job,
        })
    }

    pub(crate) fn write_stdin(&mut self, script: &str) -> Result<(), String> {
        use std::io::Write;
        self.child
            .stdin
            .as_mut()
            .ok_or("server stdin is missing")?
            .write_all(script.as_bytes())
            .map_err(|e| e.to_string())
    }

    pub(crate) fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub(crate) fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    /// Asks the server to stop, then kills what is left once `grace` has passed.
    pub(crate) fn stop(&mut self, grace: Duration) {
        if !matches!(self.child.try_wait(), Ok(None)) {
            return;
        }
        // Closing a piped stdin is the WSL server's stop signal; give it the grace to exit.
        let wsl = self.child.stdin.take().is_some();
        #[cfg(windows)]
        if wsl {
            let deadline = std::time::Instant::now() + grace;
            while std::time::Instant::now() < deadline {
                if !matches!(self.child.try_wait(), Ok(None)) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        #[cfg(not(windows))]
        let _ = wsl;
        #[cfg(unix)]
        {
            let group = i32::try_from(self.child.id()).ok().map(|pid| -pid);
            if let Some(group) = group {
                unsafe { libc::kill(group, libc::SIGTERM) };
            }
            let deadline = Instant::now() + grace;
            while Instant::now() < deadline {
                if !matches!(self.child.try_wait(), Ok(None)) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if let Some(group) = group {
                unsafe { libc::kill(group, libc::SIGKILL) };
            }
        }
        #[cfg(windows)]
        {
            let _ = grace;
            self.job.terminate();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop(STOP_GRACE);
    }
}

#[cfg(windows)]
mod windows_job {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub(super) struct Job(HANDLE);

    // The handle is only used to terminate or close the job.
    unsafe impl Send for Job {}

    impl Job {
        pub(super) fn containing(child: &Child) -> io::Result<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = Job(job);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                    || AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }
        }

        pub(super) fn terminate(&self) {
            unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;

    fn script(body: &str) -> Command {
        let mut command = Command::new("sh");
        command
            .args(["-c", body])
            .stdin(Stdio::null())
            .stdout(Stdio::piped());
        command
    }

    #[test]
    fn a_server_that_ignores_the_stop_request_is_killed_after_the_grace() {
        let mut server =
            Server::spawn(&mut script("trap '' TERM; while :; do sleep 1; done")).expect("spawn");
        server.stop(Duration::from_millis(300));
        assert!(matches!(server.try_wait(), Ok(Some(_))));
    }

    #[test]
    fn a_server_that_stops_when_asked_is_left_alone_after_that() {
        let mut server = Server::spawn(&mut script("while :; do sleep 1; done")).expect("spawn");
        server.stop(Duration::from_secs(5));
        assert!(matches!(server.try_wait(), Ok(Some(_))));
    }

    #[test]
    fn stopping_ends_the_servers_children_too() {
        let mut server = Server::spawn(&mut script("sleep 300 & echo $!; wait")).expect("spawn");
        let mut line = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(server.take_stdout().expect("stdout")),
            &mut line,
        )
        .expect("child pid");
        let child: i32 = line.trim().parse().expect("pid");
        server.stop(Duration::from_secs(5));
        // Signal 0 only asks whether the process still exists.
        let alive = || unsafe { libc::kill(child, 0) } == 0;
        for _ in 0..100 {
            if !alive() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive());
    }
}
