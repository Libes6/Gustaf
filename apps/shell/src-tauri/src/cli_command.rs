//! The `gustaf` command for terminals, run by the app's bundled CLI.
//!
//! A launcher in the app's data folder runs the bundled `runtime/t3` against the same home the
//! app's server uses. Settings links it into `~/.local/bin` or `~/bin` (macOS, Linux), or puts
//! its folder on the user's PATH (Windows). Only launchers and links Gustaf wrote are touched.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

const MARKER: &str = "Written by Gustaf: runs the desktop app's bundled gustaf CLI.";
const MOVED: &str = "Gustaf has moved or been removed. Open the app once to update this command.";
/// The launcher is a few hundred bytes; never read a large binary another `gustaf` is.
const MAX_LAUNCHER_BYTES: u64 = 16_384;

/// One change at a time, so two Settings windows cannot both append the PATH line.
static CHANGES: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct PathSetupState {
    file: String,
    added: bool,
}

/// `DesktopCliCommandState` in packages/contracts/src/ipc.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CliCommandState {
    supported: bool,
    installed_path: Option<String>,
    on_path: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    shadowed_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path_setup: Option<PathSetupState>,
    launcher_path: Option<String>,
}

impl CliCommandState {
    fn unsupported() -> Self {
        Self {
            supported: false,
            installed_path: None,
            on_path: false,
            shadowed_by: None,
            path_setup: None,
            launcher_path: None,
        }
    }
}

/// Where everything is, read once per call; tests point it into a temporary folder.
#[derive(Clone)]
// Windows reads only the folders; PATH and shell details serve the Unix link.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) struct Layout {
    home: PathBuf,
    /// The bundled CLI executable.
    executable: PathBuf,
    /// The app's data folder, which the server uses as its base dir.
    data_dir: PathBuf,
    /// PATH as a new terminal sees it.
    path_env: String,
    shell: Option<String>,
    config_home: Option<String>,
    zdotdir: Option<String>,
    macos: bool,
}

impl Layout {
    fn launcher(&self) -> PathBuf {
        self.data_dir.join("bin").join(if cfg!(windows) {
            "gustaf.cmd"
        } else {
            "gustaf"
        })
    }
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn write_launcher(layout: &Layout) -> Result<(), String> {
    let launcher = layout.launcher();
    let content = render_launcher(&launcher, &layout.data_dir, &layout.executable);
    let existing = fs::read_to_string(&launcher).ok();
    if let Some(existing) = &existing {
        if !existing.contains(MARKER) {
            return Err(format!(
                "Gustaf did not write the file at {}, so it was left in place.",
                display(&launcher)
            ));
        }
    }
    if existing.as_deref() == Some(content.as_str()) {
        return Ok(());
    }
    let failed = |_| {
        format!(
            "Could not set up the gustaf launcher at {}.",
            display(&launcher)
        )
    };
    let parent = launcher.parent().expect("the launcher has a folder");
    fs::create_dir_all(parent).map_err(failed)?;
    let staging = launcher.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&staging, content).map_err(failed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staging, fs::Permissions::from_mode(0o755)).map_err(failed)?;
    }
    fs::rename(&staging, &launcher).map_err(|error| {
        let _ = fs::remove_file(&staging);
        failed(error)
    })
}

