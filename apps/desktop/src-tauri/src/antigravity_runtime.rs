//! Managed install of Google's Antigravity ACP agent (`agy_acp_server`). Docs: docs/features/antigravity.md.
//!
//! The user clicks Install and confirms a dialog; only then does this module download ONE pinned archive from
//! `dl.google.com`, check its size and SHA-256, unpack it into a temp folder, probe the executable and move it into
//! `<app data>/antigravity-runtime/<version>/` with a manifest. Nothing is fetched at startup, nothing updates itself,
//! the URL is built from constants (never from fetched JSON), and the only things ever logged are none: errors carry
//! URLs without query strings and byte counts at most.
//!
//! Layout:
//! ```text
//! antigravity-runtime/
//!   .tmp/install/            download.part + download.json (resumable), runtime/ (unpack), work/ (probe home/tmp)
//!   1.3.0/                   agy_acp_server.par, localharness_external, manifest.json
//! ```
//! The pinned sizes and hashes below were copied from T3 Code (MIT, apps/server/src/provider/antigravityRelease.ts,
//! "checked on 2026-10-05"); they were NOT re-checked here because the real archive was never downloaded for this
//! work. A wrong value fails closed (the install reports a size or hash mismatch and keeps nothing).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::Manager;

pub const VERSION: &str = "1.3.0";
const DOWNLOAD_HOST: &str = "dl.google.com";
/// Hosts a redirect may lead to: Google's own download/CDN domains. Integrity does not depend on this (the pinned
/// SHA-256 does); it keeps the request from wandering to hosts that have nothing to do with Google.
const REDIRECT_SUFFIXES: [&str; 4] = [
    "google.com",
    "googleusercontent.com",
    "googleapis.com",
    "gvt1.com",
];
const MAX_REDIRECTS: usize = 5;
const MANIFEST: &str = "manifest.json";
const MAX_JSON_BYTES: u64 = 64 * 1024;
/// Slack on top of archive + unpacked bytes.
const SPACE_MARGIN: u64 = 256 * 1024 * 1024;
/// The `.par` unpacks itself again (about 1 GB) into its temp folder on every launch, including the probe.
const AGENT_UNPACK_HEADROOM: u64 = 1024 * 1024 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(90);

// ---- errors and events -----------------------------------------------------------------------------------------------

/// A failure the UI shows. `code` is stable (the UI maps it to a translated message), `message` is English detail.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct InstallError {
    pub code: &'static str,
    pub message: String,
}

fn err(code: &'static str, message: impl Into<String>) -> InstallError {
    InstallError {
        code,
        message: message.into(),
    }
}

fn io_err(what: &str, e: std::io::Error) -> InstallError {
    // ENOSPC (28) on Unix, ERROR_DISK_FULL (112) on Windows.
    if matches!(e.raw_os_error(), Some(28) | Some(112)) {
        return err("no-space", "The disk is full.");
    }
    err("io", format!("{what}: {e}"))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// `download`, `extract` or `verify`.
    pub phase: &'static str,
    pub received: u64,
    pub total: u64,
}

// ---- the pinned release ----------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct FileSpec {
    pub name: String,
    pub bytes: u64,
}

#[derive(Clone, Debug)]
pub struct Asset {
    pub version: String,
    /// Platform id, e.g. `darwin-arm64`.
    pub platform: String,
    pub url: String,
    pub sha256: String,
    pub archive_bytes: u64,
    /// The executable first, then the `localharness_external` helper. The archive must hold exactly these.
    pub files: Vec<FileSpec>,
}

impl Asset {
    pub fn unpacked_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.bytes).sum()
    }
    pub fn executable(&self) -> &str {
        &self.files[0].name
    }
}

#[derive(Debug, PartialEq)]
pub struct Unsupported {
    pub code: &'static str,
    pub message: &'static str,
}

struct Row {
    os_dir: &'static str,
    suffix: &'static str,
    sha256: &'static str,
    archive_bytes: u64,
    exe: &'static str,
    exe_bytes: u64,
    helper: &'static str,
    helper_bytes: u64,
}

/// `https://dl.google.com/agy-extensions/releases/<macos|linux|windows>/agy-acp-server-<version>-<suffix>.zip`.
pub fn build_url(version: &str, os_dir: &str, suffix: &str) -> String {
    format!(
        "https://{DOWNLOAD_HOST}/agy-extensions/releases/{os_dir}/agy-acp-server-{version}-{suffix}.zip"
    )
}

