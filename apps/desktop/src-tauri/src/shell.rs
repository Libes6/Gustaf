//! Shell selection per OS and quoting helpers (pure, unit-tested).
//! macOS: zsh (login shell). Linux: bash if present, else sh. Windows: Windows PowerShell 5.1.
//! The TypeScript twin is `src/providers/shell.ts`.

// `PowerShell` is the real product name; renaming the variant would only to satisfy the lint.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    Zsh,
    Bash,
    Sh,
    PowerShell,
}

impl Shell {
    /// `os` is `std::env::consts::OS`; `bash_exists` only matters on Linux and other Unix systems.
    pub fn pick(os: &str, bash_exists: bool) -> Shell {
        match os {
            "macos" => Shell::Zsh,
            "windows" => Shell::PowerShell,
            _ if bash_exists => Shell::Bash,
            _ => Shell::Sh,
        }
    }

    pub fn current() -> Shell {
        Shell::pick(
            std::env::consts::OS,
            std::path::Path::new("/bin/bash").exists(),
        )
    }

    pub fn program(self) -> &'static str {
        match self {
            Shell::Zsh => "/bin/zsh",
            Shell::Bash => "/bin/bash",
            Shell::Sh => "/bin/sh",
            Shell::PowerShell => "powershell.exe",
        }
    }

    /// Arguments before the script text.
    pub fn flags(self) -> &'static [&'static str] {
        match self {
            Shell::Zsh | Shell::Bash => &["-lc"],
            Shell::Sh => &["-c"],
            Shell::PowerShell => &["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
        }
    }

    /// POSIX shells get stderr merged into stdout with `2>&1`; PowerShell turns redirected native stderr into error
    /// records, so there the caller reads both pipes instead.
    pub fn merges_stderr_itself(self) -> bool {
        !matches!(self, Shell::PowerShell)
    }

    /// The script text for a user command: UTF-8 output on PowerShell, `2>&1` on POSIX shells.
    pub fn script(self, command: &str) -> String {
        match self {
            Shell::PowerShell => format!(
                "$OutputEncoding = [Text.UTF8Encoding]::new($false); try {{ [Console]::OutputEncoding = $OutputEncoding }} catch {{}}; {command}"
            ),
            _ => format!("{command} 2>&1"),
        }
    }
}

/// POSIX single-quote quoting: `it's` becomes `'it'\''s'`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// PowerShell single-quoted literal (single quotes, also the typographic ones PowerShell accepts, are doubled).
#[cfg_attr(not(test), allow(dead_code))]
pub fn ps_quote(s: &str) -> String {
    let mut out = String::from("'");
    for c in s.chars() {
        out.push(c);
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}') {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_shell_per_os() {
        assert_eq!(Shell::pick("macos", true), Shell::Zsh);
        assert_eq!(Shell::pick("linux", true), Shell::Bash);
        assert_eq!(Shell::pick("linux", false), Shell::Sh);
        assert_eq!(Shell::pick("windows", false), Shell::PowerShell);
        assert_eq!(Shell::pick("freebsd", true), Shell::Bash);
    }

    #[test]
    fn flags_and_scripts() {
        assert_eq!(Shell::Zsh.flags(), &["-lc"]);
        assert_eq!(Shell::Sh.flags(), &["-c"]);
        assert_eq!(Shell::Bash.script("echo hi"), "echo hi 2>&1");
        let ps = Shell::PowerShell.script("Get-Date");
        assert!(ps.ends_with("; Get-Date") && ps.contains("OutputEncoding"));
        assert!(!Shell::PowerShell.merges_stderr_itself());
    }

    #[test]
    fn posix_quoting() {
        assert_eq!(sh_quote("abc"), "'abc'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("$(x) `y` \"z\" ; & |"), "'$(x) `y` \"z\" ; & |'");
    }

    #[test]
    fn powershell_quoting() {
        assert_eq!(ps_quote("it's"), "'it''s'");
        assert_eq!(ps_quote("a\u{2019}b"), "'a\u{2019}\u{2019}b'");
        assert_eq!(ps_quote("$env:X `n \"q\""), "'$env:X `n \"q\"'");
    }

    #[cfg(unix)]
    #[test]
    fn quoted_text_survives_a_real_posix_shell() {
        let tricky = "a 'b' \"c\" $HOME `id` ; echo injected\nline2";
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("printf %s {}", sh_quote(tricky))])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), tricky);
    }
}
