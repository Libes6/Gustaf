use crate::shell::Shell;
use ignore::{overrides::OverrideBuilder, WalkBuilder};
use regex::Regex;
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const MAX_OUTPUT: usize = 30_000;

fn truncate(mut s: String) -> String {
    if s.len() > MAX_OUTPUT {
        let mut cut = MAX_OUTPUT;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n…[truncated]");
    }
    s
}

/// Resolves `rel` inside `root`, rejecting anything (`..`, absolute paths, symlinks) that escapes it.
pub fn resolve_in_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| format!("project root: {e}"))?;
    let joined = root.join(rel);
    // Canonicalize the deepest existing ancestor so new files can still be created.
    let mut existing = joined.as_path();
    let mut tail = Vec::new();
    while fs::symlink_metadata(existing).is_err() {
        tail.push(existing.file_name().ok_or("invalid path")?.to_owned());
        existing = existing.parent().ok_or("invalid path")?;
    }
    let mut resolved = existing.canonicalize().map_err(|e| e.to_string())?;
    for part in tail.iter().rev() {
        if Path::new(part).components().any(|c| matches!(c, Component::ParentDir)) {
            return Err("path escapes project".into());
        }
        resolved.push(part);
    }
    if !resolved.starts_with(&root) {
        return Err(format!("path escapes project: {rel}"));
    }
    Ok(resolved)
}

pub fn edit(path: &Path, old: &str, new: &str) -> Result<String, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    match text.matches(old).count() {
        0 => Err("old_string not found".into()),
        1 => {
            fs::write(path, text.replacen(old, new, 1)).map_err(|e| e.to_string())?;
            Ok("ok".into())
        }
        n => Err(format!("old_string is not unique ({n} matches); include more context")),
    }
}

#[tauri::command]
pub fn fs_read(root: String, path: String, offset: Option<usize>, limit: Option<usize>) -> Result<String, String> {
    let p = resolve_in_root(Path::new(&root), &path)?;
    let text = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let start = offset.unwrap_or(1).max(1);
    let out: String = text
        .lines()
        .enumerate()
        .skip(start - 1)
        .take(limit.unwrap_or(2000))
        .map(|(i, l)| format!("{:>6}|{l}\n", i + 1))
        .collect();
    Ok(truncate(out))
}

#[tauri::command]
pub fn fs_list(root: String, path: String) -> Result<String, String> {
    let p = resolve_in_root(Path::new(&root), &path)?;
    let mut names: Vec<String> = fs::read_dir(&p)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() { format!("{n}/") } else { n }
        })
        .collect();
    names.sort();
    Ok(names.join("\n"))
}

/// Canonicalizes `root` and requires it to be an existing directory, like `resolve_in_root` does for single paths.
fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let base = Path::new(root).canonicalize().map_err(|e| format!("project root: {e}"))?;
    if !base.is_dir() {
        return Err(format!("project root is not a directory: {root}"));
    }
    Ok(base)
}

/// Returns the canonical form of `path` only if it still lies inside the canonical `base`.
fn contained(base: &Path, path: &Path) -> Option<PathBuf> {
    path.canonicalize().ok().filter(|real| real.starts_with(base))
}

/// Walks regular files under the canonical `base` without following symlinks.
/// Yields `(canonical path, path relative to base)`; anything resolving outside `base` is skipped.
fn walk_files(base: &Path, glob: Option<&str>) -> Result<impl Iterator<Item = (PathBuf, String)>, String> {
    let mut walk = WalkBuilder::new(base);
    walk.follow_links(false);
    if let Some(g) = glob.filter(|g| !g.is_empty()) {
        let mut ob = OverrideBuilder::new(base);
        ob.add(g).map_err(|e| e.to_string())?;
        walk.overrides(ob.build().map_err(|e| e.to_string())?);
    }
    let base = base.to_path_buf();
    Ok(walk
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .filter_map(move |e| {
            let real = contained(&base, e.path())?;
            let rel = e.path().strip_prefix(&base).ok()?.to_string_lossy().replace('\\', "/");
            Some((real, rel))
        }))
}

#[tauri::command]
pub fn fs_files(root: String) -> Result<Vec<String>, String> {
    let base = canonical_root(&root)?;
    Ok(walk_files(&base, None)?.map(|(_, rel)| rel).take(20_000).collect())
}