/// The archive for a host OS/architecture (Rust `std::env::consts` names). Apple Silicon, Linux x64/ARM64 and
/// Windows x64/ARM64 are managed; an Intel Mac is not (see the docs: T3 Code's release table has an x86_64 archive
/// but its user docs list Intel Macs as unsupported for managed install, and it was never run here).
pub fn release_asset(os: &str, arch: &str) -> Result<Asset, Unsupported> {
    let (platform, row) = match (os, arch) {
        ("macos", "aarch64") => (
            "darwin-arm64",
            Row {
                os_dir: "macos",
                suffix: "darwin-arm64",
                sha256: "7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88",
                archive_bytes: 111_456_962,
                exe: "agy_acp_server.par",
                exe_bytes: 278_535_456,
                helper: "localharness_external",
                helper_bytes: 118_611_392,
            },
        ),
        ("macos", "x86_64") => {
            return Err(Unsupported {
                code: "intel-mac",
                message: "Managed install supports Apple Silicon Macs only.",
            })
        }
        ("linux", "x86_64") => (
            "linux-x64",
            Row {
                os_dir: "linux",
                suffix: "linux-x86_64",
                sha256: "9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96",
                archive_bytes: 333_727_150,
                exe: "agy_acp_server.par",
                exe_bytes: 926_533_965,
                helper: "localharness_external",
                helper_bytes: 130_388_040,
            },
        ),
        ("linux", "aarch64") => (
            "linux-arm64",
            Row {
                os_dir: "linux",
                suffix: "linux-arm64",
                sha256: "500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf",
                archive_bytes: 321_690_363,
                exe: "agy_acp_server.par",
                exe_bytes: 930_848_992,
                helper: "localharness_external",
                helper_bytes: 123_224_968,
            },
        ),
        ("windows", "x86_64") => (
            "windows-x64",
            Row {
                os_dir: "windows",
                suffix: "windows-x86_64",
                sha256: "65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9",
                archive_bytes: 124_509_787,
                exe: "agy_acp_server.exe",
                exe_bytes: 81_437_336,
                helper: "localharness_external.exe",
                helper_bytes: 145_548_952,
            },
        ),
        ("windows", "aarch64") => (
            "windows-arm64",
            Row {
                os_dir: "windows",
                suffix: "windows-arm64",
                sha256: "4a0f469720e9beb9438a979f543fdbfad5022ebe0992c052c590bd78b3144ca3",
                archive_bytes: 124_654_803,
                exe: "agy_acp_server.exe",
                exe_bytes: 85_893_472,
                helper: "localharness_external.exe",
                helper_bytes: 135_640_216,
            },
        ),
        _ => {
            return Err(Unsupported {
                code: "platform",
                message: "Managed install is not available for this operating system or CPU.",
            })
        }
    };
    Ok(Asset {
        version: VERSION.into(),
        platform: platform.into(),
        url: build_url(VERSION, row.os_dir, row.suffix),
        sha256: row.sha256.into(),
        archive_bytes: row.archive_bytes,
        files: vec![
            FileSpec {
                name: row.exe.into(),
                bytes: row.exe_bytes,
            },
            FileSpec {
                name: row.helper.into(),
                bytes: row.helper_bytes,
            },
        ],
    })
}

// ---- URL policy ------------------------------------------------------------------------------------------------------

/// Which URLs may be requested. Production: HTTPS on port 443, first request to `dl.google.com` only, redirects to
/// Google domains only. The test policy (compiled in tests only) allows plain HTTP on 127.0.0.1.
#[derive(Clone, Debug)]
pub struct UrlPolicy {
    initial_host: String,
    redirect_suffixes: Vec<String>,
    https_only: bool,
    /// A body that delivers no byte for this long counts as a broken connection.
    stall: Duration,
}

impl UrlPolicy {
    pub fn google() -> Self {
        UrlPolicy {
            initial_host: DOWNLOAD_HOST.into(),
            redirect_suffixes: REDIRECT_SUFFIXES.iter().map(|s| s.to_string()).collect(),
            https_only: true,
            stall: Duration::from_secs(30),
        }
    }
    #[cfg(test)]
    fn loopback() -> Self {
        UrlPolicy {
            initial_host: "127.0.0.1".into(),
            redirect_suffixes: vec!["127.0.0.1".into()],
            https_only: false,
            stall: Duration::from_secs(2),
        }
    }

    fn check(&self, url: &reqwest::Url, redirect: bool) -> Result<(), String> {
        let host = url.host_str().unwrap_or("").to_ascii_lowercase();
        if self.https_only && url.scheme() != "https" {
            return Err("only https downloads are allowed".into());
        }
        if !self.https_only && url.scheme() != "https" && url.scheme() != "http" {
            return Err("unsupported URL scheme".into());
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("URLs with credentials are refused".into());
        }
        if self.https_only && url.port().is_some() {
            return Err("a custom port is refused".into());
        }
        let ok = if redirect {
            self.redirect_suffixes
                .iter()
                .any(|s| host == *s || host.ends_with(&format!(".{s}")))
        } else {
            host == self.initial_host
        };
        if ok {
            Ok(())
        } else {
            Err(format!("the host {host} is not allowed"))
        }
    }
}

/// A URL for messages: no query string, no fragment, no credentials.
pub fn display_url(url: &reqwest::Url) -> String {
    let mut u = url.clone();
    u.set_query(None);
    u.set_fragment(None);
    let _ = u.set_username("");
    let _ = u.set_password(None);
    u.to_string()
}

// ---- disk space and resume decisions ---------------------------------------------------------------------------------

