//! One owner of the mouse and keyboard per Mac user, across every Gustaf build and instance.
//!
//! An advisory `flock` on a file every build finds at the same path. The kernel drops the lock
//! when its process ends, however it ends, so a crash never leaves the Mac claimed.

use std::fs::File;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Written into the file so a refused claimant can say who holds the Mac.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Holder {
    pub pid: u32,
    pub app: String,
    pub owner: String,
}

#[derive(Debug)]
pub(crate) enum Refused {
    /// Held elsewhere; the holder when its file could be read.
    Busy(Option<Holder>),
    Failed(String),
}

#[derive(Debug)]
pub(crate) struct OwnerLock {
    file: File,
}

impl Drop for OwnerLock {
    fn drop(&mut self) {
        // The lock goes with the descriptor; clearing the file stops a later reader naming us.
        let _ = self.file.set_len(0);
    }
}

#[cfg(unix)]
pub(crate) fn acquire(path: &Path, holder: &Holder) -> Result<OwnerLock, Refused> {
    use std::io::{Read, Seek, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| Refused::Failed(error.to_string()))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)
        .map_err(|error| Refused::Failed(error.to_string()))?;
    // SAFETY: flock on a descriptor this function owns.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EWOULDBLOCK) {
            return Err(Refused::Failed(error.to_string()));
        }
        let mut raw = String::new();
        let _ = file.read_to_string(&mut raw);
        return Err(Refused::Busy(serde_json::from_str(&raw).ok()));
    }
    let record = serde_json::to_vec(holder).map_err(|error| Refused::Failed(error.to_string()))?;
    file.set_len(0)
        .and_then(|()| file.rewind())
        .and_then(|()| file.write_all(&record))
        .map_err(|error| Refused::Failed(error.to_string()))?;
    Ok(OwnerLock { file })
}

#[cfg(not(unix))]
pub(crate) fn acquire(_path: &Path, _holder: &Holder) -> Result<OwnerLock, Refused> {
    Err(Refused::Failed("Computer use requires macOS.".into()))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn holder(owner: &str) -> Holder {
        Holder {
            pid: 7,
            app: "Gustaf".into(),
            owner: owner.into(),
        }
    }

    #[test]
    fn a_second_owner_is_refused_and_told_who_holds_the_mac() {
        let directory = tempdir();
        let path = directory.join("nested/owner.lock");
        let first = acquire(&path, &holder("Thread A")).unwrap();
        // Another open file description, as another Gustaf instance would have.
        match acquire(&path, &holder("Thread B")) {
            Err(Refused::Busy(Some(found))) => assert_eq!(found, holder("Thread A")),
            other => panic!("expected busy, got {other:?}"),
        }
        drop(first);
        let second = acquire(&path, &holder("Thread B")).unwrap();
        drop(second);
        assert_eq!(std::fs::read(&path).unwrap(), b"");
    }

    #[test]
    fn a_record_left_by_a_crashed_owner_does_not_hold_the_mac() {
        let directory = tempdir();
        let path = directory.join("owner.lock");
        std::fs::write(&path, serde_json::to_vec(&holder("Crashed")).unwrap()).unwrap();
        let lock = acquire(&path, &holder("Fresh")).unwrap();
        let written: Holder = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written, holder("Fresh"));
        drop(lock);
    }

    pub(crate) fn tempdir() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gustaf-cu-{}",
            &crate::account::random_token().replace(['-', '_'], "")[..12]
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
}

#[cfg(all(test, unix))]
pub(crate) use tests::tempdir;
