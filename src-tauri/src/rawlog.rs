//! Opt-in debug capture of the raw event lines of agent CLIs (Settings, General, "Record raw CLI events"):
//! `<app data>/raw-cli/<YYYY-MM-DD>.jsonl`, one file per day, newest data kept under a total cap (5 MB).
//! The frontend scrubs secrets before it calls us (src/lib/rawCliLog.ts); this module only appends and bounds.

use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Total size of all files; the oldest day is dropped first, a single over-sized day is trimmed from its start.
const CAP_BYTES: u64 = 5 * 1024 * 1024;
const MAX_APPEND: usize = 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct Info {
    pub dir: String,
    pub bytes: u64,
    pub files: usize,
    /// Newest file, to reveal in the file manager.
    pub latest: Option<String>,
}

fn base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("raw-cli"))
}

/// `YYYY-MM-DD` only: the day becomes part of a file name.
fn valid_day(day: &str) -> bool {
    let b = day.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

fn files(dir: &Path) -> Vec<(PathBuf, u64)> {
    let mut out: Vec<(PathBuf, u64)> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
                .filter_map(|e| e.metadata().ok().map(|m| (e.path(), m.len())))
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// Keeps the total under `cap`: whole old days go first; when only one file is left it loses its oldest lines.
fn enforce_cap(dir: &Path, cap: u64) -> Result<(), String> {
    let mut list = files(dir);
    let mut total: u64 = list.iter().map(|f| f.1).sum();
    while total > cap && list.len() > 1 {
        let (path, size) = list.remove(0);
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        total -= size;
    }
    if total > cap {
        let (path, size) = &list[0];
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        // Keep about 80% of the cap, cut at a line start.
        let keep = (cap / 5 * 4) as usize;
        let from = bytes.len().saturating_sub(keep);
        let from = bytes[from..].iter().position(|b| *b == b'\n').map_or(bytes.len(), |p| from + p + 1);
        std::fs::write(path, &bytes[from..]).map_err(|e| e.to_string())?;
        let _ = size;
    }
    Ok(())
}

fn append(dir: &Path, day: &str, lines: &str, cap: u64) -> Result<(), String> {
    if !valid_day(day) {
        return Err("invalid day".into());
    }
    if lines.len() > MAX_APPEND {
        return Err("batch too large".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut f = OpenOptions::new().create(true).append(true).open(dir.join(format!("{day}.jsonl"))).map_err(|e| e.to_string())?;
    f.write_all(lines.as_bytes()).map_err(|e| e.to_string())?;
    if !lines.ends_with('\n') {
        f.write_all(b"\n").map_err(|e| e.to_string())?;
    }
    drop(f);
    enforce_cap(dir, cap)
}

fn clear(dir: &Path) -> Result<(), String> {
    for (path, _) in files(dir) {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn info(dir: &Path) -> Info {
    let list = files(dir);
    Info {
        dir: dir.to_string_lossy().into_owned(),
        bytes: list.iter().map(|f| f.1).sum(),
        files: list.len(),
        latest: list.last().map(|f| f.0.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
pub fn raw_log_append(app: tauri::AppHandle, day: String, lines: String) -> Result<(), String> {
    append(&base(&app)?, &day, &lines, CAP_BYTES)
}

#[tauri::command]
pub fn raw_log_clear(app: tauri::AppHandle) -> Result<(), String> {
    clear(&base(&app)?)
}

/// Size and location of the capture; the folder is created so "Reveal" always has something to open.
#[tauri::command]
pub fn raw_log_info(app: tauri::AppHandle) -> Result<Info, String> {
    let dir = base(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(info(&dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_per_day_and_reports_the_newest_file() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("raw-cli");
        append(&dir, "2026-10-02", "{\"a\":1}\n", 1000).unwrap();
        append(&dir, "2026-10-03", "{\"b\":2}", 1000).unwrap();
        append(&dir, "2026-10-03", "{\"c\":3}\n", 1000).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("2026-10-03.jsonl")).unwrap(), "{\"b\":2}\n{\"c\":3}\n");
        let i = info(&dir);
        assert_eq!(i.files, 2);
        assert!(i.latest.unwrap().ends_with("2026-10-03.jsonl"));
    }

    #[test]
    fn rejects_a_day_that_is_not_a_date() {
        let root = tempfile::tempdir().unwrap();
        for bad in ["../x", "2026-10-3", "2026/10/03", "", "2026-10-03.jsonl"] {
            assert!(append(root.path(), bad, "x\n", 1000).is_err(), "{bad}");
        }
        assert!(files(root.path()).is_empty());
    }

    #[test]
    fn the_cap_drops_the_oldest_days_first() {
        let root = tempfile::tempdir().unwrap();
        let line = format!("{}\n", "x".repeat(99)); // 100 bytes
        for day in ["2026-10-01", "2026-10-02", "2026-10-03"] {
            append(root.path(), day, &line.repeat(3), 700).unwrap();
        }
        // 900 bytes written, cap 700 after the third append: the first day is gone.
        let names: Vec<String> = files(root.path()).iter().map(|f| f.0.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["2026-10-02.jsonl", "2026-10-03.jsonl"]);
        assert!(info(root.path()).bytes <= 700);
    }

    #[test]
    fn one_oversized_day_is_trimmed_from_its_start_at_a_line_boundary() {
        let root = tempfile::tempdir().unwrap();
        let mut text = String::new();
        for i in 0..40 {
            text.push_str(&format!("{{\"n\":{i:02}}}\n")); // 9 bytes a line
        }
        append(root.path(), "2026-10-03", &text, 200).unwrap();
        let kept = std::fs::read_to_string(root.path().join("2026-10-03.jsonl")).unwrap();
        assert!(kept.len() <= 200 && kept.len() > 100, "{}", kept.len());
        assert!(kept.starts_with("{\"n\":"), "starts at a whole line: {kept:?}");
        assert!(kept.ends_with("{\"n\":39}\n"), "newest line kept");
    }

    #[test]
    fn clear_removes_the_files_and_keeps_the_folder() {
        let root = tempfile::tempdir().unwrap();
        append(root.path(), "2026-10-03", "x\n", 1000).unwrap();
        clear(root.path()).unwrap();
        assert_eq!(info(root.path()).files, 0);
        assert!(root.path().exists());
    }
}