/// Bytes needed while installing: the archive and the unpacked files coexist briefly, plus slack and the agent's own
/// self-unpack during the probe.
pub fn required_bytes(a: &Asset) -> u64 {
    a.archive_bytes + a.unpacked_bytes() + SPACE_MARGIN + AGENT_UNPACK_HEADROOM
}

/// `available == None` (could not be determined) lets the install go on; the OS reports a full disk anyway.
pub fn space_check(available: Option<u64>, required: u64) -> Result<(), InstallError> {
    match available {
        Some(a) if a < required => Err(err(
            "no-space",
            format!(
                "At least {} MB of free disk space is needed, {} MB is free.",
                required / 1_000_000,
                a / 1_000_000
            ),
        )),
        _ => Ok(()),
    }
}

#[cfg(unix)]
fn available_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid NUL-terminated path and `st` a properly sized out-parameter.
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
}

#[cfg(not(unix))]
fn available_bytes(_path: &Path) -> Option<u64> {
    // No free-space probe on Windows yet; a full disk surfaces as a "disk is full" write error.
    None
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PartMeta {
    pub url: String,
    pub etag: String,
    pub total: u64,
}

#[derive(Debug, PartialEq)]
pub enum Resume {
    Fresh,
    From(u64),
}

/// A partial download continues only when it provably belongs to the same archive: same URL, same expected size, a
/// strong ETag recorded from the first response, and a non-empty file shorter than the whole. The server must still
/// confirm with `If-Range` + `206` + a matching `Content-Range`; the final SHA-256 covers everything else.
pub fn resume_decision(meta: Option<&PartMeta>, part_len: Option<u64>, a: &Asset) -> Resume {
    match (meta, part_len) {
        (Some(m), Some(len))
            if m.url == a.url
                && m.total == a.archive_bytes
                && !m.etag.is_empty()
                && !m.etag.starts_with("W/")
                && len > 0
                && len < a.archive_bytes =>
        {
            Resume::From(len)
        }
        _ => Resume::Fresh,
    }
}

// ---- cancel ----------------------------------------------------------------------------------------------------------

#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    fn check(&self) -> Result<(), InstallError> {
        if self.0.load(Ordering::SeqCst) {
            Err(err("cancelled", "Installation cancelled."))
        } else {
            Ok(())
        }
    }
}

// ---- download --------------------------------------------------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn read_meta(path: &Path) -> Option<PartMeta> {
    let f = File::open(path).ok()?;
    let mut s = String::new();
    f.take(MAX_JSON_BYTES).read_to_string(&mut s).ok()?;
    serde_json::from_str(&s).ok()
}

