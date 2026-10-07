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

/// Days since 1970-01-01 of a valid `YYYY-MM-DD` (proleptic Gregorian, Hinnant's algorithm).
fn day_number(day: &str) -> Option<i64> {
    if !valid_day(day) {
        return None;
    }
    let (y, m, d): (i64, i64, i64) = (day[0..4].parse().ok()?, day[5..7].parse().ok()?, day[8..10].parse().ok()?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// Old day files: `<day>.jsonl` regular files (never links, never other names) dated more than `keep_days` before `today`.
/// The file of `today` and everything newer can never match, even with a bad `keep_days`; `keep_days` below 1 counts as 1.
fn stale_files(dir: &Path, today: &str, keep_days: u32) -> Vec<(PathBuf, u64)> {
    let Some(now) = day_number(today) else { return vec![] };
    let keep = i64::from(keep_days.max(1));
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<(PathBuf, u64)> = rd
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let meta = std::fs::symlink_metadata(&path).ok()?;
            if !meta.is_file() || path.extension()? != "jsonl" {
                return None;
            }
            let n = day_number(path.file_stem()?.to_str()?)?;
            (n < now && now - n > keep).then_some((path, meta.len()))
        })
        .collect();
    out.sort();
    out
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Prune {
    pub files: Vec<String>,
    pub bytes: u64,
    pub dry_run: bool,
}

fn prune(dir: &Path, today: &str, keep_days: u32, dry_run: bool) -> Result<Prune, String> {
    let mut out = Prune { files: vec![], bytes: 0, dry_run };
    for (path, size) in stale_files(dir, today, keep_days) {
        if !dry_run {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        out.bytes += size;
        out.files.push(path.file_name().unwrap_or_default().to_string_lossy().into_owned());
    }
    Ok(out)
}

/// Deletes (or, with `dry_run`, only lists) day files older than `keep_days`. Only `<app data>/raw-cli` is touched.
#[tauri::command]
pub fn raw_log_prune(app: tauri::AppHandle, today: String, keep_days: u32, dry_run: bool) -> Result<Prune, String> {
    prune(&base(&app)?, &today, keep_days, dry_run)
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
    fn prune_keeps_today_recent_days_other_names_and_links() {
        let root = tempfile::tempdir().unwrap();
        let d = root.path();
        for n in ["2026-09-01.jsonl", "2026-09-29.jsonl", "2026-09-30.jsonl", "2026-10-07.jsonl", "2026-10-08.jsonl", "notes.jsonl", "2026-08-01.txt", "2026-13-01.jsonl"] {
            std::fs::write(d.join(n), "x\n").unwrap();
        }
        std::fs::create_dir(d.join("2026-01-01.jsonl")).unwrap();
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("keep"), "secret").unwrap();
            std::os::unix::fs::symlink(outside.path().join("keep"), d.join("2026-02-01.jsonl")).unwrap();
            let dry = prune(d, "2026-10-07", 7, true).unwrap();
            assert_eq!(dry.files, ["2026-09-01.jsonl", "2026-09-29.jsonl"]);
            assert!(d.join("2026-09-01.jsonl").exists(), "a dry run deletes nothing");
            let done = prune(d, "2026-10-07", 7, false).unwrap();
            assert_eq!(done.files, dry.files);
            assert_eq!(done.bytes, 4);
            assert!(d.join("2026-02-01.jsonl").symlink_metadata().is_ok(), "links stay");
            assert!(outside.path().join("keep").exists());
        }
        for kept in ["2026-09-30.jsonl", "2026-10-07.jsonl", "2026-10-08.jsonl", "notes.jsonl", "2026-08-01.txt", "2026-13-01.jsonl", "2026-01-01.jsonl"] {
            assert!(d.join(kept).exists() || !cfg!(unix), "{kept}");
        }
    }

    #[test]
    fn prune_never_removes_today_even_with_zero_days_and_ignores_a_bad_today() {
        let root = tempfile::tempdir().unwrap();
        let d = root.path();
        std::fs::write(d.join("2026-10-07.jsonl"), "x").unwrap();
        std::fs::write(d.join("2026-10-06.jsonl"), "x").unwrap();
        assert!(prune(d, "2026-10-07", 0, false).unwrap().files.is_empty(), "0 counts as 1: yesterday is kept");
        assert!(prune(d, "../..", 1, false).unwrap().files.is_empty());
        assert!(prune(&d.join("missing"), "2026-10-07", 1, false).unwrap().files.is_empty());
        assert!(d.join("2026-10-07.jsonl").exists() && d.join("2026-10-06.jsonl").exists());
    }

    #[test]
    fn day_numbers_count_days() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("2026-03-01").unwrap() - day_number("2026-02-28").unwrap(), 1);
        assert_eq!(day_number("2024-03-01").unwrap() - day_number("2024-02-28").unwrap(), 2);
        assert_eq!(day_number("2026-00-10"), None);
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
