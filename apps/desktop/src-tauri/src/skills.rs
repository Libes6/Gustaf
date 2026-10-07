//! Skill/command files are discovered in fixed project/home locations; bodies are read on demand.
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_BODY: u64 = 128 * 1024;
#[derive(Serialize)]
pub struct SkillEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: String,
}

fn field(text: &str, key: &str) -> Option<String> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines.take_while(|x| x.trim() != "---") {
        if let Some(v) = line.strip_prefix(&format!("{key}:")) {
            let value = v.trim().trim_matches(|c| c == '\'' || c == '"');
            if !value.is_empty() && value != ">" && value != "|" {
                return Some(value.to_string());
            }
        }
    }
    None
}
fn roots(project: Option<&str>) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    if let Some(p) = project {
        if let Ok(p) = Path::new(p).canonicalize() {
            out.push(("project".into(), p));
        }
    }
    if let Some(p) = dirs::home_dir().and_then(|p| p.canonicalize().ok()) {
        out.push(("global".into(), p));
    }
    out
}
fn files(root: &Path, rel: &str, depth: usize, command: bool, out: &mut Vec<String>) {
    if depth > 4 || out.len() >= 200 {
        return;
    }
    let Ok(dir) = fs::read_dir(root.join(rel)) else {
        return;
    };
    let mut entries: Vec<_> = dir.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        // Never follow linked folders: bounded traversal, no cycles or escaping roots.
        let Ok(kind) = e.file_type() else {
            continue;
        };
        if kind.is_symlink() || !canonical.starts_with(root) {
            continue;
        }
        let Some(name) = e.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let next = format!("{rel}/{name}");
        if kind.is_dir() {
            files(root, &next, depth + 1, command, out);
        } else if kind.is_file() && (name == "SKILL.md" || command && name.ends_with(".md")) {
            out.push(next);
        }
        if out.len() >= 200 {
            break;
        }
    }
}
fn discovered(project: Option<&str>) -> Vec<(String, PathBuf, String)> {
    let mut out = Vec::new();
    for (source, root) in roots(project) {
        let mut names = Vec::new();
        // `.mcode/skills` is the folder of projects (and `~/.mcode`) set up before the rename.
        for rel in [
            ".agents/skills",
            ".gustaf/skills",
            ".mcode/skills",
            ".claude/skills",
            ".cursor/skills",
            ".codex/skills",
        ] {
            files(&root, rel, 0, false, &mut names);
        }
        for rel in [".cursor/commands", ".claude/commands"] {
            files(&root, rel, 0, true, &mut names);
        }
        names.sort();
        names.dedup();
        out.extend(
            names
                .into_iter()
                .map(|rel| (source.clone(), root.clone(), rel)),
        );
    }
    out
}
fn read(root: &Path, rel: &str) -> Result<String, String> {
    let path = root.join(rel).canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(root) {
        return Err("Skill escaped its root".into());
    }
    let f = fs::File::open(path).map_err(|e| e.to_string())?;
    if f.metadata().map_err(|e| e.to_string())?.len() > MAX_BODY {
        return Err("Skill exceeds 128 KiB".into());
    }
    let mut body = String::new();
    f.take(MAX_BODY + 1)
        .read_to_string(&mut body)
        .map_err(|e| e.to_string())?;
    if body.len() as u64 > MAX_BODY {
        return Err("Skill exceeds 128 KiB".into());
    }
    Ok(body)
}
#[tauri::command]
pub fn skills_scan(root: Option<String>) -> Vec<SkillEntry> {
    discovered(root.as_deref())
        .into_iter()
        .filter_map(|(source, base, rel)| {
            let body = read(&base, &rel).ok()?;
            let path = Path::new(&rel);
            let fallback = if path.file_name()?.to_str()? == "SKILL.md" {
                path.parent()?.file_name()?.to_str()?
            } else {
                path.file_stem()?.to_str()?
            };
            let name = field(&body, "name").unwrap_or_else(|| fallback.into());
            if name.is_empty()
                || !name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return None;
            }
            Some(SkillEntry {
                id: format!("{source}:{rel}"),
                name: name.to_lowercase(),
                description: field(&body, "description")
                    .unwrap_or_else(|| format!("{} instruction: {}", source, fallback)),
                source,
            })
        })
        .collect()
}
#[tauri::command]
pub fn skills_read(root: Option<String>, id: String) -> Result<String, String> {
    let (_, base, rel) = discovered(root.as_deref())
        .into_iter()
        .find(|(source, _, rel)| format!("{source}:{rel}") == id)
        .ok_or("Skill is no longer available")?;
    read(&base, &rel)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_compatibility_and_read_limits() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        fs::create_dir_all(base.join(".agents/skills/demo")).unwrap();
        fs::write(
            base.join(".agents/skills/demo/SKILL.md"),
            "---\nname: demo\ndescription: 'Demo skill'\n---\nBody",
        )
        .unwrap();
        fs::create_dir_all(base.join(".cursor/commands")).unwrap();
        fs::write(base.join(".cursor/commands/review.md"), "Review this").unwrap();
        let root = base.to_str().unwrap().to_string();
        let entries = skills_scan(Some(root.clone()));
        assert!(entries
            .iter()
            .any(|e| e.name == "demo" && e.description == "Demo skill"));
        assert!(entries
            .iter()
            .any(|e| e.name == "review" && e.source == "project"));
        assert!(skills_read(Some(root.clone()), "project:../secret".into()).is_err());
        assert_eq!(
            skills_read(Some(root), "project:.cursor/commands/review.md".into()).unwrap(),
            "Review this"
        );
        fs::write(base.join("big.md"), vec![b'x'; MAX_BODY as usize + 1]).unwrap();
        assert!(read(base, "big.md").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn discovery_rejects_skills_linked_outside_project() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".agents/skills")).unwrap();
        fs::write(
            outside.path().join("SKILL.md"),
            "---\nname: escape\n---\nSecret",
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join(".agents/skills/escape"))
            .unwrap();
        let root = dir.path().to_str().unwrap().to_string();
        assert!(!skills_scan(Some(root.clone()))
            .iter()
            .any(|s| s.source == "project" && s.name == "escape"));
        assert!(skills_read(
            Some(root.clone()),
            "project:.agents/skills/escape/SKILL.md".into()
        )
        .is_err());
        fs::create_dir_all(dir.path().join(".agents/skills/linked-file")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("SKILL.md"),
            dir.path().join(".agents/skills/linked-file/SKILL.md"),
        )
        .unwrap();
        assert!(skills_read(
            Some(root),
            "project:.agents/skills/linked-file/SKILL.md".into()
        )
        .is_err());
        assert!(read(dir.path(), "../SKILL.md").is_err());
    }
}
