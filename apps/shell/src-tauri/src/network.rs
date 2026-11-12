//! LAN and Tailscale addresses the phone / other clients can use.

use std::io::Read;
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const HELPER_TIMEOUT: Duration = Duration::from_secs(3);
const SNAPSHOT_TTL: Duration = Duration::from_secs(5);

/// Addresses gathered from `ifconfig`/`ip`/`ipconfig` and `tailscale status`.
#[derive(Clone, Debug, Default)]
pub(crate) struct NetworkSnapshot {
    /// LAN addresses, private (RFC 1918) ones first.
    pub lan: Vec<String>,
    pub tailscale_ips: Vec<String>,
    pub magic_dns_name: Option<String>,
}

/// Cached for a few seconds: the helpers are slow and settings polls them often.
pub(crate) fn network_snapshot() -> NetworkSnapshot {
    static CACHE: Mutex<Option<(Instant, NetworkSnapshot)>> = Mutex::new(None);
    let mut guard = CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((taken_at, snapshot)) = guard.as_ref() {
        if taken_at.elapsed() < SNAPSHOT_TTL {
            return snapshot.clone();
        }
    }
    let snapshot = gather_snapshot();
    *guard = Some((Instant::now(), snapshot.clone()));
    snapshot
}

fn gather_snapshot() -> NetworkSnapshot {
    let interfaces = local_ipv4_interfaces().unwrap_or_default();
    let status = run_tailscale_status_json();
    let mut tailscale_ips = status
        .as_ref()
        .map(tailscale_status_ipv4)
        .unwrap_or_default();
    if tailscale_ips.is_empty() {
        tailscale_ips = interfaces
            .iter()
            .map(|(_, address)| *address)
            .filter(|address| is_tailscale_cgnat(*address))
            .map(|address| address.to_string())
            .collect();
    }
    tailscale_ips.sort();
    tailscale_ips.dedup();
    NetworkSnapshot {
        lan: lan_ipv4_addresses(&interfaces),
        tailscale_ips,
        magic_dns_name: status.as_ref().and_then(magic_dns_name),
    }
}

/// IPv4 addresses on this machine that are usable from the LAN (not loopback,
/// link-local, or Tailscale CGNAT — those are listed separately).
fn lan_ipv4_addresses(interfaces: &[(String, Ipv4Addr)]) -> Vec<String> {
    let mut addresses: Vec<Ipv4Addr> = Vec::new();
    for (name, address) in interfaces {
        let address = *address;
        if is_host_only_interface(name)
            || address.is_loopback()
            || address.is_link_local()
            || is_tailscale_cgnat(address)
            || addresses.contains(&address)
        {
            continue;
        }
        addresses.push(address);
    }
    addresses.sort_by_key(|address| !address.is_private());
    addresses.iter().map(Ipv4Addr::to_string).collect()
}

fn magic_dns_name(status: &Value) -> Option<String> {
    let dns = status
        .pointer("/Self/DNSName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(dns.trim_end_matches('.').to_owned())
}

fn tailscale_status_ipv4(status: &Value) -> Vec<String> {
    let Some(ips) = status
        .pointer("/Self/TailscaleIPs")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    ips.iter()
        .filter_map(Value::as_str)
        .filter_map(|ip| ip.parse::<Ipv4Addr>().ok())
        .filter(|ip| is_tailscale_cgnat(*ip))
        .map(|ip| ip.to_string())
        .collect()
}

fn run_tailscale_status_json() -> Option<Value> {
    let mut command = Command::new(tailscale_binary()?);
    command.args(["status", "--json"]);
    let (status, stdout) = run_helper(command).ok()?;
    if !status.success() {
        return None;
    }
    serde_json::from_slice(&stdout).ok()
}

/// A Dock launch on macOS has a minimal PATH, so also try the app bundle CLI.
fn tailscale_binary() -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        "tailscale.exe"
    } else {
        "tailscale"
    };
    let on_path = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(exe))
            .find(|candidate| candidate.is_file())
    });
    on_path.or_else(|| {
        let app = PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
        (cfg!(target_os = "macos") && app.is_file()).then_some(app)
    })
}

/// Runs a helper without a console window and kills it after `HELPER_TIMEOUT`.
fn run_helper(mut command: Command) -> Result<(ExitStatus, Vec<u8>), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let program = command.get_program().to_string_lossy().into_owned();
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("{program}: {error}"))?;
    let mut stdout = child.stdout.take().ok_or("helper has no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout.read_to_end(&mut buffer);
        buffer
    });
    let deadline = Instant::now() + HELPER_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{program}: timed out"));
            }
            Err(error) => return Err(format!("{program}: {error}")),
        }
    };
    Ok((status, reader.join().unwrap_or_default()))
}

