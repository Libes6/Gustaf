use std::{
    collections::hash_map::DefaultHasher,
    collections::HashMap,
    fs,
    hash::{Hash, Hasher},
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};

// Multiple mounted chats and refreshes can share a shadow index. Git uses an
// exclusive index.lock, so serialize commands targeting the same project.
static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

/// Shadow repo per project in app data, so checkpoints never touch the user's own git.
fn shadow_dir(app: &AppHandle, root: &str) -> Result<PathBuf, String> {
    let mut h = DefaultHasher::new();
    root.hash(&mut h);
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("shadow").join(format!("{:x}", h.finish()));
    if !dir.join("HEAD").exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        run(Command::new("git").args(["init", "-q", "--bare"]).arg(&dir))?;
        fs::create_dir_all(dir.join("info")).map_err(|e| e.to_string())?;
        fs::write(dir.join("info/exclude"), ".git/\nnode_modules/\ntarget/\ndist/\n.DS_Store\n").map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd
        .env("GIT_AUTHOR_NAME", "mcode")
        .env("GIT_AUTHOR_EMAIL", "mcode@local")
        .env("GIT_COMMITTER_NAME", "mcode")
        .env("GIT_COMMITTER_EMAIL", "mcode@local")
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Runs git in `root`; with `shadow` it targets the app's checkpoint repo instead of the project's own `.git`.
#[tauri::command]
pub async fn git(app: AppHandle, root: String, args: Vec<String>, shadow: bool) -> Result<String, String> {
    let key = PathBuf::from(&root).canonicalize().map_err(|e| e.to_string())?;
    let lock = LOCKS.get_or_init(Default::default).lock().map_err(|e| e.to_string())?.entry(key).or_default().clone();
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    let mut cmd = Command::new("git");
    cmd.current_dir(&root);
    if shadow {
        cmd.arg(format!("--git-dir={}", shadow_dir(&app, &root)?.display())).arg(format!("--work-tree={root}"));
    }
    run(cmd.args(&args))
}