fn search_in(root: &str, pattern: &str, glob: Option<&str>) -> Result<String, String> {
    let re = Regex::new(pattern).map_err(|e| e.to_string())?;
    let base = canonical_root(root)?;
    let mut out = String::new();
    let mut hits = 0;
    'files: for (real, rel) in walk_files(&base, glob)? {
        let Ok(text) = fs::read_to_string(&real) else { continue };
        for (i, line) in text.lines().enumerate() {
            if re.is_match(line) {
                out.push_str(&format!("{rel}:{}:{}\n", i + 1, line.trim_end()));
                hits += 1;
                if hits >= 300 {
                    out.push_str("…[more matches omitted]");
                    break 'files;
                }
            }
        }
    }
    Ok(if out.is_empty() { "no matches".into() } else { truncate(out) })
}

#[tauri::command]
pub async fn fs_search(root: String, pattern: String, glob: Option<String>) -> Result<String, String> {
    search_in(&root, &pattern, glob.as_deref())
}

#[tauri::command]
pub fn fs_edit(root: String, path: String, old_string: String, new_string: String) -> Result<String, String> {
    edit(&resolve_in_root(Path::new(&root), &path)?, &old_string, &new_string)
}

#[tauri::command]
pub fn fs_write(root: String, path: String, content: String) -> Result<String, String> {
    let p = resolve_in_root(Path::new(&root), &path)?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&p, content).map_err(|e| e.to_string())?;
    Ok("ok".into())
}

/// Most bytes read from one instruction file; the prompt builder applies its own, smaller caps.
const INSTRUCTION_READ_CAP: u64 = 64 * 1024;
const MAX_CURSOR_RULES: usize = 50;

#[derive(Serialize, Debug)]
pub struct InstructionFile {
    /// Path relative to the project root, as written in the prompt.
    name: String,
    /// Size of the file on disk; `text` holds at most `INSTRUCTION_READ_CAP` of it.
    bytes: u64,
    text: String,
}

/// True when the YAML front matter of a Cursor rule file says `alwaysApply: true`.
fn always_apply(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("---") else { return false };
    let Some(end) = rest.find("\n---") else { return false };
    rest[..end].lines().any(|l| l.trim() == "alwaysApply: true")
}

/// Reads one candidate instruction file. Anything that resolves outside the project root (a symlink pointing out),
/// is not a regular file, or is already seen under another name is skipped.
fn read_instruction(root: &Path, rel: &str, seen: &mut Vec<PathBuf>, filter: impl Fn(&str) -> bool) -> Option<InstructionFile> {
    let path = resolve_in_root(root, rel).ok()?;
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() || seen.contains(&path) {
        return None;
    }
    let mut buf = Vec::new();
    fs::File::open(&path).ok()?.take(INSTRUCTION_READ_CAP).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if !filter(&text) {
        return None;
    }
    seen.push(path);
    Some(InstructionFile { name: rel.to_string(), bytes: meta.len(), text })
}

/// Project instruction files, in priority order: AGENTS.md, CLAUDE.md, .cursorrules and the `.cursor/rules/*.mdc|md`
/// files marked `alwaysApply: true`. Only files inside the project root are read.
#[tauri::command]
pub fn read_instructions(root: String) -> Vec<InstructionFile> {
    let base = Path::new(&root);
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for name in ["AGENTS.md", "CLAUDE.md", ".cursorrules"] {
        out.extend(read_instruction(base, name, &mut seen, |_| true));
    }
    if let Ok(dir) = resolve_in_root(base, ".cursor/rules").and_then(|d| fs::read_dir(d).map_err(|e| e.to_string())) {
        let mut names: Vec<String> = dir
            .filter_map(Result::ok)
            .filter(|e| matches!(e.path().extension().and_then(|x| x.to_str()), Some("mdc" | "md")))
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        names.sort();
        for name in names.into_iter().take(MAX_CURSOR_RULES) {
            out.extend(read_instruction(base, &format!(".cursor/rules/{name}"), &mut seen, always_apply));
        }
    }
    out
}