fn client(policy: &UrlPolicy) -> Result<reqwest::blocking::Client, InstallError> {
    let p = policy.clone();
    let redirect = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.error("too many redirects");
        }
        match p.check(attempt.url(), true) {
            Ok(()) => attempt.follow(),
            Err(why) => attempt.error(why),
        }
    });
    reqwest::blocking::Client::builder()
        .redirect(redirect)
        .connect_timeout(Duration::from_secs(20))
        // A backstop for the whole transfer (hundreds of MB on slow lines); stalls are caught earlier, see `download`.
        .timeout(Duration::from_secs(45 * 60))
        .user_agent(concat!("Gustaf/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| err("network", format!("Could not start the download: {e}")))
}

fn send_error(e: reqwest::Error, url: &reqwest::Url) -> InstallError {
    let shown = display_url(url);
    if e.is_redirect() {
        return err(
            "redirect",
            format!("The download was redirected somewhere that is not allowed ({shown})."),
        );
    }
    if e.is_connect() || e.is_timeout() {
        return err("offline", format!("Could not reach {shown}."));
    }
    err("network", format!("The download from {shown} failed."))
}

fn content_range(h: &reqwest::header::HeaderMap) -> Option<(u64, u64)> {
    // "bytes <start>-<end>/<total>"
    let v = h.get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?;
    let rest = v.strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (start, _) = range.split_once('-')?;
    Some((start.trim().parse().ok()?, total.trim().parse().ok()?))
}

/// Downloads `asset.url` into `dir/download.part` (resuming when safe) and returns the SHA-256 of the whole file after
/// checking it against the pinned value and size. A network failure keeps the partial file for a retry; a size or hash
/// failure deletes it.
pub fn download(
    policy: &UrlPolicy,
    asset: &Asset,
    dir: &Path,
    cancel: &Cancel,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<String, InstallError> {
    let part = dir.join("download.part");
    let meta_path = dir.join("download.json");
    let url = reqwest::Url::parse(&asset.url).map_err(|_| err("internal", "Bad download URL."))?;
    policy
        .check(&url, false)
        .map_err(|why| err("redirect", format!("Refusing to download: {why}.")))?;
    let total = asset.archive_bytes;

    let part_len = fs::metadata(&part).ok().map(|m| m.len());
    let mut resume = resume_decision(read_meta(&meta_path).as_ref(), part_len, asset);
    let saved_etag = read_meta(&meta_path).map(|m| m.etag).unwrap_or_default();

    let client = client(policy)?;
    let mut req = client
        .get(url.clone())
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    if let Resume::From(n) = resume {
        req = req
            .header(reqwest::header::RANGE, format!("bytes={n}-"))
            .header(reqwest::header::IF_RANGE, saved_etag);
    }
    let mut resp = req.send().map_err(|e| send_error(e, &url))?;
    let status = resp.status().as_u16();
    let headers = resp.headers().clone();

    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut file;
    match (status, &resume) {
        (206, Resume::From(n)) => {
            if content_range(&headers) != Some((*n, total)) {
                let _ = fs::remove_file(&part);
                return Err(err(
                    "network",
                    "The server answered a resume request with a different range. Try again.",
                ));
            }
            // Re-hash what is already on disk, then append.
            let mut old = File::open(&part).map_err(|e| io_err("open partial download", e))?;
            let mut buf = vec![0u8; 256 * 1024];
            let mut left = *n;
            while left > 0 {
                cancel.check()?;
                let want = buf.len().min(left as usize);
                old.read_exact(&mut buf[..want])
                    .map_err(|e| io_err("read partial download", e))?;
                hasher.update(&buf[..want]);
                left -= want as u64;
            }
            received = *n;
            file = OpenOptions::new()
                .append(true)
                .open(&part)
                .map_err(|e| io_err("open partial download", e))?;
        }
        (200, _) => {
            resume = Resume::Fresh;
            // Content-Length is the decoded size only for identity bodies, which is what we asked for.
            let encoding = headers
                .get(reqwest::header::CONTENT_ENCODING)
                .and_then(|v| v.to_str().ok())
                .map(|v| v.trim().to_ascii_lowercase());
            if encoding.as_deref().is_some_and(|e| e != "identity") {
                return Err(err(
                    "size",
                    "The server compressed the download unexpectedly.",
                ));
            }
            if let Some(len) = resp.content_length() {
                if len != total {
                    return Err(err(
                        "size",
                        "The download size does not match the pinned release.",
                    ));
                }
            }
            let _ = fs::remove_file(&part);
            file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&part)
                .map_err(|e| io_err("create download file", e))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&part, fs::Permissions::from_mode(0o600));
            }
        }
        (s, _) => {
            let _ = fs::remove_file(&part);
            return Err(err(
                "http",
                format!("The server answered HTTP {s} for {}.", display_url(&url)),
            ));
        }
    }
    let _ = resume;

    // Record the validator before the body, so an interrupted body can be resumed.
    let etag = headers
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let meta = PartMeta {
        url: asset.url.clone(),
        etag,
        total,
    };
    fs::write(&meta_path, serde_json::to_vec(&meta).unwrap_or_default())
        .map_err(|e| io_err("write download state", e))?;

    // The body is read on a helper thread so a stalled connection can be noticed and Cancel stays responsive.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Option<Vec<u8>>>(8);
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 128 * 1024];
        loop {
            match resp.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(Some(Vec::new()));
                    return;
                }
                Ok(n) => {
                    if tx.send(Some(buf[..n].to_vec())).is_err() {
                        return;
                    }
                }
                Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
            }
        }
    });
    let broken = |received: u64| {
        err(
            "network",
            format!("The connection broke after {received} bytes. Press Install to continue."),
        )
    };
    let mut last = Instant::now();
    let mut last_data = Instant::now();
    progress(received, total);
    loop {
        cancel.check()?;
        let chunk = match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Some(c)) => c,
            Ok(None) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                let _ = file.flush();
                return Err(broken(received));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if last_data.elapsed() > policy.stall {
                    let _ = file.flush();
                    return Err(broken(received));
                }
                continue;
            }
        };
        if chunk.is_empty() {
            break;
        }
        last_data = Instant::now();
        received += chunk.len() as u64;
        if received > total {
            let _ = fs::remove_file(&part);
            let _ = fs::remove_file(&meta_path);
            return Err(err(
                "size",
                "The download is larger than the pinned release.",
            ));
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .map_err(|e| io_err("write download file", e))?;
        if last.elapsed() >= Duration::from_millis(150) {
            last = Instant::now();
            progress(received, total);
        }
    }
    file.flush().map_err(|e| io_err("write download file", e))?;
    drop(file);
    progress(received, total);
    if received < total {
        // A clean EOF before the end: treat it like a broken connection and keep the partial file.
        return Err(err(
            "network",
            format!("The download ended early at {received} of {total} bytes. Press Install to continue."),
        ));
    }
    let digest = hex(&hasher.finalize());
    if digest != asset.sha256 {
        let _ = fs::remove_file(&part);
        let _ = fs::remove_file(&meta_path);
        return Err(err(
            "hash",
            "The download failed its SHA-256 check. Nothing was installed.",
        ));
    }
    Ok(digest)
}

// ---- unpack ----------------------------------------------------------------------------------------------------------

