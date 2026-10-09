use super::*;
use std::io::Cursor;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const AGENT: &[u8] = b"#!/bin/sh\nread line\necho '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1}}'\nsleep 30\n";
#[cfg(unix)] // only the Unix probe tests run a shell-script agent
const BAD_AGENT: &[u8] = b"#!/bin/sh\nread line\necho 'not json'\n";

fn zip_of(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data, mode) in entries {
        let o = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .unix_permissions(*mode);
        w.start_file(*name, o).unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

fn sha(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn asset_for(zip: &[u8], url: &str, exe: &[u8], helper: &[u8]) -> Asset {
    Asset {
        version: "1.3.0".into(),
        platform: "test".into(),
        url: url.into(),
        sha256: sha(zip),
        archive_bytes: zip.len() as u64,
        files: vec![
            FileSpec {
                name: "agy_acp_server.par".into(),
                bytes: exe.len() as u64,
            },
            FileSpec {
                name: "localharness_external".into(),
                bytes: helper.len() as u64,
            },
        ],
    }
}

fn good_zip(agent: &[u8]) -> Vec<u8> {
    zip_of(&[
        ("agy_acp_server.par", agent, 0o644),
        ("localharness_external", b"helper-binary", 0o644),
    ])
}

fn write_zip(dir: &Path, bytes: &[u8]) -> PathBuf {
    let p = dir.join("a.zip");
    fs::write(&p, bytes).unwrap();
    p
}

// ---- pure parts ------------------------------------------------------------------------------------------------------

#[test]
fn platform_mapping_and_urls() {
    let mac = release_asset("macos", "aarch64").unwrap();
    assert_eq!(
        mac.url,
        "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip"
    );
    assert_eq!(mac.executable(), "agy_acp_server.par");
    assert_eq!(mac.sha256.len(), 64);
    let lx = release_asset("linux", "x86_64").unwrap();
    assert!(lx.url.contains("/linux/") && lx.url.ends_with("linux-x86_64.zip"));
    assert!(release_asset("linux", "aarch64")
        .unwrap()
        .url
        .ends_with("linux-arm64.zip"));
    let win = release_asset("windows", "x86_64").unwrap();
    assert!(win.url.contains("/windows/") && win.url.ends_with("windows-x86_64.zip"));
    assert_eq!(win.executable(), "agy_acp_server.exe");
    assert!(release_asset("windows", "aarch64")
        .unwrap()
        .url
        .ends_with("windows-arm64.zip"));
    assert_eq!(
        release_asset("macos", "x86_64").unwrap_err().code,
        "intel-mac"
    );
    assert_eq!(
        release_asset("freebsd", "x86_64").unwrap_err().code,
        "platform"
    );
    assert_eq!(
        release_asset("linux", "riscv64").unwrap_err().code,
        "platform"
    );
}

#[test]
fn every_pinned_url_passes_the_production_policy() {
    let policy = UrlPolicy::google();
    for (os, arch) in [
        ("macos", "aarch64"),
        ("linux", "x86_64"),
        ("linux", "aarch64"),
        ("windows", "x86_64"),
        ("windows", "aarch64"),
    ] {
        let a = release_asset(os, arch).unwrap();
        policy
            .check(&reqwest::Url::parse(&a.url).unwrap(), false)
            .unwrap();
        assert_eq!(a.files.len(), 2);
    }
}

#[test]
fn url_policy_host_scheme_and_redirects() {
    let p = UrlPolicy::google();
    let u = |s: &str| reqwest::Url::parse(s).unwrap();
    assert!(p.check(&u("https://dl.google.com/a.zip"), false).is_ok());
    assert!(p.check(&u("http://dl.google.com/a.zip"), false).is_err());
    assert!(p.check(&u("https://evil.com/a.zip"), false).is_err());
    assert!(p
        .check(&u("https://dl.google.com.evil.com/a.zip"), false)
        .is_err());
    assert!(p
        .check(&u("https://dl.google.com:8443/a.zip"), false)
        .is_err());
    assert!(p
        .check(&u("https://user:pw@dl.google.com/a.zip"), false)
        .is_err());
    // The first request is dl.google.com only; redirects may reach Google domains.
    assert!(p
        .check(&u("https://storage.googleapis.com/x"), false)
        .is_err());
    assert!(p
        .check(&u("https://storage.googleapis.com/x"), true)
        .is_ok());
    assert!(p
        .check(&u("https://lh3.googleusercontent.com/x"), true)
        .is_ok());
    assert!(p.check(&u("https://notgoogle.com/x"), true).is_err());
    assert!(p.check(&u("https://google.com.evil.com/x"), true).is_err());
    assert!(p.check(&u("http://dl.google.com/x"), true).is_err());
}

#[test]
fn display_url_drops_query_and_credentials() {
    let u = reqwest::Url::parse("https://u:p@dl.google.com/a.zip?token=secret#frag").unwrap();
    assert_eq!(display_url(&u), "https://dl.google.com/a.zip");
}

#[test]
fn disk_space_decision() {
    let a = release_asset("macos", "aarch64").unwrap();
    let need = required_bytes(&a);
    assert!(need > a.archive_bytes + a.unpacked_bytes());
    assert!(space_check(Some(need), need).is_ok());
    let e = space_check(Some(need - 1), need).unwrap_err();
    assert_eq!(e.code, "no-space");
    assert!(e.message.contains("MB"));
    assert!(space_check(None, need).is_ok());
}

#[test]
fn resume_only_when_provably_the_same_archive() {
    let a = release_asset("macos", "aarch64").unwrap();
    let meta = PartMeta {
        url: a.url.clone(),
        etag: "\"abc\"".into(),
        total: a.archive_bytes,
    };
    assert_eq!(
        resume_decision(Some(&meta), Some(1000), &a),
        Resume::From(1000)
    );
    assert_eq!(resume_decision(None, Some(1000), &a), Resume::Fresh);
    assert_eq!(resume_decision(Some(&meta), None, &a), Resume::Fresh);
    assert_eq!(resume_decision(Some(&meta), Some(0), &a), Resume::Fresh);
    assert_eq!(
        resume_decision(Some(&meta), Some(a.archive_bytes), &a),
        Resume::Fresh
    );
    let weak = PartMeta {
        etag: "W/\"abc\"".into(),
        ..meta.clone()
    };
    assert_eq!(resume_decision(Some(&weak), Some(1000), &a), Resume::Fresh);
    let none = PartMeta {
        etag: String::new(),
        ..meta.clone()
    };
    assert_eq!(resume_decision(Some(&none), Some(1000), &a), Resume::Fresh);
    let other = PartMeta {
        total: 5,
        ..meta.clone()
    };
    assert_eq!(resume_decision(Some(&other), Some(1000), &a), Resume::Fresh);
    let url = PartMeta {
        url: "https://dl.google.com/other.zip".into(),
        ..meta
    };
    assert_eq!(resume_decision(Some(&url), Some(1000), &a), Resume::Fresh);
}

#[test]
fn zip_slip_names() {
    for bad in [
        "../evil",
        "/abs",
        "a/../../b",
        "..\\evil",
        "\\abs",
        "C:\\x",
        "C:x",
        "",
        "a//b",
        "./a",
        "a\0b",
    ] {
        assert!(!safe_relative(bad), "{bad:?} must be refused");
    }
    assert!(safe_relative("agy_acp_server.par"));
    assert!(safe_relative("dir/file"));
    assert!(entry_name_ok("localharness_external"));
    assert!(!entry_name_ok("dir/file"));
    assert!(!entry_name_ok("dir\\file"));
}

#[test]
fn executable_names() {
    assert!(is_executable_name("agy_acp_server.par"));
    assert!(is_executable_name("agy_acp_server.exe"));
    assert!(is_executable_name("localharness_external"));
    assert!(is_executable_name("localharness_external.exe"));
    assert!(!is_executable_name("manifest.json"));
}

// ---- extraction ------------------------------------------------------------------------------------------------------

fn extract_zip(bytes: &[u8], asset: &Asset) -> Result<Vec<FileRecord>, InstallError> {
    let d = tempfile::tempdir().unwrap();
    let z = write_zip(d.path(), bytes);
    extract(
        &z,
        asset,
        &d.path().join("out"),
        &Cancel::default(),
        &mut |_, _| {},
    )
}

#[test]
fn extract_good_archive_hashes_files_and_sets_exec_bits() {
    let zip = good_zip(AGENT);
    let asset = asset_for(&zip, "http://x/a.zip", AGENT, b"helper-binary");
    let d = tempfile::tempdir().unwrap();
    let z = write_zip(d.path(), &zip);
    let out = d.path().join("out");
    let recs = extract(&z, &asset, &out, &Cancel::default(), &mut |_, _| {}).unwrap();
    assert_eq!(recs.len(), 2);
    assert_eq!(recs[0].sha256, sha(AGENT));
    assert_eq!(
        fs::read(out.join("localharness_external")).unwrap(),
        b"helper-binary"
    );
    mark_executables(&out, &recs).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for n in ["agy_acp_server.par", "localharness_external"] {
            assert_eq!(
                fs::metadata(out.join(n)).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
    }
}

#[test]
fn extract_rejects_unsafe_and_unexpected_members() {
    let asset = asset_for(&good_zip(AGENT), "u", AGENT, b"helper-binary");
    // path traversal in place of the expected names
    let slip = zip_of(&[
        ("../agy_acp_server.par", AGENT, 0o644),
        ("localharness_external", b"helper-binary", 0o644),
    ]);
    assert_eq!(extract_zip(&slip, &asset).unwrap_err().code, "bad-archive");
    let abs = zip_of(&[
        ("/etc/passwd", AGENT, 0o644),
        ("localharness_external", b"helper-binary", 0o644),
    ]);
    assert_eq!(extract_zip(&abs, &asset).unwrap_err().code, "bad-archive");
    let nested = zip_of(&[
        ("sub/agy_acp_server.par", AGENT, 0o644),
        ("localharness_external", b"helper-binary", 0o644),
    ]);
    assert_eq!(
        extract_zip(&nested, &asset).unwrap_err().code,
        "bad-archive"
    );
    // an extra member
    let extra = zip_of(&[
        ("agy_acp_server.par", AGENT, 0o644),
        ("localharness_external", b"helper-binary", 0o644),
        ("extra", b"x", 0o644),
    ]);
    assert_eq!(extract_zip(&extra, &asset).unwrap_err().code, "bad-archive");
    // a missing member
    let one = zip_of(&[("agy_acp_server.par", AGENT, 0o644)]);
    assert_eq!(extract_zip(&one, &asset).unwrap_err().code, "bad-archive");
    // a repeated member
    // The writer refuses duplicate names, so patch one name (same length) in the finished archive.
    let mut dup = zip_of(&[
        ("agy_acp_server.par", AGENT, 0o644),
        ("agy_acp_server.paX", AGENT, 0o644),
    ]);
    for i in 0..dup.len() - 3 {
        if &dup[i..i + 3] == b"paX" {
            dup[i + 2] = b'r';
        }
    }
    assert_eq!(extract_zip(&dup, &asset).unwrap_err().code, "bad-archive");
    // not a zip at all
    assert_eq!(
        extract_zip(b"plain text", &asset).unwrap_err().code,
        "bad-archive"
    );
}

#[test]
fn extract_enforces_the_pinned_size_cap() {
    let asset = asset_for(&good_zip(AGENT), "u", AGENT, b"helper-binary");
    let bigger = zip_of(&[
        ("agy_acp_server.par", &[AGENT, b"#padding"].concat(), 0o644),
        ("localharness_external", b"helper-binary", 0o644),
    ]);
    assert_eq!(
        extract_zip(&bigger, &asset).unwrap_err().code,
        "bad-archive"
    );
    let smaller = zip_of(&[
        ("agy_acp_server.par", &AGENT[..10], 0o644),
        ("localharness_external", b"helper-binary", 0o644),
    ]);
    assert_eq!(
        extract_zip(&smaller, &asset).unwrap_err().code,
        "bad-archive"
    );
}

#[test]
fn extract_rejects_symlinks_and_folders() {
    let asset = asset_for(&good_zip(AGENT), "u", AGENT, b"helper-binary");
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    w.add_symlink(
        "agy_acp_server.par",
        "/etc/passwd",
        SimpleFileOptions::default(),
    )
    .unwrap();
    w.start_file(
        "localharness_external",
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )
    .unwrap();
    w.write_all(b"helper-binary").unwrap();
    let link = w.finish().unwrap().into_inner();
    assert_eq!(extract_zip(&link, &asset).unwrap_err().code, "bad-archive");
}

#[test]
fn extract_can_be_cancelled() {
    let zip = good_zip(AGENT);
    let asset = asset_for(&zip, "u", AGENT, b"helper-binary");
    let c = Cancel::default();
    c.cancel();
    let d = tempfile::tempdir().unwrap();
    let z = write_zip(d.path(), &zip);
    let e = extract(&z, &asset, &d.path().join("o"), &c, &mut |_, _| {}).unwrap_err();
    assert_eq!(e.code, "cancelled");
}

#[test]
fn manifest_detects_modification() {
    let zip = good_zip(AGENT);
    let asset = asset_for(&zip, "u", AGENT, b"helper-binary");
    let d = tempfile::tempdir().unwrap();
    let z = write_zip(d.path(), &zip);
    let out = d.path().join("out");
    let recs = extract(&z, &asset, &out, &Cancel::default(), &mut |_, _| {}).unwrap();
    let m = Manifest {
        version: "1.3.0".into(),
        platform: "t".into(),
        source: "u".into(),
        archive_sha256: asset.sha256.clone(),
        archive_bytes: asset.archive_bytes,
        installed_at: 1,
        files: recs,
    };
    assert!(check_installed(&out, &m, true).is_ok());
    // same size, different bytes: only the deep check sees it
    let mut bytes = fs::read(out.join("localharness_external")).unwrap();
    bytes[0] ^= 1;
    fs::write(out.join("localharness_external"), &bytes).unwrap();
    assert!(check_installed(&out, &m, false).is_ok());
    assert!(check_installed(&out, &m, true)
        .unwrap_err()
        .contains("modified"));
    fs::write(out.join("localharness_external"), b"short").unwrap();
    assert!(check_installed(&out, &m, false).is_err());
    fs::remove_file(out.join("localharness_external")).unwrap();
    assert!(check_installed(&out, &m, false)
        .unwrap_err()
        .contains("missing"));
}

// ---- local server ----------------------------------------------------------------------------------------------------

#[derive(Clone)]
enum Mode {
    /// Serves the whole body, honours Range + If-Range.
    Normal,
    /// First request: the connection closes after this many body bytes (Content-Length stays the full size).
    CutOnce(usize),
    /// Always answers 200 to everything, even Range requests, with a different ETag.
    IgnoreRange,
    /// Redirects to a host the policy does not allow.
    Redirect,
    NotFound,
}

/// (Range, If-Range) of every request.
type Seen = Vec<(Option<String>, Option<String>)>;

struct Server {
    base: String,
    requests: Arc<Mutex<Seen>>,
}

/// A minimal HTTP/1.1 server on 127.0.0.1 (one request per connection), so the tests control exactly what is sent.
fn serve(body: Vec<u8>, mode: Mode) -> Server {
    use std::io::BufRead;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    std::thread::spawn(move || {
        let mut first = true;
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let (mut range, mut if_range) = (None, None);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if let Some(v) = lower.strip_prefix("range:") {
                    range = Some(v.trim().to_string());
                }
                if lower.starts_with("if-range:") {
                    if_range = Some(line["if-range:".len()..].trim().to_string());
                }
            }
            log.lock().unwrap().push((range.clone(), if_range.clone()));
            let head = |status: &str, extra: &str, len: usize| {
                format!("HTTP/1.1 {status}\r\n{extra}Content-Length: {len}\r\nConnection: close\r\n\r\n")
            };
            let reply = |stream: &mut std::net::TcpStream, h: String, data: &[u8]| {
                let _ = stream.write_all(h.as_bytes());
                let _ = stream.write_all(data);
                let _ = stream.flush();
            };
            match (&mode, range) {
                (Mode::NotFound, _) => reply(&mut stream, head("404 Not Found", "", 0), b""),
                (Mode::Redirect, _) => reply(
                    &mut stream,
                    head("302 Found", "Location: http://localhost.invalid/x\r\n", 0),
                    b"",
                ),
                (Mode::CutOnce(n), None) if first => {
                    first = false;
                    reply(
                        &mut stream,
                        head("200 OK", "ETag: \"v1\"\r\n", body.len()),
                        &body[..*n],
                    );
                }
                (Mode::IgnoreRange, _) => reply(
                    &mut stream,
                    head("200 OK", "ETag: \"v2\"\r\n", body.len()),
                    &body,
                ),
                (_, Some(r)) if if_range.as_deref() == Some("\"v1\"") => {
                    let start: usize = r
                        .trim_start_matches("bytes=")
                        .trim_end_matches('-')
                        .parse()
                        .unwrap();
                    let extra = format!(
                        "ETag: \"v1\"\r\nContent-Range: bytes {}-{}/{}\r\n",
                        start,
                        body.len() - 1,
                        body.len()
                    );
                    reply(
                        &mut stream,
                        head("206 Partial Content", &extra, body.len() - start),
                        &body[start..],
                    );
                }
                _ => reply(
                    &mut stream,
                    head("200 OK", "ETag: \"v1\"\r\n", body.len()),
                    &body,
                ),
            }
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    });
    Server {
        base: format!("http://127.0.0.1:{port}"),
        requests,
    }
}

// ---- download --------------------------------------------------------------------------------------------------------

fn dl(server: &Server, zip: &[u8], dir: &Path) -> Result<String, InstallError> {
    let asset = asset_for(
        zip,
        &format!("{}/a.zip", server.base),
        AGENT,
        b"helper-binary",
    );
    download(
        &UrlPolicy::loopback(),
        &asset,
        dir,
        &Cancel::default(),
        &mut |_, _| {},
    )
}

#[test]
fn download_verifies_size_and_hash() {
    let zip = good_zip(AGENT);
    let s = serve(zip.clone(), Mode::Normal);
    let d = tempfile::tempdir().unwrap();
    assert_eq!(dl(&s, &zip, d.path()).unwrap(), sha(&zip));
    assert_eq!(fs::read(d.path().join("download.part")).unwrap(), zip);
}

#[test]
fn download_rejects_a_wrong_hash_and_removes_the_file() {
    let zip = good_zip(AGENT);
    let s = serve(zip.clone(), Mode::Normal);
    let d = tempfile::tempdir().unwrap();
    let mut asset = asset_for(&zip, &format!("{}/a.zip", s.base), AGENT, b"helper-binary");
    asset.sha256 = "0".repeat(64);
    let e = download(
        &UrlPolicy::loopback(),
        &asset,
        d.path(),
        &Cancel::default(),
        &mut |_, _| {},
    )
    .unwrap_err();
    assert_eq!(e.code, "hash");
    assert!(!d.path().join("download.part").exists());
}

#[test]
fn download_rejects_a_wrong_size() {
    let zip = good_zip(AGENT);
    let s = serve(zip.clone(), Mode::Normal);
    let d = tempfile::tempdir().unwrap();
    let mut asset = asset_for(&zip, &format!("{}/a.zip", s.base), AGENT, b"helper-binary");
    asset.archive_bytes += 10;
    let e = download(
        &UrlPolicy::loopback(),
        &asset,
        d.path(),
        &Cancel::default(),
        &mut |_, _| {},
    )
    .unwrap_err();
    assert_eq!(e.code, "size");
}

#[test]
fn download_refuses_disallowed_redirects_and_http_errors() {
    let zip = good_zip(AGENT);
    let d = tempfile::tempdir().unwrap();
    let e = dl(&serve(zip.clone(), Mode::Redirect), &zip, d.path()).unwrap_err();
    assert_eq!(e.code, "redirect");
    let e = dl(&serve(zip.clone(), Mode::NotFound), &zip, d.path()).unwrap_err();
    assert_eq!(e.code, "http");
    assert!(e.message.contains("404"));
    // the production policy refuses plain HTTP and foreign hosts before any request
    let mut asset = asset_for(&zip, "http://127.0.0.1:9/a.zip", AGENT, b"helper-binary");
    let e = download(
        &UrlPolicy::google(),
        &asset,
        d.path(),
        &Cancel::default(),
        &mut |_, _| {},
    )
    .unwrap_err();
    assert_eq!(e.code, "redirect");
    asset.url = "https://example.com/a.zip".into();
    assert!(download(
        &UrlPolicy::google(),
        &asset,
        d.path(),
        &Cancel::default(),
        &mut |_, _| {}
    )
    .is_err());
}

#[test]
fn download_reports_an_unreachable_server_as_offline() {
    let zip = good_zip(AGENT);
    let d = tempfile::tempdir().unwrap();
    // Nothing listens on this port.
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    let asset = asset_for(
        &zip,
        &format!("http://127.0.0.1:{port}/a.zip"),
        AGENT,
        b"helper-binary",
    );
    let e = download(
        &UrlPolicy::loopback(),
        &asset,
        d.path(),
        &Cancel::default(),
        &mut |_, _| {},
    )
    .unwrap_err();
    assert_eq!(e.code, "offline");
}

#[test]
fn download_resumes_a_broken_transfer_with_range_and_if_range() {
    let zip = good_zip(AGENT);
    let cut = zip.len() / 2;
    let s = serve(zip.clone(), Mode::CutOnce(cut));
    let d = tempfile::tempdir().unwrap();
    let e = dl(&s, &zip, d.path()).unwrap_err();
    assert_eq!(e.code, "network");
    let kept = fs::metadata(d.path().join("download.part")).unwrap().len();
    assert!(kept > 0 && (kept as usize) < zip.len());
    assert_eq!(dl(&s, &zip, d.path()).unwrap(), sha(&zip));
    assert_eq!(fs::read(d.path().join("download.part")).unwrap(), zip);
    let reqs = s.requests.lock().unwrap();
    assert_eq!(reqs.len(), 2);
    assert_eq!(
        reqs[1].0.as_deref(),
        Some(format!("bytes={kept}-").as_str())
    );
    assert_eq!(reqs[1].1.as_deref(), Some("\"v1\""));
}

#[test]
fn download_restarts_when_the_server_ignores_the_range() {
    let zip = good_zip(AGENT);
    let s = serve(zip.clone(), Mode::IgnoreRange);
    let d = tempfile::tempdir().unwrap();
    // A stale partial file with a stored validator.
    fs::write(d.path().join("download.part"), &zip[..10]).unwrap();
    let meta = PartMeta {
        url: format!("{}/a.zip", s.base),
        etag: "\"v1\"".into(),
        total: zip.len() as u64,
    };
    fs::write(
        d.path().join("download.json"),
        serde_json::to_vec(&meta).unwrap(),
    )
    .unwrap();
    assert_eq!(dl(&s, &zip, d.path()).unwrap(), sha(&zip));
    assert_eq!(fs::read(d.path().join("download.part")).unwrap(), zip);
}

#[test]
fn download_can_be_cancelled() {
    let zip = good_zip(AGENT);
    let s = serve(zip.clone(), Mode::Normal);
    let d = tempfile::tempdir().unwrap();
    let asset = asset_for(&zip, &format!("{}/a.zip", s.base), AGENT, b"helper-binary");
    let c = Cancel::default();
    c.cancel();
    let e = download(&UrlPolicy::loopback(), &asset, d.path(), &c, &mut |_, _| {}).unwrap_err();
    assert_eq!(e.code, "cancelled");
}

// ---- the whole install -----------------------------------------------------------------------------------------------

#[cfg(unix)]
#[test]
fn install_end_to_end_against_a_local_server() {
    let zip = good_zip(AGENT);
    let s = serve(zip.clone(), Mode::Normal);
    let root = tempfile::tempdir().unwrap();
    let asset = asset_for(&zip, &format!("{}/a.zip", s.base), AGENT, b"helper-binary");
    let mut phases = Vec::new();
    let installed = install(
        root.path(),
        &asset,
        &UrlPolicy::loopback(),
        &Cancel::default(),
        &mut |p| {
            if phases.last() != Some(&p.phase) {
                phases.push(p.phase);
            }
        },
    )
    .unwrap();
    assert_eq!(phases, vec!["download", "extract", "verify"]);
    assert_eq!(installed.version, "1.3.0");
    assert!(installed.modified.is_none());
    assert!(Path::new(&installed.executable).ends_with("1.3.0/agy_acp_server.par"));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(&installed.executable)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    // manifest records the hashes
    let m = read_manifest(Path::new(&installed.dir)).unwrap();
    assert_eq!(m.archive_sha256, sha(&zip));
    assert_eq!(m.files[0].sha256, sha(AGENT));
    assert!(!m.source.contains('?'));
    // nothing is left in the temp folder
    assert!(!tmp_root(root.path()).exists());
    // status and resolve see it; a deep check passes; tampering is noticed
    let st = status(root.path(), "macos", "aarch64", true, false);
    assert!(st.installed.as_ref().is_some_and(|i| i.modified.is_none()) && !st.update_available);
    assert!(!status(root.path(), "macos", "x86_64", false, false).supported);
    fs::write(&installed.executable, b"tampered").unwrap();
    assert!(find_installed(root.path(), false)
        .unwrap()
        .modified
        .is_some());
    // reinstalling replaces it
    let again = install(
        root.path(),
        &asset,
        &UrlPolicy::loopback(),
        &Cancel::default(),
        &mut |_| {},
    )
    .unwrap();
    assert!(again.modified.is_none());
    // remove: refused when in use or protected, then works
    assert_eq!(remove(root.path(), true, &[]).unwrap_err().code, "in-use");
    assert_eq!(
        remove(root.path(), false, std::slice::from_ref(&again.executable))
            .unwrap_err()
            .code,
        "in-use"
    );
    remove(root.path(), false, &["/usr/bin/true".into(), "".into()]).unwrap();
    assert!(find_installed(root.path(), false).is_none());
    remove(root.path(), false, &[]).unwrap();
}

#[cfg(unix)]
#[test]
fn install_removes_older_versions_and_reports_update_available() {
    let zip = good_zip(AGENT);
    let s = serve(zip.clone(), Mode::Normal);
    let root = tempfile::tempdir().unwrap();
    // an "old" install
    let old = runtime_root(root.path()).join("1.2.0");
    fs::create_dir_all(&old).unwrap();
    let m = Manifest {
        version: "1.2.0".into(),
        platform: "t".into(),
        source: "u".into(),
        archive_sha256: "0".into(),
        archive_bytes: 1,
        installed_at: 1,
        files: vec![FileRecord {
            name: "agy_acp_server.par".into(),
            bytes: 1,
            sha256: "0".into(),
        }],
    };
    fs::write(old.join(MANIFEST), serde_json::to_vec(&m).unwrap()).unwrap();
    fs::write(old.join("agy_acp_server.par"), b"x").unwrap();
    let st = status(root.path(), "linux", "x86_64", false, false);
    assert!(st.update_available);
    assert_eq!(st.installed.unwrap().version, "1.2.0");
    let asset = asset_for(&zip, &format!("{}/a.zip", s.base), AGENT, b"helper-binary");
    install(
        root.path(),
        &asset,
        &UrlPolicy::loopback(),
        &Cancel::default(),
        &mut |_| {},
    )
    .unwrap();
    assert!(!old.exists());
    assert!(!status(root.path(), "linux", "x86_64", false, false).update_available);
}

#[cfg(unix)]
#[test]
fn a_failing_probe_installs_nothing() {
    let zip = good_zip(BAD_AGENT);
    let s = serve(zip.clone(), Mode::Normal);
    let root = tempfile::tempdir().unwrap();
    let asset = asset_for(
        &zip,
        &format!("{}/a.zip", s.base),
        BAD_AGENT,
        b"helper-binary",
    );
    let e = install(
        root.path(),
        &asset,
        &UrlPolicy::loopback(),
        &Cancel::default(),
        &mut |_| {},
    )
    .unwrap_err();
    assert_eq!(e.code, "verify");
    assert!(find_installed(root.path(), false).is_none());
    assert!(!stage_dir(root.path()).exists());
}

#[cfg(unix)]
#[test]
fn a_bad_archive_and_a_cancel_leave_nothing_behind() {
    let zip = zip_of(&[
        ("../agy_acp_server.par", AGENT, 0o644),
        ("localharness_external", b"helper-binary", 0o644),
    ]);
    let s = serve(zip.clone(), Mode::Normal);
    let root = tempfile::tempdir().unwrap();
    let asset = asset_for(&zip, &format!("{}/a.zip", s.base), AGENT, b"helper-binary");
    let e = install(
        root.path(),
        &asset,
        &UrlPolicy::loopback(),
        &Cancel::default(),
        &mut |_| {},
    )
    .unwrap_err();
    assert_eq!(e.code, "bad-archive");
    assert!(!stage_dir(root.path()).exists());
    assert!(find_installed(root.path(), false).is_none());

    let good = good_zip(AGENT);
    let s = serve(good.clone(), Mode::Normal);
    let asset = asset_for(&good, &format!("{}/a.zip", s.base), AGENT, b"helper-binary");
    let c = Cancel::default();
    let c2 = c.clone();
    let e = install(root.path(), &asset, &UrlPolicy::loopback(), &c, &mut |p| {
        if p.phase == "extract" {
            c2.cancel();
        }
    })
    .unwrap_err();
    assert_eq!(e.code, "cancelled");
    assert!(!stage_dir(root.path()).exists());
    assert!(find_installed(root.path(), false).is_none());
}

#[cfg(unix)]
#[test]
fn a_network_failure_keeps_the_partial_file_and_the_retry_resumes() {
    let zip = good_zip(AGENT);
    let s = serve(zip.clone(), Mode::CutOnce(zip.len() / 2));
    let root = tempfile::tempdir().unwrap();
    let asset = asset_for(&zip, &format!("{}/a.zip", s.base), AGENT, b"helper-binary");
    let e = install(
        root.path(),
        &asset,
        &UrlPolicy::loopback(),
        &Cancel::default(),
        &mut |_| {},
    )
    .unwrap_err();
    assert_eq!(e.code, "network");
    assert!(stage_dir(root.path()).join("download.part").exists());
    install(
        root.path(),
        &asset,
        &UrlPolicy::loopback(),
        &Cancel::default(),
        &mut |_| {},
    )
    .unwrap();
    assert!(s.requests.lock().unwrap()[1].0.is_some());
}

#[test]
fn stale_temp_folders_are_cleaned_at_start() {
    let root = tempfile::tempdir().unwrap();
    let stage = stage_dir(root.path());
    fs::create_dir_all(stage.join("runtime")).unwrap();
    fs::write(stage.join("download.part"), b"half").unwrap();
    let keep = runtime_root(root.path()).join("1.3.0");
    fs::create_dir_all(&keep).unwrap();
    clean_stale(root.path());
    assert!(!tmp_root(root.path()).exists());
    assert!(keep.exists());
}

#[cfg(unix)]
#[test]
fn remove_refuses_a_symlinked_runtime_folder() {
    let root = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(target.path(), runtime_root(root.path())).unwrap();
    assert!(remove(root.path(), false, &[]).is_err());
    assert!(target.path().exists());
}
