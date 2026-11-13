//! WSL output and command construction, independent of the host platform.

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Distro {
    pub name: String,
    pub is_default: bool,
    pub version: u8,
}

pub(crate) fn parse_distros(bytes: &[u8]) -> Vec<Distro> {
    let utf16 = bytes.starts_with(&[0xff, 0xfe])
        || bytes
            .iter()
            .skip(1)
            .step_by(2)
            .take(40)
            .filter(|b| **b == 0)
            .count()
            > 10;
    let text = if utf16 {
        String::from_utf16_lossy(
            &bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u16::from_le_bytes(*b))
                .collect::<Vec<_>>(),
        )
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.trim_start_matches('\u{feff}')
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let is_default = line.starts_with('*');
            let line = line.trim_start_matches('*').trim();
            let (rest, version) = line.rsplit_once(char::is_whitespace)?;
            let version = match version {
                "1" => 1,
                "2" => 2,
                _ => return None,
            };
            let rest = rest.trim_end();
            let boundary = rest.find("  ")?;
            let name = rest[..boundary].trim();
            if name.is_empty() || name.chars().any(char::is_control) {
                return None;
            }
            Some(Distro {
                name: name.into(),
                is_default,
                version,
            })
        })
        .collect()
}

pub(crate) fn backend_id(distro: Option<&str>) -> String {
    format!("wsl:{}", distro.unwrap_or("default"))
}

pub(crate) fn distro_args(distro: Option<&str>) -> Vec<String> {
    distro
        .map(|name| vec!["--distribution".into(), name.into()])
        .unwrap_or_default()
}

pub(crate) fn unc_path(path: &str) -> Option<(String, String)> {
    let normalized = path.replace('\\', "/");
    let mut parts = normalized.strip_prefix("//")?.splitn(3, '/');
    let host = parts.next()?;
    if !host.eq_ignore_ascii_case("wsl.localhost") && !host.eq_ignore_ascii_case("wsl$") {
        return None;
    }
    let distro = parts.next()?;
    if distro.is_empty() {
        return None;
    }
    Some((
        distro.into(),
        format!("/{}", parts.next().unwrap_or_default()),
    ))
}

pub(crate) fn uses_wsl_path(
    enabled: bool,
    only: bool,
    distro: Option<&str>,
    target: Option<&str>,
) -> bool {
    enabled
        && (only && target.is_none_or(|id| id == "primary")
            || target == Some(backend_id(distro).as_str()))
}

pub(crate) fn server_script(
    app_version: &str,
    port: u16,
    network_accessible: bool,
    tailscale_port: Option<u16>,
) -> String {
    let mut exposure = if network_accessible {
        "--host 0.0.0.0 --lan".to_owned()
    } else {
        "--host 127.0.0.1".to_owned()
    };
    if let Some(port) = tailscale_port {
        exposure.push_str(&format!(" --tailscale-serve --tailscale-serve-port {port}"));
    }
    let app_version: String = app_version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        .collect();
    // One parsed line leaves stdin to the watchdog; EOF also cleans up after a host crash.
    format!(
        r#"set -eu; cli="$HOME/.gustaf/runtime/t3"; test -x "$cli" || {{ echo 'Install the Linux Gustaf runtime at ~/.gustaf/runtime (including t3 and its dependencies) in this WSL distro'; exit 127; }}; command -v setsid >/dev/null; GUSTAF_APP_VERSION='{app_version}' setsid "$cli" --mode web --no-browser --no-auto-bootstrap-project-from-cwd {exposure} --port {port} --base-dir "$HOME/.gustaf" & server=$!; (IFS= read -r _ || true; kill -TERM -- -"$server" 2>/dev/null || true; sleep 2; kill -KILL -- -"$server" 2>/dev/null || true) <&0 >/dev/null 2>&1 & guard=$!; trap 'kill -KILL -- -"$server" 2>/dev/null || true; kill "$guard" 2>/dev/null || true' EXIT HUP INT TERM; wait "$server"
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_distro_names_in_one_argument_and_converts_unc_paths() {
        assert_eq!(
            distro_args(Some("Ubuntu Dev")),
            ["--distribution", "Ubuntu Dev"]
        );
        assert!(distro_args(None).is_empty());
        assert_eq!(backend_id(None), "wsl:default");
        assert_eq!(backend_id(Some("Ubuntu Dev")), "wsl:Ubuntu Dev");
        assert_eq!(
            unc_path(r"\\wsl.localhost\Ubuntu Dev\home\max\code"),
            Some(("Ubuntu Dev".into(), "/home/max/code".into()))
        );
        assert_eq!(
            unc_path(r"\\WSL$\Debian"),
            Some(("Debian".into(), "/".into()))
        );
        assert_eq!(unc_path(r"C:\Users\Max"), None);
        assert_eq!(unc_path(r"\\server\share"), None);
        let script = server_script("0.12.0'; rm -rf ~", 43321, false, None);
        assert!(script.contains("GUSTAF_APP_VERSION='0.12.0rm-rf' setsid"));
        assert!(script.contains("--port 43321"));
        assert!(script.contains("--base-dir \"$HOME/.gustaf\""));
        assert!(script.contains("kill -KILL"));
        assert_eq!(script.lines().count(), 1);
        assert!(script.contains("--host 127.0.0.1"));
        let exposed = server_script("0.12.0", 43321, true, Some(443));
        assert!(
            exposed.contains("--host 0.0.0.0 --lan --tailscale-serve --tailscale-serve-port 443")
        );
        assert!(!uses_wsl_path(true, false, None, Some("primary")));
        assert!(uses_wsl_path(true, false, None, Some("wsl:default")));
        assert!(uses_wsl_path(true, true, None, Some("wsl:default")));
        assert!(uses_wsl_path(
            true,
            true,
            Some("Ubuntu Dev"),
            Some("primary")
        ));
        assert!(!uses_wsl_path(false, true, None, Some("wsl:default")));
        assert!(!uses_wsl_path(true, true, None, Some("ssh:remote")));
    }

    #[test]
    fn parses_windows_utf16_and_localized_states_without_splitting_distro_names() {
        let fixture = "\u{feff}  NAME                   STATE           VERSION\r\n* Ubuntu Dev             Выполняется     2\r\n  Debian                 Stopped         1\r\n  invalid                Stopped         3\r\n";
        let bytes: Vec<_> = fixture.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(
            parse_distros(&bytes),
            vec![
                Distro {
                    name: "Ubuntu Dev".into(),
                    is_default: true,
                    version: 2
                },
                Distro {
                    name: "Debian".into(),
                    is_default: false,
                    version: 1
                },
            ]
        );
        assert_eq!(parse_distros(fixture.as_bytes()).len(), 2);
        assert!(parse_distros(b"WSL is not installed").is_empty());
    }
}
