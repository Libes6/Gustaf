//! A downloadable module: an archive the app fetches on request, checks against a SHA-256 it was
//! built with, and unpacks under its data directory. Nothing here knows about browsers.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Compiled in, so a tampered download or manifest server cannot change what gets installed.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleManifest {
    pub id: String,
    pub version: String,
    /// `https://`, `http://` or `file://`. Any archive format `tar` reads.
    pub url: String,
    pub sha256: String,
    pub size: u64,
    /// Directory under `<data>/modules/`, one per installed version.
    pub install_dir: String,
}

impl ModuleManifest {
    pub fn embedded() -> Self {
        serde_json::from_str(include_str!("../module.json")).expect("module.json")
    }

    pub fn root(&self, data_dir: &Path) -> PathBuf {
        data_dir
            .join("modules")
            .join(&self.install_dir)
            .join(&self.version)
    }

    /// An install is whole only once its marker names the archive it came from.
    pub fn installed(&self, data_dir: &Path) -> bool {
        fs::read_to_string(self.root(data_dir).join(".installed"))
            .is_ok_and(|marker| marker.trim() == self.sha256)
    }

    pub fn install(
        &self,
        data_dir: &Path,
        progress: &dyn Fn(u64, u64),
    ) -> Result<PathBuf, String> {
        let root = self.root(data_dir);
        if self.installed(data_dir) {
            return Ok(root);
        }
        let parent = root.parent().ok_or("module path")?;
        fs::create_dir_all(parent).map_err(text)?;
        let archive = parent.join(format!("{}.download", self.version));
        let staging = parent.join(format!("{}.staging", self.version));
        let _ = fs::remove_dir_all(&staging);

        let digest = self.fetch(&archive, progress)?;
        if !digest.eq_ignore_ascii_case(&self.sha256) {
            let _ = fs::remove_file(&archive);
            return Err(format!(
                "Module {} failed its integrity check: expected {}, got {digest}",
                self.id, self.sha256
            ));
        }

        fs::create_dir_all(&staging).map_err(text)?;
        run(Command::new("/usr/bin/tar")
            .arg("-xf")
            .arg(&archive)
            .arg("-C")
            .arg(&staging))?;
        let _ = fs::remove_file(&archive);
        // Unpacked code that Gatekeeper treats as downloaded would be refused at launch.
        let _ = Command::new("/usr/bin/xattr")
            .args(["-dr", "com.apple.quarantine"])
            .arg(&staging)
            .status();
        fs::write(staging.join(".installed"), &self.sha256).map_err(text)?;
        let _ = fs::remove_dir_all(&root);
        fs::rename(&staging, &root).map_err(text)?;
        Ok(root)
    }

    fn fetch(&self, to: &Path, progress: &dyn Fn(u64, u64)) -> Result<String, String> {
        let mut source: Box<dyn Read> = match self.url.strip_prefix("file://") {
            Some(path) => Box::new(fs::File::open(path).map_err(text)?),
            None => Box::new(ureq::get(&self.url).call().map_err(text)?.into_reader()),
        };
        let mut file = fs::File::create(to).map_err(text)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 1 << 20];
        let mut done = 0u64;
        loop {
            let read = source.read(&mut buffer).map_err(text)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            file.write_all(&buffer[..read]).map_err(text)?;
            done += read as u64;
            progress(done, self.size);
        }
        Ok(hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }
}

/// Ad-hoc signs every Mach-O bundle of an unpacked module. Only needed when the archive's own
/// signatures did not survive; the spike uses it to measure whether that is ever the case.
pub fn adhoc_sign(root: &Path) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(text)? {
        let path = entry.map_err(text)?.path();
        let bundle = path
            .extension()
            .is_some_and(|extension| extension == "app" || extension == "framework");
        if bundle {
            run(Command::new("/usr/bin/codesign")
                .args(["--force", "--deep", "--sign", "-"])
                .arg(&path))?;
        }
    }
    Ok(())
}

fn run(command: &mut Command) -> Result<(), String> {
    let output = command.output().map_err(text)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{:?} failed: {}",
            command.get_program(),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}