fn local_ipv4_interfaces() -> Result<Vec<(String, Ipv4Addr)>, String> {
    // Prefer a portable approach without extra crates: `ifconfig` / `ip`.
    if cfg!(target_os = "macos") || cfg!(target_os = "freebsd") {
        let (_, stdout) = run_helper(Command::new("ifconfig"))?;
        return Ok(parse_ifconfig_ipv4(&String::from_utf8_lossy(&stdout)));
    }
    if cfg!(target_os = "linux") {
        let mut command = Command::new("ip");
        command.args(["-4", "-o", "addr", "show"]);
        let (_, stdout) = run_helper(command)?;
        return Ok(parse_ip_addr_ipv4(&String::from_utf8_lossy(&stdout)));
    }
    if cfg!(windows) {
        // Output is in the OEM code page; only the ASCII parts matter here.
        let (_, stdout) = run_helper(Command::new("ipconfig"))?;
        return Ok(parse_windows_ipconfig(&String::from_utf8_lossy(&stdout)));
    }
    Ok(Vec::new())
}

fn parse_ifconfig_ipv4(text: &str) -> Vec<(String, Ipv4Addr)> {
    let mut current = String::new();
    let mut result = Vec::new();
    for line in text.lines() {
        if !line.starts_with('\t') && !line.starts_with(' ') {
            if let Some(name) = line.split(':').next() {
                current = name.trim().to_owned();
            }
            continue;
        }
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("inet ") {
            let addr = rest.split_whitespace().next().unwrap_or("");
            if let Ok(ip) = addr.parse::<Ipv4Addr>() {
                result.push((current.clone(), ip));
            }
        }
    }
    result
}

fn parse_ip_addr_ipv4(text: &str) -> Vec<(String, Ipv4Addr)> {
    let mut result = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let _ = parts.next();
        let Some(name) = parts.next() else { continue };
        // … inet 192.168.1.2/24 …
        while let Some(token) = parts.next() {
            if token == "inet" {
                if let Some(cidr) = parts.next() {
                    let addr = cidr.split('/').next().unwrap_or("");
                    if let Ok(ip) = addr.parse::<Ipv4Addr>() {
                        result.push((name.to_owned(), ip));
                    }
                }
                break;
            }
        }
    }
    result
}

/// Language independent: the label is localized (`IPv4 Address`, `IPv4-адрес`,
/// `IPv4-Adresse`), but always contains `IPv4` and ends with `:`.
fn parse_windows_ipconfig(text: &str) -> Vec<(String, Ipv4Addr)> {
    let mut current = String::from("adapter");
    let mut result = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if !line.starts_with(' ') && line.contains(':') {
            current = line.trim().trim_end_matches(':').trim().to_owned();
            continue;
        }
        let Some((label, value)) = line.rsplit_once(':') else {
            continue;
        };
        if !label.contains("IPv4") {
            continue;
        }
        let addr = value
            .trim()
            .split(|c: char| !c.is_ascii_digit() && c != '.')
            .next()
            .unwrap_or("");
        if let Ok(ip) = addr.parse::<Ipv4Addr>() {
            result.push((current.clone(), ip));
        }
    }
    result
}