/// Zip-slip guard: a relative path with no empty, `.` or `..` component, no drive letter and no leading separator.
pub fn safe_relative(name: &str) -> bool {
    if name.is_empty() || name.contains('\0') || name.starts_with('/') || name.starts_with('\\') {
        return false;
    }
    // "C:\x", "C:x"
    if name.len() >= 2 && name.as_bytes()[1] == b':' {
        return false;
    }
    name.split(['/', '\\'])
        .all(|c| !c.is_empty() && c != "." && c != "..")
}

/// A member name this installer accepts: safe and flat (the archive has no folders).
pub fn entry_name_ok(name: &str) -> bool {
    safe_relative(name) && !name.contains('/') && !name.contains('\\')
}

#[cfg_attr(not(unix), allow(dead_code))] // only `mark_executables` (Unix) uses it outside the tests
pub fn is_executable_name(name: &str) -> bool {
    name.starts_with("agy_acp_server") || name.starts_with("localharness_external")
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct FileRecord {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

/// Unpacks exactly the pinned files into `dest` (which must be empty or absent). Rejects any other member, a member of
/// another size (the size cap), folders, symlinks and other special files, encrypted members and unsafe names.
pub fn extract(
    archive: &Path,
    asset: &Asset,
    dest: &Path,
    cancel: &Cancel,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Vec<FileRecord>, InstallError> {
    let bad = |m: &str| err("bad-archive", m.to_string());
    let file = File::open(archive).map_err(|e| io_err("open archive", e))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|_| bad("The download is not a valid zip archive."))?;
    if zip.len() != asset.files.len() {
        return Err(bad(
            "The archive must hold exactly the Antigravity executable and its helper.",
        ));
    }
    fs::create_dir_all(dest).map_err(|e| io_err("create folder", e))?;
    let total = asset.unpacked_bytes();
    let mut done: u64 = 0;
    let mut seen = HashSet::new();
    let mut records = Vec::new();
    let mut buf = vec![0u8; 256 * 1024];
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|_| bad("The archive has an unreadable or encrypted member."))?;
        let name = entry
            .name()
            .map(|n| n.to_string())
            .map_err(|_| bad("The archive has an unreadable member name."))?;
        let spec = asset
            .files
            .iter()
            .find(|f| f.name == name)
            .filter(|_| entry_name_ok(&name))
            .ok_or_else(|| bad("The archive has an unexpected or unsafe member name."))?;
        if !seen.insert(name.clone()) {
            return Err(bad("The archive repeats a member."));
        }
        if entry.is_dir() || entry.is_symlink() {
            return Err(bad(
                "The archive has a folder or link where a file is expected.",
            ));
        }
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170000;
            if kind != 0 && kind != 0o100000 {
                return Err(bad(
                    "The archive has a special file where a file is expected.",
                ));
            }
        }
        if entry.size() != spec.bytes {
            return Err(bad("An archive member does not have its pinned size."));
        }
        let path = dest.join(&name);
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| io_err("create file", e))?;
        let mut hasher = Sha256::new();
        let mut written: u64 = 0;
        // One byte past the pinned size is read so an oversized stream is noticed even if the header lied.
        let mut limited = (&mut entry).take(spec.bytes + 1);
        loop {
            cancel.check()?;
            let n = limited
                .read(&mut buf)
                .map_err(|_| bad("The archive is damaged."))?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > spec.bytes {
                return Err(bad("An archive member is larger than its pinned size."));
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])
                .map_err(|e| io_err("write file", e))?;
            done += n as u64;
            progress(done, total);
        }
        if written != spec.bytes {
            return Err(bad("An archive member is truncated."));
        }
        out.flush().map_err(|e| io_err("write file", e))?;
        records.push(FileRecord {
            name,
            bytes: written,
            sha256: hex(&hasher.finalize()),
        });
    }
    Ok(records)
}

/// `chmod 755` for the agent executable and its helper (Unix). Windows needs nothing.
pub fn mark_executables(dir: &Path, files: &[FileRecord]) -> Result<(), InstallError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for f in files.iter().filter(|f| is_executable_name(&f.name)) {
            fs::set_permissions(dir.join(&f.name), fs::Permissions::from_mode(0o755))
                .map_err(|e| io_err("mark executable", e))?;
        }
    }
    #[cfg(not(unix))]
    let _ = (dir, files);
    Ok(())
}

// ---- manifest --------------------------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: String,
    pub platform: String,
    /// Source URL without a query string.
    pub source: String,
    pub archive_sha256: String,
    pub archive_bytes: u64,
    /// Unix seconds.
    pub installed_at: u64,
    pub files: Vec<FileRecord>,
}

fn read_manifest(dir: &Path) -> Option<Manifest> {
    let f = File::open(dir.join(MANIFEST)).ok()?;
    let mut s = String::new();
    f.take(MAX_JSON_BYTES).read_to_string(&mut s).ok()?;
    serde_json::from_str(&s).ok()
}