#[cfg(unix)]
fn render_launcher(launcher: &Path, data_dir: &Path, executable: &Path) -> String {
    let word = |path: &Path| format!("'{}'", display(path).replace('\'', r#"'"'"'"#));
    [
        "#!/bin/sh".to_owned(),
        format!("# {MARKER}"),
        format!("export T3CODE_CLI_PATH={}", word(launcher)),
        format!("home={}", word(data_dir)),
        r#"export T3CODE_HOME="${T3CODE_HOME:-$home}""#.to_owned(),
        format!("app={}", word(executable)),
        r#"if [ ! -x "$app" ]; then"#.to_owned(),
        format!(r#"  echo "{MOVED}" >&2"#),
        "  exit 127".to_owned(),
        "fi".to_owned(),
        r#"exec "$app" "$@""#.to_owned(),
        String::new(),
    ]
    .join("\n")
}

#[cfg(windows)]
fn render_launcher(launcher: &Path, data_dir: &Path, executable: &Path) -> String {
    // cmd.exe expands `%` even inside quotes; Windows paths cannot contain `"`.
    let text = |path: &Path| display(path).replace('%', "%%");
    let utf8 = [launcher, data_dir, executable]
        .iter()
        .any(|path| !display(path).is_ascii());
    let restore: Vec<String> = if utf8 {
        vec!["chcp %t3_codepage% >nul".to_owned()]
    } else {
        Vec::new()
    };
    let mut lines = vec![
        "@echo off".to_owned(),
        format!("rem {MARKER}"),
        // Delayed expansion would rewrite `!name!` in paths and arguments.
        "setlocal EnableExtensions DisableDelayedExpansion".to_owned(),
    ];
    if utf8 {
        lines.push(
            r#"for /f "tokens=2 delims=:." %%c in ('chcp') do set "t3_codepage=%%c""#.to_owned(),
        );
        lines.push("chcp 65001 >nul".to_owned());
    }
    lines.push(format!(r#"set "T3CODE_CLI_PATH={}""#, text(launcher)));
    lines.push(format!(
        r#"if not defined T3CODE_HOME set "T3CODE_HOME={}""#,
        text(data_dir)
    ));
    // A goto, not a parenthesized block: "Program Files (x86)" would close the block early.
    lines.push(format!(r#"if exist "{}" goto run"#, text(executable)));
    lines.extend(restore.iter().cloned());
    lines.push(format!("echo {MOVED} 1>&2"));
    lines.push("exit /b 127".to_owned());
    lines.push(":run".to_owned());
    lines.push(format!(r#""{}" %*"#, text(executable)));
    lines.push(r#"set "t3_exit=%ERRORLEVEL%""#.to_owned());
    lines.extend(restore);
    lines.push("exit /b %t3_exit%".to_owned());
    lines.push(String::new());
    lines.join("\r\n")
}

#[cfg(unix)]
mod unix {
    use super::*;

    fn user_candidates(layout: &Layout) -> Vec<PathBuf> {
        vec![layout.home.join(".local/bin"), layout.home.join("bin")]
    }

    /// Links in Homebrew's folders are found and removed, but no new link goes there.
    fn known_locations(layout: &Layout) -> Vec<PathBuf> {
        let mut locations = user_candidates(layout);
        if layout.macos {
            locations.push(PathBuf::from("/opt/homebrew/bin"));
            locations.push(PathBuf::from("/usr/local/bin"));
        }
        locations
    }

    fn path_entries(layout: &Layout) -> Vec<PathBuf> {
        layout
            .path_env
            .split(':')
            .filter(|entry| !entry.is_empty())
            .map(|entry| PathBuf::from(entry.trim_end_matches('/')))
            .collect()
    }

    fn small_marked_file(path: &Path) -> bool {
        fs::metadata(path).is_ok_and(|info| info.is_file() && info.len() <= MAX_LAUNCHER_BYTES)
            && fs::read_to_string(path).is_ok_and(|content| content.contains(MARKER))
    }

    /// A link to a Gustaf launcher, this install's or another's.
    fn is_our_link(link: &Path) -> bool {
        fs::symlink_metadata(link).is_ok_and(|info| info.file_type().is_symlink())
            && small_marked_file(link)
    }

    fn leads_here(layout: &Layout, link: &Path) -> bool {
        fs::read_link(link).is_ok_and(|target| target == layout.launcher())
    }

    fn runs_our_launcher(layout: &Layout, candidate: &Path) -> bool {
        match (
            fs::canonicalize(candidate),
            fs::canonicalize(layout.launcher()),
        ) {
            (Ok(resolved), Ok(ours)) => resolved == ours && small_marked_file(candidate),
            _ => false,
        }
    }

    fn is_executable_file(path: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .is_ok_and(|info| info.is_file() && info.permissions().mode() & 0o111 != 0)
    }

    fn first_on_path(layout: &Layout) -> Option<PathBuf> {
        path_entries(layout)
            .into_iter()
            .map(|directory| directory.join("gustaf"))
            .find(|candidate| is_executable_file(candidate))
    }

    fn foreign_first_on_path(layout: &Layout) -> Option<PathBuf> {
        first_on_path(layout).filter(|first| !runs_our_launcher(layout, first))
    }

    fn installed_at(layout: &Layout) -> Option<PathBuf> {
        known_locations(layout)
            .into_iter()
            .map(|directory| directory.join("gustaf"))
            .find(|link| is_our_link(link))
    }

    fn folder_on_path(layout: &Layout, link: &Path) -> bool {
        let folder = link.parent().map(Path::to_path_buf);
        path_entries(layout)
            .into_iter()
            .any(|entry| Some(entry) == folder)
    }

    fn safe(value: &str) -> bool {
        !value.is_empty()
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
    }

    pub(super) struct StartupLine {
        /// As shown to the user, `~/...` or absolute.
        pub(super) file: String,
        pub(super) path: PathBuf,
        pub(super) line: String,
    }

    /// `pathSetup` in packages/shared/src/shell.ts: the file and line that put `directory` last on
    /// PATH for new zsh, bash, or fish terminals, so it never shadows another `gustaf`.
    pub(super) fn startup_line(layout: &Layout, directory: &Path) -> Option<StartupLine> {
        let directory = display(directory);
        let home = display(&layout.home);
        if !directory.starts_with('/') {
            return None;
        }
        let under_home = directory.starts_with(&format!("{home}/"));
        let rest = if under_home {
            &directory[home.len()..]
        } else {
            directory.as_str()
        };
        if !safe(rest) {
            return None;
        }
        let directory = if under_home {
            format!("$HOME{rest}")
        } else {
            rest.to_owned()
        };
        let shell = layout.shell.as_deref()?.rsplit('/').next()?;
        // A set folder the shell reads from replaces the default; one unsafe to write means no setup.
        let read_from = |value: Option<&str>, fallback: &str| -> Option<String> {
            match value {
                None | Some("") => Some(fallback.to_owned()),
                Some(value) if value.starts_with('/') && safe(value) => Some(value.to_owned()),
                Some(_) => None,
            }
        };
        let (file, line) = if shell == "fish" {
            let config_home = read_from(layout.config_home.as_deref(), "~/.config")?;
            (
                format!("{config_home}/fish/config.fish"),
                format!("fish_add_path --append --path {directory}"),
            )
        } else {
            let file = match shell {
                "zsh" => format!("{}/.zshrc", read_from(layout.zdotdir.as_deref(), "~")?),
                // macOS bash reads only the first of .bash_profile, .bash_login, and .profile.
                "bash" if !layout.macos => "~/.bashrc".to_owned(),
                _ => return None,
            };
            (file, format!(r#"export PATH="$PATH:{directory}""#))
        };
        let path = match file.strip_prefix("~/") {
            Some(rest) => layout.home.join(rest),
            None => PathBuf::from(&file),
        };
        Some(StartupLine { file, path, line })
    }

    fn has_line(setup: &StartupLine) -> bool {
        fs::read_to_string(&setup.path)
            .is_ok_and(|content| content.lines().any(|line| line.trim() == setup.line))
    }

    pub(super) fn state(layout: &Layout) -> CliCommandState {
        let launcher = layout.launcher();
        let found = installed_at(layout);
        // Our link into another install's launcher is not this app's command; Install updates it.
        let installed = found.clone().filter(|link| leads_here(layout, link));
        let shadowed_by =
            foreign_first_on_path(layout).filter(|first| Some(first) != found.as_ref());
        let on_path = first_on_path(layout).is_some_and(|first| runs_our_launcher(layout, &first));
        // Only a folder missing from PATH with no other gustaf first: with one, the added folder (last
        // on PATH) would still not run this gustaf.
        let setup = match &installed {
            Some(link) if !on_path && shadowed_by.is_none() && !folder_on_path(layout, link) => {
                link.parent()
                    .and_then(|folder| startup_line(layout, folder))
            }
            _ => None,
        };
        CliCommandState {
            supported: true,
            installed_path: installed.as_deref().map(display),
            on_path,
            shadowed_by: shadowed_by.as_deref().map(display),
            path_setup: setup.map(|setup| PathSetupState {
                added: has_line(&setup),
                file: setup.file,
            }),
            launcher_path: launcher.exists().then(|| display(&launcher)),
        }
    }

    pub(super) fn install(layout: &Layout) -> Result<CliCommandState, String> {
        write_launcher(layout)?;
        let launcher = layout.launcher();
        let replaced = installed_at(layout);
        if replaced
            .as_ref()
            .is_some_and(|link| leads_here(layout, link))
        {
            return Ok(state(layout));
        }
        if let Some(shadow) = foreign_first_on_path(layout) {
            // Our own link into another install runs first too; it is the one this updates.
            if Some(&shadow) != replaced.as_ref() {
                return Err(format!(
                    "Another gustaf at {} runs first in a new terminal. Remove it, or run the launcher directly at {}.",
                    display(&shadow),
                    display(&launcher)
                ));
            }
        }
        // An old link of ours is updated where it is, so a gustaf that works now keeps working.
        let on_path = path_entries(layout);
        let candidates = user_candidates(layout);
        let mut folders: Vec<PathBuf> = Vec::new();
        let ordered = replaced
            .iter()
            .filter_map(|link| link.parent().map(Path::to_path_buf))
            .chain(candidates.iter().filter(|c| on_path.contains(c)).cloned())
            .chain(candidates.iter().filter(|c| !on_path.contains(c)).cloned());
        for folder in ordered {
            if !folders.contains(&folder) {
                folders.push(folder);
            }
        }
        for folder in folders {
            if fs::create_dir_all(&folder).is_err() {
                continue;
            }
            let link = folder.join("gustaf");
            let linked = if Some(&link) == replaced.as_ref() {
                // Swapped in place, so the command never goes missing.
                let staging = link.with_extension(format!("{}.tmp", std::process::id()));
                std::os::unix::fs::symlink(&launcher, &staging).is_ok()
                    && fs::rename(&staging, &link)
                        .map_err(|_| fs::remove_file(&staging))
                        .is_ok()
            } else {
                // Anything already there makes this fail, and it stays.
                std::os::unix::fs::symlink(&launcher, &link).is_ok()
            };
            if !linked {
                continue;
            }
            if let Some(replaced) = replaced.as_ref().filter(|replaced| **replaced != link) {
                let _ = fs::remove_file(replaced);
            }
            return Ok(state(layout));
        }
        Err(format!(
            "Another gustaf command is already in ~/.local/bin and ~/bin, or neither is writable. Run the launcher directly at {}.",
            display(&launcher)
        ))
    }

    pub(super) fn uninstall(layout: &Layout) -> Result<CliCommandState, String> {
        for folder in known_locations(layout) {
            let link = folder.join("gustaf");
            if is_our_link(&link) {
                fs::remove_file(&link)
                    .map_err(|_| format!("Could not remove {}.", display(&link)))?;
            }
        }
        Ok(state(layout))
    }

    pub(super) fn add_to_path(layout: &Layout) -> Result<CliCommandState, String> {
        let installed = installed_at(layout)
            .filter(|link| leads_here(layout, link))
            .ok_or("Install the gustaf command first.")?;
        let setup = installed
            .parent()
            .and_then(|folder| startup_line(layout, folder))
            .ok_or("Gustaf cannot add the gustaf command to this shell's PATH.")?;
        if let Some(shadow) = foreign_first_on_path(layout) {
            return Err(format!(
                "Another gustaf at {} runs first; Gustaf leaves it in place.",
                display(&shadow)
            ));
        }
        if !folder_on_path(layout, &installed) && !has_line(&setup) {
            use std::io::Write;
            let failed = |_| format!("Could not add gustaf to {}.", setup.file);
            if let Some(parent) = setup.path.parent() {
                fs::create_dir_all(parent).map_err(failed)?;
            }
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&setup.path)
                .and_then(|mut file| write!(file, "\n# Added by Gustaf\n{}\n", setup.line))
                .map_err(failed)?;
        }
        Ok(state(layout))
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use base64::Engine;
    use std::process::{Command, Stdio};

    // Preserve REG_EXPAND_SZ and %VAR% expansion; notify Explorer with WM_SETTINGCHANGE.
    // A failed read must exit nonzero, so PATH is never replaced wholesale.
    const USER_PATH_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
if ($env:T3_SET -eq '1') {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path' -and $key.GetValueKind('Path') -eq 'String') {
    $kind = [Microsoft.Win32.RegistryValueKind]::String
  }
  $key.SetValue('Path', $env:T3_PATH, $kind)
  Add-Type -Namespace T3 -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'
  $result = [System.UIntPtr]::Zero
  [void][T3.Env]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
} else {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  $value = if ($key) { $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value)))
}
"#;

    fn powershell(set: Option<&str>) -> Result<String, ()> {
        let program = std::env::var("SystemRoot")
            .map(|root| format!(r"{root}\System32\WindowsPowerShell\v1.0\powershell.exe"))
            .unwrap_or_else(|_| "powershell.exe".to_owned());
        let mut command = Command::new(program);
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                USER_PATH_SCRIPT,
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            // Explicit, so an inherited T3_SET=1 never turns a read into a write.
            .env("T3_SET", if set.is_some() { "1" } else { "0" });
        if let Some(value) = set {
            command.env("T3_PATH", value);
        }
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x08000000);
        let output = command.output().map_err(|_| ())?;
        if !output.status.success() {
            return Err(());
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn read_user_path() -> Result<Vec<String>, String> {
        let failed = || "Could not read your PATH, so it was left unchanged.".to_owned();
        let encoded = powershell(None).map_err(|_| failed())?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|_| failed())?;
        let value = String::from_utf8(bytes).map_err(|_| failed())?;
        Ok(value
            .split(';')
            .filter(|entry| !entry.is_empty())
            .map(str::to_owned)
            .collect())
    }

    fn write_user_path(entries: &[String]) -> Result<(), String> {
        powershell(Some(&entries.join(";")))
            .map(|_| ())
            .map_err(|_| "Could not update your PATH.".to_owned())
    }

    fn same(left: &str, right: &Path) -> bool {
        let trim = |value: &str| value.trim_end_matches(['\\', '/']).to_lowercase();
        trim(left) == trim(&display(right))
    }

    fn bin_folder(layout: &Layout) -> PathBuf {
        layout
            .launcher()
            .parent()
            .expect("the launcher has a folder")
            .to_path_buf()
    }

    /// Records that Gustaf added the folder, so removing never takes out one the user added.
    fn owned_marker(layout: &Layout) -> PathBuf {
        layout.data_dir.join("cli-command-path-entry")
    }

    pub(super) fn state(layout: &Layout) -> CliCommandState {
        let launcher = layout.launcher();
        let folder = bin_folder(layout);
        let installed = owned_marker(layout).exists()
            && read_user_path()
                .is_ok_and(|entries| entries.iter().any(|entry| same(entry, &folder)));
        CliCommandState {
            supported: true,
            installed_path: installed.then(|| display(&launcher)),
            on_path: installed,
            shadowed_by: None,
            path_setup: None,
            launcher_path: launcher.exists().then(|| display(&launcher)),
        }
    }

    pub(super) fn install(layout: &Layout) -> Result<CliCommandState, String> {
        write_launcher(layout)?;
        let folder = bin_folder(layout);
        // PATH would split the folder at the `;`, leaving two wrong entries behind.
        if display(&folder).contains(';') {
            return Err(format!(
                "Gustaf cannot put {} on PATH because it has a \";\". Run {} directly.",
                display(&folder),
                display(&layout.launcher())
            ));
        }
        let mut entries = read_user_path()?;
        if !entries.iter().any(|entry| same(entry, &folder)) {
            entries.push(display(&folder));
            write_user_path(&entries)?;
            fs::write(owned_marker(layout), format!("{}\n", display(&folder)))
                .map_err(|_| "Added gustaf to your PATH but could not record it.".to_owned())?;
        }
        Ok(state(layout))
    }

    pub(super) fn uninstall(layout: &Layout) -> Result<CliCommandState, String> {
        if owned_marker(layout).exists() {
            let folder = bin_folder(layout);
            let entries = read_user_path()?;
            let kept: Vec<String> = entries
                .iter()
                .filter(|entry| !same(entry, &folder))
                .cloned()
                .collect();
            if kept.len() != entries.len() {
                write_user_path(&kept)?;
            }
            let _ = fs::remove_file(owned_marker(layout));
        }
        Ok(state(layout))
    }

    pub(super) fn add_to_path(layout: &Layout) -> Result<CliCommandState, String> {
        install(layout)
    }
}

#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;

#[cfg(unix)]
fn login_shell() -> Option<String> {
    if let Some(shell) = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())
    {
        return Some(shell);
    }
    // A Dock or desktop-file launch may not set SHELL.
    // SAFETY: getpwuid returns null or a record valid until the next getpw* call on this thread.
    unsafe {
        let record = libc::getpwuid(libc::getuid());
        if record.is_null() || (*record).pw_shell.is_null() {
            return None;
        }
        std::ffi::CStr::from_ptr((*record).pw_shell)
            .to_str()
            .ok()
            .map(str::to_owned)
    }
}

#[cfg(windows)]
fn login_shell() -> Option<String> {
    None
}

/// None in development builds, which run the server from the checkout and have no bundled CLI.
fn layout(app: &tauri::AppHandle) -> Option<Layout> {
    if cfg!(debug_assertions) {
        return None;
    }
    let executable = app
        .path()
        .resource_dir()
        .ok()?
        .join("runtime")
        .join(if cfg!(windows) { "t3.exe" } else { "t3" });
    let home = app.path().home_dir().ok()?;
    let data_dir = app.path().app_local_data_dir().ok()?;
    let path_env = crate::login_shell_path()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    Some(Layout {
        home,
        executable,
        data_dir,
        path_env,
        shell: login_shell(),
        config_home: std::env::var("XDG_CONFIG_HOME").ok(),
        zdotdir: std::env::var("ZDOTDIR").ok(),
        macos: cfg!(target_os = "macos"),
    })
}

async fn run(
    app: tauri::AppHandle,
    change: fn(&Layout) -> Result<CliCommandState, String>,
) -> Result<CliCommandState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let layout = layout(&app).ok_or("The gustaf command needs an installed Gustaf app.")?;
        let _held = CHANGES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        change(&layout)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn cli_command_state(app: tauri::AppHandle) -> Result<CliCommandState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        layout(&app).map_or_else(CliCommandState::unsupported, |layout| {
            platform::state(&layout)
        })
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn cli_command_install(app: tauri::AppHandle) -> Result<CliCommandState, String> {
    run(app, platform::install).await
}

#[tauri::command]
pub(crate) async fn cli_command_uninstall(
    app: tauri::AppHandle,
) -> Result<CliCommandState, String> {
    run(app, platform::uninstall).await
}

#[tauri::command]
pub(crate) async fn cli_command_add_to_path(
    app: tauri::AppHandle,
) -> Result<CliCommandState, String> {
    run(app, platform::add_to_path).await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        layout: Layout,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn fixture(name: &str, shell: &str, path_env: impl Fn(&Path) -> String) -> Fixture {
        let root = std::env::temp_dir().join(format!("gustaf-cli-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let home = root.join("home");
        let executable = root.join("app/runtime/t3");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(&executable, "#!/bin/sh\n").unwrap();
        let layout = Layout {
            path_env: path_env(&home),
            home,
            executable,
            data_dir: root.join("data dir"),
            shell: Some(shell.to_owned()),
            config_home: None,
            zdotdir: None,
            macos: false,
        };
        Fixture { root, layout }
    }

    #[test]
    fn installs_into_a_folder_on_path_and_removes_it_again() {
        let f = fixture("on-path", "/bin/zsh", |home| {
            format!("/usr/bin:{}/.local/bin/", home.display())
        });
        let state = platform::install(&f.layout).unwrap();
        let link = f.layout.home.join(".local/bin/gustaf");
        assert_eq!(state.installed_path, Some(display(&link)));
        assert!(state.on_path);
        assert_eq!(state.path_setup, None);
        assert_eq!(fs::read_link(&link).unwrap(), f.layout.launcher());
        let launcher = fs::read_to_string(f.layout.launcher()).unwrap();
        assert!(launcher.contains("home='"));
        assert!(launcher.contains(&format!("app='{}'", f.layout.executable.display())));

        let state = platform::uninstall(&f.layout).unwrap();
        assert_eq!(state.installed_path, None);
        assert!(!link.exists());
        assert!(
            f.layout.launcher().exists(),
            "the launcher itself stays for direct runs"
        );
    }

    #[test]
    fn adds_the_folder_to_the_shell_startup_file_once() {
        let f = fixture("startup", "/usr/bin/zsh", |_| "/usr/bin".to_owned());
        let state = platform::install(&f.layout).unwrap();
        assert!(!state.on_path);
        assert_eq!(
            state.path_setup,
            Some(PathSetupState {
                file: "~/.zshrc".to_owned(),
                added: false
            })
        );
        platform::add_to_path(&f.layout).unwrap();
        let state = platform::add_to_path(&f.layout).unwrap();
        let rc = fs::read_to_string(f.layout.home.join(".zshrc")).unwrap();
        assert_eq!(
            rc.matches(r#"export PATH="$PATH:$HOME/.local/bin""#)
                .count(),
            1
        );
        assert_eq!(state.path_setup.map(|setup| setup.added), Some(true));
    }

    #[test]
    fn leaves_a_gustaf_it_did_not_write_alone() {
        let f = fixture("foreign", "/bin/bash", |home| {
            format!("{}/.local/bin", home.display())
        });
        let local_bin = f.layout.home.join(".local/bin");
        fs::create_dir_all(&local_bin).unwrap();
        let foreign = local_bin.join("gustaf");
        fs::write(&foreign, "#!/bin/sh\necho other\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&foreign, fs::Permissions::from_mode(0o755)).unwrap();

        let state = platform::state(&f.layout);
        assert_eq!(state.shadowed_by, Some(display(&foreign)));
        assert!(platform::install(&f.layout).is_err());
        platform::uninstall(&f.layout).unwrap();
        assert_eq!(
            fs::read_to_string(&foreign).unwrap(),
            "#!/bin/sh\necho other\n"
        );
    }

    #[test]
    fn the_startup_line_matches_the_shared_path_setup() {
        let f = fixture("setup", "/usr/local/bin/fish", |_| String::new());
        let folder = f.layout.home.join(".local/bin");
        let setup = unix::startup_line(&f.layout, &folder).unwrap();
        assert_eq!(setup.file, "~/.config/fish/config.fish");
        assert_eq!(setup.line, "fish_add_path --append --path $HOME/.local/bin");

        let bash = Layout {
            shell: Some("/bin/bash".to_owned()),
            macos: true,
            ..f.layout.clone()
        };
        assert!(
            unix::startup_line(&bash, &folder).is_none(),
            "macOS bash has no safe file"
        );
        let unsafe_folder = bash.home.join("my bin");
        let zsh = Layout {
            shell: Some("/bin/zsh".to_owned()),
            ..bash
        };
        assert!(unix::startup_line(&zsh, &unsafe_folder).is_none());
    }
}