fn is_tailscale_cgnat(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

/// Matches whole words by prefix (`vEthernet (WSL)`, `bridge100`, `br-1a2b`) so
/// a localized adapter name that merely contains `tap`/`tun`/`wg` is kept.
fn is_host_only_interface(name: &str) -> bool {
    const PREFIXES: [&str; 15] = [
        "bridge",
        "utun",
        "ipsec",
        "ppp",
        "tun",
        "tap",
        "wg",
        "docker",
        "br-",
        "veth",
        "virbr",
        "vmnet",
        "vboxnet",
        "vethernet",
        "hyper-v",
    ];
    name.to_lowercase()
        .split(|c: char| c.is_whitespace() || matches!(c, '(' | ')' | ':' | ','))
        .any(|word| PREFIXES.iter().any(|prefix| word.starts_with(prefix)))
}

pub(crate) fn advertised_endpoints_json(
    http_base_url: &str,
    mode: &str,
    tailscale_serve_enabled: bool,
    tailscale_serve_port: u16,
    network: &NetworkSnapshot,
) -> Value {
    let port = url_port(http_base_url).unwrap_or(3773);
    let mut endpoints = vec![endpoint(
        &format!("desktop-loopback:http://127.0.0.1:{port}"),
        "This machine",
        &format!("http://127.0.0.1:{port}"),
        "loopback",
        "desktop-core",
        false,
        "Loopback endpoint for this desktop app.",
    )];

    if mode == "network-accessible" {
        for (index, lan) in network.lan.iter().enumerate() {
            endpoints.push(endpoint(
                &format!("desktop-lan:http://{lan}:{port}"),
                "Local network",
                &format!("http://{lan}:{port}"),
                "lan",
                "desktop-core",
                index == 0,
                "Reachable from devices on the same network.",
            ));
        }
        for ts in &network.tailscale_ips {
            endpoints.push(endpoint(
                &format!("tailscale-ip:http://{ts}:{port}"),
                "Tailscale IP",
                &format!("http://{ts}:{port}"),
                "private-network",
                "desktop-addon",
                false,
                "Reachable from devices on the same Tailnet.",
            ));
        }
    }

    // Serve proxies to loopback, so it is published in both exposure modes.
    if tailscale_serve_enabled {
        if let Some(dns) = &network.magic_dns_name {
            let https = if tailscale_serve_port == 443 {
                format!("https://{dns}")
            } else {
                format!("https://{dns}:{tailscale_serve_port}")
            };
            endpoints.push(endpoint(
                &format!("tailscale-serve:{https}"),
                "Tailscale Serve",
                &https,
                "private-network",
                "desktop-addon",
                false,
                "HTTPS endpoint via Tailscale Serve.",
            ));
        }
    }

    Value::Array(endpoints)
}

fn url_port(http_base_url: &str) -> Option<u16> {
    let without_scheme = http_base_url
        .strip_prefix("http://")
        .or_else(|| http_base_url.strip_prefix("https://"))?;
    let host_port = without_scheme.split('/').next()?;
    let port = host_port.rsplit_once(':').map(|(_, port)| port)?;
    port.parse().ok()
}

fn endpoint(
    id: &str,
    label: &str,
    http_base_url: &str,
    reachability: &str,
    source: &str,
    is_default: bool,
    description: &str,
) -> Value {
    let ws = http_base_url
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    let provider = if source == "desktop-addon" {
        json!({
            "id": "tailscale",
            "label": "Tailscale",
            "kind": "private-network",
            "isAddon": true,
        })
    } else {
        json!({
            "id": "desktop-core",
            "label": "Desktop",
            "kind": "core",
            "isAddon": false,
        })
    };
    let hosted = if http_base_url.starts_with("https://") {
        "compatible"
    } else {
        "mixed-content-blocked"
    };
    json!({
        "id": id,
        "label": label,
        "provider": provider,
        "httpBaseUrl": ensure_trailing_slash(http_base_url),
        "wsBaseUrl": ensure_trailing_slash(&ws),
        "reachability": reachability,
        "compatibility": {
            "hostedHttpsApp": hosted,
            "desktopApp": "compatible",
        },
        "source": if source == "desktop-addon" { "desktop-addon" } else { "desktop-core" },
        "status": "available",
        "isDefault": is_default,
        "description": description,
    })
}

fn ensure_trailing_slash(url: &str) -> String {
    if url.ends_with('/') {
        url.to_owned()
    } else {
        format!("{url}/")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        advertised_endpoints_json, ensure_trailing_slash, is_host_only_interface,
        is_tailscale_cgnat, lan_ipv4_addresses, parse_windows_ipconfig, NetworkSnapshot,
    };
    use std::net::Ipv4Addr;

    fn ip(text: &str) -> Ipv4Addr {
        text.parse().unwrap()
    }

    #[test]
    fn recognizes_tailscale_cgnat() {
        assert!(is_tailscale_cgnat(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(!is_tailscale_cgnat(Ipv4Addr::new(192, 168, 1, 1)));
    }

    #[test]
    fn local_only_endpoints_include_loopback() {
        let endpoints = advertised_endpoints_json(
            "http://127.0.0.1:3773/",
            "local-only",
            false,
            443,
            &NetworkSnapshot::default(),
        );
        let list = endpoints.as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["reachability"], "loopback");
    }

    #[test]
    fn serve_endpoint_is_listed_in_local_only_mode() {
        let network = NetworkSnapshot {
            lan: vec!["192.168.1.5".into()],
            tailscale_ips: vec!["100.64.0.1".into()],
            magic_dns_name: Some("box.tail1234.ts.net".into()),
        };
        let endpoints =
            advertised_endpoints_json("http://127.0.0.1:3773/", "local-only", true, 443, &network);
        let urls: Vec<&str> = endpoints
            .as_array()
            .unwrap()
            .iter()
            .map(|endpoint| endpoint["httpBaseUrl"].as_str().unwrap())
            .collect();
        assert_eq!(
            urls,
            ["http://127.0.0.1:3773/", "https://box.tail1234.ts.net/"]
        );
    }

    #[test]
    fn network_mode_lists_every_lan_address_with_first_default() {
        let network = NetworkSnapshot {
            lan: vec!["192.168.1.5".into(), "10.0.0.7".into()],
            ..NetworkSnapshot::default()
        };
        let endpoints = advertised_endpoints_json(
            "http://127.0.0.1:3773/",
            "network-accessible",
            false,
            443,
            &network,
        );
        let lan: Vec<(&str, bool)> = endpoints
            .as_array()
            .unwrap()
            .iter()
            .filter(|endpoint| endpoint["reachability"] == "lan")
            .map(|endpoint| {
                (
                    endpoint["httpBaseUrl"].as_str().unwrap(),
                    endpoint["isDefault"].as_bool().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            lan,
            [
                ("http://192.168.1.5:3773/", true),
                ("http://10.0.0.7:3773/", false)
            ]
        );
    }

    #[test]
    fn parses_localized_ipconfig() {
        let english = "\
Windows IP Configuration

Ethernet adapter Ethernet:

   Connection-specific DNS Suffix  . : lan
   Link-local IPv6 Address . . . . . : fe80::1c2d:3e4f:5a6b:7c8d%12
   IPv4 Address. . . . . . . . . . . : 192.168.1.23
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 192.168.1.1
";
        let russian = "\
Настройка протокола IP для Windows

Адаптер беспроводной локальной сети Беспроводная сеть:

   DNS-суффикс подключения . . . . . : lan
   Локальный IPv6-адрес канала . . . : fe80::1c2d:3e4f:5a6b:7c8d%7
   IPv4-адрес. . . . . . . . . . . . : 192.168.0.42(Основной)
   Маска подсети . . . . . . . . . . : 255.255.255.0
   Основной шлюз. . . . . . . . . : 192.168.0.1
";
        let german = "\
Windows-IP-Konfiguration

Drahtlos-LAN-Adapter WLAN:

   Verbindungsspezifisches DNS-Suffix: fritz.box
   IPv4-Adresse  . . . . . . . . . . : 10.0.0.15
   Subnetzmaske  . . . . . . . . . . : 255.255.255.0
   Standardgateway . . . . . . . . . : 10.0.0.1
";
        assert_eq!(
            parse_windows_ipconfig(english),
            [("Ethernet adapter Ethernet".to_owned(), ip("192.168.1.23"))]
        );
        assert_eq!(
            parse_windows_ipconfig(russian),
            [(
                "Адаптер беспроводной локальной сети Беспроводная сеть".to_owned(),
                ip("192.168.0.42")
            )]
        );
        assert_eq!(
            parse_windows_ipconfig(german),
            [("Drahtlos-LAN-Adapter WLAN".to_owned(), ip("10.0.0.15"))]
        );
    }

    #[test]
    fn host_only_filter_matches_words_not_substrings() {
        for name in [
            "bridge100",
            "utun3",
            "docker0",
            "br-1a2b3c",
            "Ethernet adapter vEthernet (WSL)",
            "Hyper-V Virtual Ethernet Adapter",
        ] {
            assert!(is_host_only_interface(name), "{name}");
        }
        for name in [
            "en0",
            "wlan0",
            "Ethernet adapter Ethernet",
            "Ethernet adapter Wartungsnetz",
        ] {
            assert!(!is_host_only_interface(name), "{name}");
        }
    }

    #[test]
    fn lan_addresses_put_private_first_and_skip_virtual() {
        let interfaces = vec![
            ("en5".to_owned(), ip("203.0.113.9")),
            ("lo0".to_owned(), ip("127.0.0.1")),
            ("en0".to_owned(), ip("192.168.1.5")),
            ("bridge100".to_owned(), ip("192.168.64.1")),
            ("utun4".to_owned(), ip("100.101.1.2")),
            ("en1".to_owned(), ip("10.0.0.7")),
            ("en2".to_owned(), ip("169.254.3.4")),
        ];
        assert_eq!(
            lan_ipv4_addresses(&interfaces),
            ["192.168.1.5", "10.0.0.7", "203.0.113.9"]
        );
    }

    #[test]
    fn trailing_slash_helper() {
        assert_eq!(ensure_trailing_slash("http://a"), "http://a/");
        assert_eq!(ensure_trailing_slash("http://a/"), "http://a/");
    }
}