/// Compares the installed files with the manifest: sizes always, SHA-256 too when `deep`. The manifest is a tripwire
/// for accidental or casual modification; whoever can write the folder can rewrite the manifest as well.
pub fn check_installed(dir: &Path, m: &Manifest, deep: bool) -> Result<(), String> {
    for f in &m.files {
        let p = dir.join(&f.name);
        let meta = fs::symlink_metadata(&p).map_err(|_| format!("{} is missing", f.name))?;
        if !meta.is_file() || meta.len() != f.bytes {
            return Err(format!("{} was modified", f.name));
        }
        if deep {
            let mut h = Sha256::new();
            let mut r = File::open(&p).map_err(|_| format!("{} is unreadable", f.name))?;
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                let n = r
                    .read(&mut buf)
                    .map_err(|_| format!("{} is unreadable", f.name))?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
            }
            if hex(&h.finalize()) != f.sha256 {
                return Err(format!("{} was modified", f.name));
            }
        }
    }
    Ok(())
}

// ---- probe -----------------------------------------------------------------------------------------------------------

const SCRUBBED_ENV: [&str; 12] = [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CORE_PROJECT",
    "AGY_ACP_CCPA_PROJECT",
    "AGY_ACP_ENABLE_OAUTH",
    "ANTIGRAVITY_HARNESS_PATH",
];

/// Starts the executable in a throwaway home/temp folder, sends one ACP `initialize` request and waits for the JSON-RPC
/// result (never a login, no session). Kills the process (tree) afterwards.
pub fn probe_executable(
    exe: &Path,
    work: &Path,
    timeout: Duration,
    cancel: &Cancel,
) -> Result<(), InstallError> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    let home = work.join("home");
    let tmp = work.join("tmp");
    for d in [&home, &tmp] {
        fs::create_dir_all(d).map_err(|e| io_err("create probe folder", e))?;
    }
    let mut cmd = Command::new(exe);
    for v in SCRUBBED_ENV {
        cmd.env_remove(v);
    }
    cmd.current_dir(work)
        .env("GEMINI_HOME", &home)
        .env("AGY_ACP_FORCE_FILE_STORAGE", "1")
        .env("TMPDIR", &tmp)
        .env("TEMP", &tmp)
        .env("TMP", &tmp)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| {
        err(
            "verify",
            format!("The installed agent could not be started: {e}"),
        )
    })?;
    let kill = |child: &mut std::process::Child| {
        #[cfg(unix)]
        // SAFETY: signalling the process group we created for this child.
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
    };
    let request = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": 2,
            "info": {"name": "gustaf", "version": "0"},
            "capabilities": {},
            "clientCapabilities": {"terminal": false},
            "clientInfo": {"name": "gustaf", "title": "Gustaf", "version": "0"},
        }
    });
    let mut stdin = child.stdin.take();
    if let Some(si) = stdin.as_mut() {
        let _ = writeln!(si, "{request}");
        let _ = si.flush();
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| err("verify", "No agent output."))?;
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v.get("id") == Some(&serde_json::json!(1)) {
                    let _ = tx.send(v.get("result").is_some());
                    return;
                }
            }
        }
        let _ = tx.send(false);
    });
    let started = Instant::now();
    let outcome = loop {
        if let Err(e) = cancel.check() {
            kill(&mut child);
            return Err(e);
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(ok) => break Some(ok),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if started.elapsed() > timeout {
                    break None;
                }
            }
            Err(_) => break Some(false),
        }
    };
    drop(stdin);
    kill(&mut child);
    match outcome {
        Some(true) => Ok(()),
        Some(false) => Err(err(
            "verify",
            "The installed agent did not answer the ACP initialize request.",
        )),
        None => Err(err("verify", "The installed agent did not answer in time.")),
    }
}

// ---- layout and the install itself -----------------------------------------------------------------------------------

pub fn runtime_root(root: &Path) -> PathBuf {
    root.join("antigravity-runtime")
}
fn tmp_root(root: &Path) -> PathBuf {
    runtime_root(root).join(".tmp")
}
fn stage_dir(root: &Path) -> PathBuf {
    tmp_root(root).join("install")
}

fn plain_dir(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
}

/// Removes a folder, but never follows a symlink planted in its place.
fn remove_tree(p: &Path) -> Result<(), InstallError> {
    match fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() || !m.is_dir() => {
            Err(err("io", "A runtime path is not a plain folder."))
        }
        Ok(_) => fs::remove_dir_all(p).map_err(|e| io_err("remove folder", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err("remove folder", e)),
    }
}

/// App start: whatever a killed install left behind goes (the partial download included).
pub fn clean_stale(root: &Path) {
    let _ = remove_tree(&tmp_root(root));
}

fn version_valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name.split('.').count() <= 4
        && name
            .split('.')
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn version_key(v: &str) -> Vec<u64> {
    v.split('.').filter_map(|p| p.parse().ok()).collect()
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub version: String,
    pub executable: String,
    pub dir: String,
    /// Why the files no longer match the manifest, if they do not.
    pub modified: Option<String>,
}

