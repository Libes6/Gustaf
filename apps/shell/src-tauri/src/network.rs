//! LAN and Tailscale addresses the phone / other clients can use.

use std::net::Ipv4Addr;
use std::process::Command;

use serde_json::{json, Value};

/// IPv4 addresses on this machine that are usable from the LAN (not loopback,
/// link-local, or Tailscale CGNAT — those are listed separately).
pub(crate) fn lan_ipv4_addresses() -> Vec<String> {
    let Ok(interfaces) = local_ipv4_interfaces() else {
        return Vec::new();
    };
    let mut addresses = Vec::new();
    for (name, address) in interfaces {
        if is_host_only_interface(&name) {
            continue;
        }
        if address.is_loopback() || is_link_local(address) || is_tailscale_cgnat(address) {
            continue;
        }
        let text = address.to_string();
        if !addresses.contains(&text) {
            addresses.push(text);
        }
    }
    addresses
}

pub(crate) fn tailscale_ipv4_addresses() -> Vec<String> {
    let mut from_cli = tailscale_status_ipv4();
    if !from_cli.is_empty() {
        from_cli.sort();
        from_cli.dedup();
        return from_cli;
    }

    let Ok(interfaces) = local_ipv4_interfaces() else {
        return Vec::new();
    };
    let mut addresses = Vec::new();
    for (name, address) in interfaces {
        if !is_tailscale_cgnat(address) {
            continue;
        }
        let _ = name;
        let text = address.to_string();
        if !addresses.contains(&text) {
            addresses.push(text);
        }
    }
    addresses
}

pub(crate) fn tailscale_magic_dns_name() -> Option<String> {
    let status = run_tailscale_status_json()?;
    let dns = status
        .pointer("/Self/DNSName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(dns.trim_end_matches('.').to_owned())
}

fn run_tailscale_status_json() -> Option<Value> {
    let output = Command::new("tailscale")
        .args(["status", "--json"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

fn tailscale_status_ipv4() -> Vec<String> {
    let Some(status) = run_tailscale_status_json() else {
        return Vec::new();
    };
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

fn local_ipv4_interfaces() -> Result<Vec<(String, Ipv4Addr)>, String> {
    // Prefer a portable approach without extra crates: `ifconfig` / `ip`.
    if cfg!(target_os = "macos") || cfg!(target_os = "freebsd") {
        return parse_ifconfig_ipv4();
    }
    if cfg!(target_os = "linux") {
        return parse_ip_route_ipv4();
    }
    if cfg!(windows) {
        return parse_windows_ipconfig();
    }
    Ok(Vec::new())
}

fn parse_ifconfig_ipv4() -> Result<Vec<(String, Ipv4Addr)>, String> {
    let output = Command::new("ifconfig")
        .output()
        .map_err(|error| format!("ifconfig: {error}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
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
    Ok(result)
}

fn parse_ip_route_ipv4() -> Result<Vec<(String, Ipv4Addr)>, String> {
    let output = Command::new("ip")
        .args(["-4", "-o", "addr", "show"])
        .output()
        .map_err(|error| format!("ip: {error}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
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
    Ok(result)
}

fn parse_windows_ipconfig() -> Result<Vec<(String, Ipv4Addr)>, String> {
    let output = Command::new("ipconfig")
        .output()
        .map_err(|error| format!("ipconfig: {error}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut current = String::from("adapter");
    let mut result = Vec::new();
    for line in text.lines() {
        if !line.starts_with(' ') && line.contains(':') {
            current = line.trim_end_matches(':').trim().to_owned();
            continue;
        }
        let trimmed = line.trim();
        if let Some(rest) = trimmed
            .strip_prefix("IPv4 Address")
            .or_else(|| trimmed.strip_prefix("IP Address"))
        {
            let addr = rest
                .rsplit(':')
                .next()
                .unwrap_or("")
                .trim()
                .trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
            if let Ok(ip) = addr.parse::<Ipv4Addr>() {
                result.push((current.clone(), ip));
            }
        }
    }
    Ok(result)
}

fn is_link_local(address: Ipv4Addr) -> bool {
    address.octets()[0] == 169 && address.octets()[1] == 254
}

fn is_tailscale_cgnat(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

fn is_host_only_interface(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
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
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix) || lower.contains(prefix))
}

pub(crate) fn advertised_endpoints_json(
    http_base_url: &str,
    mode: &str,
    tailscale_serve_enabled: bool,
    tailscale_serve_port: u16,
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
        if let Some(lan) = lan_ipv4_addresses().into_iter().next() {
            endpoints.push(endpoint(
                &format!("desktop-lan:http://{lan}:{port}"),
                "Local network",
                &format!("http://{lan}:{port}"),
                "lan",
                "desktop-core",
                true,
                "Reachable from devices on the same network.",
            ));
        }
        for ts in tailscale_ipv4_addresses() {
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
        if tailscale_serve_enabled {
            if let Some(dns) = tailscale_magic_dns_name() {
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

/// Best-effort probe so we do not hang the settings page on a missing binary.
#[allow(dead_code)]
pub(crate) fn tailscale_available() -> bool {
    Command::new("tailscale")
        .arg("version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{advertised_endpoints_json, ensure_trailing_slash, is_tailscale_cgnat};
    use std::net::Ipv4Addr;

    #[test]
    fn recognizes_tailscale_cgnat() {
        assert!(is_tailscale_cgnat(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(!is_tailscale_cgnat(Ipv4Addr::new(192, 168, 1, 1)));
    }

    #[test]
    fn local_only_endpoints_include_loopback() {
        let endpoints =
            advertised_endpoints_json("http://127.0.0.1:3773/", "local-only", false, 443);
        let list = endpoints.as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["reachability"], "loopback");
    }

    #[test]
    fn trailing_slash_helper() {
        assert_eq!(ensure_trailing_slash("http://a"), "http://a/");
        assert_eq!(ensure_trailing_slash("http://a/"), "http://a/");
    }
}