#[tauri::command]
pub fn read_home_file(rel: String) -> Option<String> {
    fs::read_to_string(dirs::home_dir()?.join(rel)).ok()
}

#[derive(Serialize)]
pub struct CmdResult {
    code: Option<i32>,
    output: String,
    timed_out: bool,
}

// ponytail: output is returned when the command ends, not streamed; switch to Channel events if long builds need live logs.
#[tauri::command]
/// `env`: extra variables for this command only (the secrets an agent was given through `request_secret`; their values
/// never appear in the command text).
pub async fn run_command(root: String, command: String, timeout_ms: Option<u64>, env: Option<std::collections::HashMap<String, String>>) -> Result<CmdResult, String> {
    let shell = Shell::current();
    let merged = shell.merges_stderr_itself();
    let mut child = Command::new(shell.program())
        .args(shell.flags())
        .arg(shell.script(&command))
        .current_dir(&root)
        .envs(env.unwrap_or_default())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(if merged { Stdio::inherit() } else { Stdio::piped() })
        .spawn()
        .map_err(|e| e.to_string())?;
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("failed to capture command output".into());
    };
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    // Shells that cannot merge stderr themselves (PowerShell): read it on its own thread and append it.
    let err_reader = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf);
            buf
        })
    });
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.unwrap_or(120_000));
    let (code, timed_out) = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break (s.code(), false);
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            break (None, true);
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut bytes = reader.join().unwrap_or_default();
    if let Some(r) = err_reader {
        bytes.extend(r.join().unwrap_or_default());
    }
    let output = truncate(String::from_utf8_lossy(&bytes).into_owned());
    Ok(CmdResult { code, output, timed_out })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_boundary_and_unique_edit() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(dir.path().join("secret.txt"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path(), root.join("link")).unwrap();

        assert!(resolve_in_root(&root, "src/new.rs").is_ok());
        assert!(resolve_in_root(&root, "../secret.txt").is_err());
        assert!(resolve_in_root(&root, "src/../../secret.txt").is_err());
        assert!(resolve_in_root(&root, "/etc/passwd").is_err());
        #[cfg(unix)]
        assert!(resolve_in_root(&root, "link/secret.txt").is_err());
        assert!(resolve_in_root(&root, "missing/../../x").is_err());

        let f = root.join("a.txt");
        fs::write(&f, "foo bar foo").unwrap();
        assert!(edit(&f, "foo", "baz").is_err());
        assert!(edit(&f, "nope", "baz").is_err());
        edit(&f, "bar", "qux").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "foo qux foo");
    }

    /// `outside/` holds a secret; `proj/` has a real file plus symlinks pointing at the secret.
    #[cfg(unix)]
    fn escape_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        let root = dir.path().join("proj");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(outside.join("secret.txt"), "needle outside\n").unwrap();
        fs::write(root.join("src/a.txt"), "needle inside\nother\n").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("dirlink")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("filelink.txt")).unwrap();
        std::os::unix::fs::symlink(root.join("src"), root.join("src_alias")).unwrap();
        (dir, root, outside)
    }

    #[test]
    fn files_and_search_validate_root() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("plain.txt");
        fs::write(&file, "needle").unwrap();
        let missing = dir.path().join("missing");

        for bad in ["", missing.to_str().unwrap(), file.to_str().unwrap()] {
            assert!(fs_files(bad.into()).is_err(), "fs_files accepted {bad:?}");
            assert!(search_in(bad, "needle", None).is_err(), "fs_search accepted {bad:?}");
        }
        assert!(search_in(dir.path().to_str().unwrap(), "(", None).is_err());
        assert!(search_in(dir.path().to_str().unwrap(), "needle", Some("[")).is_err());
        assert_eq!(fs_files(dir.path().to_str().unwrap().into()).unwrap(), ["plain.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn files_and_search_do_not_escape_through_symlinks() {
        let (_dir, root, _outside) = escape_fixture();
        let root_str = root.to_str().unwrap();

        let files = fs_files(root_str.into()).unwrap();
        assert_eq!(files, ["src/a.txt"], "symlinked files and directories must not be listed");

        let hits = search_in(root_str, "needle", None).unwrap();
        assert!(hits.contains("src/a.txt:1:needle inside"), "{hits}");
        assert!(!hits.contains("outside"), "{hits}");
        assert!(!hits.contains("secret"), "{hits}");
        assert!(!hits.contains("link"), "{hits}");
        assert!(!hits.contains("src_alias"), "{hits}");

        // A glob cannot be used to pull the symlink targets in either.
        assert_eq!(search_in(root_str, "needle", Some("*.txt")).unwrap().lines().count(), 1);
        assert_eq!(search_in(root_str, "needle outside", Some("**/secret.txt")).unwrap(), "no matches");
    }

    #[cfg(unix)]
    #[test]
    fn contained_rejects_paths_that_resolve_outside_root() {
        let (_dir, root, outside) = escape_fixture();
        let base = root.canonicalize().unwrap();

        assert!(contained(&base, &root.join("src/a.txt")).is_some());
        assert!(contained(&base, &root.join("src_alias/a.txt")).is_some(), "in-root symlink resolves inside");
        assert!(contained(&base, &root.join("filelink.txt")).is_none());
        assert!(contained(&base, &root.join("dirlink/secret.txt")).is_none());
        assert!(contained(&base, &outside.join("secret.txt")).is_none());
        assert!(contained(&base, &root.join("src/../../outside/secret.txt")).is_none());
        assert!(contained(&base, &root.join("nope.txt")).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn root_given_as_symlink_is_canonicalized() {
        let (dir, root, _outside) = escape_fixture();
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        let alias_str = alias.to_str().unwrap();

        assert_eq!(fs_files(alias_str.into()).unwrap(), ["src/a.txt"]);
        assert!(search_in(alias_str, "needle", None).unwrap().starts_with("src/a.txt:1:"));
    }

    #[test]
    fn search_caps_matches_and_reports_none() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("many.txt"), "hit\n".repeat(400)).unwrap();
        let root = dir.path().to_str().unwrap();

        let out = search_in(root, "hit", None).unwrap();
        assert_eq!(out.lines().filter(|l| l.starts_with("many.txt:")).count(), 300);
        assert!(out.ends_with("…[more matches omitted]"));
        assert_eq!(search_in(root, "absent", None).unwrap(), "no matches");
    }

    #[test]
    fn read_instructions_collects_known_files_and_always_apply_rules() {
        let dir = tempfile::tempdir().unwrap();
        let rules = dir.path().join(".cursor/rules");
        fs::create_dir_all(&rules).unwrap();
        fs::write(dir.path().join("AGENTS.md"), "agents text").unwrap();
        fs::write(dir.path().join("CLAUDE.md"), "claude text").unwrap();
        fs::write(dir.path().join(".cursorrules"), "legacy").unwrap();
        fs::write(rules.join("on.mdc"), "---\nalwaysApply: true\n---\nbody").unwrap();
        fs::write(rules.join("off.mdc"), "---\nalwaysApply: false\n---\n").unwrap();
        fs::write(rules.join("body-only.mdc"), "no front matter\nalwaysApply: true").unwrap();
        fs::write(rules.join("note.txt"), "---\nalwaysApply: true\n---\n").unwrap();

        let out = read_instructions(dir.path().to_str().unwrap().into());
        let names: Vec<&str> = out.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".cursor/rules/on.mdc"]);
        assert_eq!(out[0].text, "agents text");
        assert_eq!(out[0].bytes, 11);
    }

    #[cfg(unix)]
    #[test]
    fn read_instructions_skips_symlinks_out_of_the_project_and_duplicates() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "outside").unwrap();
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("CLAUDE.md"), "claude").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.md"), dir.path().join("AGENTS.md")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("CLAUDE.md"), dir.path().join(".cursorrules")).unwrap();
        let out = read_instructions(dir.path().to_str().unwrap().into());
        let names: Vec<&str> = out.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["CLAUDE.md"], "escaping symlink skipped, in-project symlink to the same file deduped");
    }

    #[test]
    fn read_instructions_caps_the_read_but_reports_the_real_size() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("AGENTS.md"), "x".repeat(100_000)).unwrap();
        let out = read_instructions(dir.path().to_str().unwrap().into());
        assert_eq!(out[0].bytes, 100_000);
        assert_eq!(out[0].text.len(), INSTRUCTION_READ_CAP as usize);
    }
}