/// The newest installed version that has a readable manifest.
pub fn find_installed(root: &Path, deep: bool) -> Option<Installed> {
    let base = runtime_root(root);
    let mut best: Option<(Vec<u64>, PathBuf, Manifest)> = None;
    for e in fs::read_dir(&base).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let dir = e.path();
        if !version_valid(&name) || !plain_dir(&dir) {
            continue;
        }
        let Some(m) = read_manifest(&dir) else {
            continue;
        };
        if m.version != name || !m.files.first().is_some_and(|f| entry_name_ok(&f.name)) {
            continue;
        }
        let key = version_key(&name);
        if best.as_ref().is_none_or(|(k, _, _)| key > *k) {
            best = Some((key, dir, m));
        }
    }
    let (_, dir, m) = best?;
    let modified = check_installed(&dir, &m, deep).err();
    Some(Installed {
        executable: dir.join(&m.files[0].name).to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(),
        version: m.version,
        modified,
    })
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The whole install: space check, download (resumable), unpack, executable bits, manifest, probe, atomic publish,
/// removal of older versions. On failure the unpack and probe folders are gone; the partial download stays only after
/// a network failure. `cancel` removes everything.
pub fn install(
    root: &Path,
    asset: &Asset,
    policy: &UrlPolicy,
    cancel: &Cancel,
    emit: &mut dyn FnMut(Progress),
) -> Result<Installed, InstallError> {
    let result = install_inner(root, asset, policy, cancel, emit);
    let stage = stage_dir(root);
    match &result {
        Ok(_) => {
            let _ = remove_tree(&tmp_root(root));
        }
        Err(e) => {
            let keep_partial = matches!(e.code, "network" | "offline");
            if keep_partial {
                let _ = remove_tree(&stage.join("runtime"));
                let _ = remove_tree(&stage.join("work"));
            } else {
                let _ = remove_tree(&stage);
            }
        }
    }
    result
}

fn install_inner(
    root: &Path,
    asset: &Asset,
    policy: &UrlPolicy,
    cancel: &Cancel,
    emit: &mut dyn FnMut(Progress),
) -> Result<Installed, InstallError> {
    let base = runtime_root(root);
    for d in [&base, &tmp_root(root)] {
        fs::create_dir_all(d).map_err(|e| io_err("create folder", e))?;
    }
    space_check(available_bytes(&base), required_bytes(asset))?;
    let stage = stage_dir(root);
    fs::create_dir_all(&stage).map_err(|e| io_err("create folder", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(tmp_root(root), fs::Permissions::from_mode(0o700));
    }

    let total = asset.archive_bytes;
    let archive_sha = download(policy, asset, &stage, cancel, &mut |r, t| {
        emit(Progress {
            phase: "download",
            received: r,
            total: t,
        })
    })?;
    let _ = total;

    let runtime = stage.join("runtime");
    remove_tree(&runtime)?;
    let records = extract(
        &stage.join("download.part"),
        asset,
        &runtime,
        cancel,
        &mut |r, t| {
            emit(Progress {
                phase: "extract",
                received: r,
                total: t,
            })
        },
    )?;
    // The archive is no longer needed; free its space before the probe.
    let _ = fs::remove_file(stage.join("download.part"));
    let _ = fs::remove_file(stage.join("download.json"));
    mark_executables(&runtime, &records)?;
    let manifest = Manifest {
        version: asset.version.clone(),
        platform: asset.platform.clone(),
        source: asset.url.clone(),
        archive_sha256: archive_sha,
        archive_bytes: asset.archive_bytes,
        installed_at: now_secs(),
        files: records,
    };
    fs::write(
        runtime.join(MANIFEST),
        serde_json::to_vec_pretty(&manifest).unwrap_or_default(),
    )
    .map_err(|e| io_err("write manifest", e))?;

    emit(Progress {
        phase: "verify",
        received: 0,
        total: 1,
    });
    probe_executable(
        &runtime.join(asset.executable()),
        &stage.join("work"),
        PROBE_TIMEOUT,
        cancel,
    )?;
    emit(Progress {
        phase: "verify",
        received: 1,
        total: 1,
    });
    cancel.check()?;

    // Publish: the finished folder replaces any older folder of the same version in two renames.
    let final_dir = base.join(&asset.version);
    let old = tmp_root(root).join("replaced");
    remove_tree(&old)?;
    let had_old = plain_dir(&final_dir);
    if had_old {
        fs::rename(&final_dir, &old).map_err(|e| io_err("replace the old runtime", e))?;
    }
    if let Err(e) = fs::rename(&runtime, &final_dir) {
        if had_old {
            let _ = fs::rename(&old, &final_dir);
        }
        return Err(io_err("publish the runtime", e));
    }
    // Other versions are superseded (an update); a running old process keeps working on Unix, on Windows it may
    // hold the files, so errors are ignored.
    if let Ok(rd) = fs::read_dir(&base) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n != asset.version && version_valid(&n) && plain_dir(&e.path()) {
                let _ = fs::remove_dir_all(e.path());
            }
        }
    }
    find_installed(root, false)
        .ok_or_else(|| err("io", "The runtime was installed but cannot be found."))
}

/// Removes the managed runtime. Refused while a session uses it or a custom binary path points inside it.
pub fn remove(root: &Path, in_use: bool, protected_paths: &[String]) -> Result<(), InstallError> {
    if in_use {
        return Err(err(
            "in-use",
            "Stop Antigravity chats and sign-in before removing the runtime.",
        ));
    }
    let base = runtime_root(root);
    if let Ok(real) = fs::canonicalize(&base) {
        for p in protected_paths.iter().filter(|p| !p.trim().is_empty()) {
            let cand = fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
            if cand.starts_with(&real) {
                return Err(err(
                    "in-use",
                    "A provider's Binary path points inside the managed runtime. Clear it first.",
                ));
            }
        }
    }
    remove_tree(&base)
}

// ---- status ----------------------------------------------------------------------------------------------------------

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub supported: bool,
    /// `intel-mac` or `platform` when unsupported.
    pub reason: Option<&'static str>,
    pub version: String,
    pub archive_bytes: u64,
    pub unpacked_bytes: u64,
    /// Download address without a query string, for the confirmation dialog.
    pub source: String,
    /// Where the runtime goes.
    pub folder: String,
    pub installed: Option<Installed>,
    pub update_available: bool,
    pub busy: bool,
}

pub fn status(root: &Path, os: &str, arch: &str, deep: bool, busy: bool) -> Status {
    let installed = find_installed(root, deep);
    let update_available = installed
        .as_ref()
        .is_some_and(|i| version_key(VERSION) > version_key(&i.version));
    let (supported, reason, archive_bytes, unpacked_bytes, source) = match release_asset(os, arch) {
        Ok(a) => (true, None, a.archive_bytes, a.unpacked_bytes(), a.url),
        Err(u) => (false, Some(u.code), 0, 0, String::new()),
    };
    Status {
        supported,
        reason,
        version: VERSION.into(),
        archive_bytes,
        unpacked_bytes,
        source,
        folder: runtime_root(root)
            .join(VERSION)
            .to_string_lossy()
            .into_owned(),
        installed,
        update_available,
        busy,
    }
}

// ---- Tauri commands --------------------------------------------------------------------------------------------------

static ACTIVE: Mutex<Option<Cancel>> = Mutex::new(None);

struct ActiveGuard;
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if let Ok(mut a) = ACTIVE.lock() {
            *a = None;
        }
    }
}

fn app_root(app: &tauri::AppHandle) -> Result<PathBuf, InstallError> {
    app.path()
        .app_data_dir()
        .map_err(|e| err("io", e.to_string()))
}

fn busy() -> bool {
    ACTIVE.lock().map(|a| a.is_some()).unwrap_or(true)
}

#[tauri::command]
pub async fn antigravity_runtime_status(
    app: tauri::AppHandle,
    deep: bool,
) -> Result<Status, InstallError> {
    let root = app_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        status(
            &root,
            std::env::consts::OS,
            std::env::consts::ARCH,
            deep,
            busy(),
        )
    })
    .await
    .map_err(|e| err("io", e.to_string()))
}

/// The executable of the managed runtime if one is installed and its files still have the manifest's sizes.
#[tauri::command]
pub async fn antigravity_runtime_resolve(
    app: tauri::AppHandle,
) -> Result<Option<String>, InstallError> {
    let root = app_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        find_installed(&root, false)
            .filter(|i| i.modified.is_none())
            .map(|i| i.executable)
    })
    .await
    .map_err(|e| err("io", e.to_string()))
}

#[tauri::command]
pub async fn antigravity_runtime_install(
    app: tauri::AppHandle,
    events: Channel<Progress>,
) -> Result<Installed, InstallError> {
    let root = app_root(&app)?;
    let asset = release_asset(std::env::consts::OS, std::env::consts::ARCH)
        .map_err(|u| err(u.code, u.message))?;
    let cancel = Cancel::default();
    {
        let mut a = ACTIVE
            .lock()
            .map_err(|_| err("busy", "Install state is unavailable."))?;
        if a.is_some() {
            return Err(err("busy", "An Antigravity install is already running."));
        }
        *a = Some(cancel.clone());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ActiveGuard;
        install(&root, &asset, &UrlPolicy::google(), &cancel, &mut |p| {
            let _ = events.send(p);
        })
    })
    .await
    .map_err(|e| err("io", e.to_string()))?
}

#[tauri::command]
pub fn antigravity_runtime_cancel() {
    if let Ok(a) = ACTIVE.lock() {
        if let Some(c) = a.as_ref() {
            c.cancel();
        }
    }
}

#[tauri::command]
pub async fn antigravity_runtime_remove(
    app: tauri::AppHandle,
    in_use: bool,
    protected_paths: Vec<String>,
) -> Result<(), InstallError> {
    if busy() {
        return Err(err("busy", "An Antigravity install is running."));
    }
    let root = app_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || remove(&root, in_use, &protected_paths))
        .await
        .map_err(|e| err("io", e.to_string()))?
}

/// Called once at startup.
pub fn init(app: &tauri::App) {
    if let Ok(dir) = app.path().app_data_dir() {
        clean_stale(&dir);
    }
}

#[cfg(test)]
mod tests;
