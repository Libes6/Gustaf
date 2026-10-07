//! Which addresses the server may listen on and accept connections from: private LAN ranges only.

use std::net::{IpAddr, Ipv4Addr, UdpSocket};

/// RFC 1918 (10/8, 172.16/12, 192.168/16). Link-local (169.254/16), CGNAT (100.64/10), loopback and everything public
/// are NOT private LAN addresses for this server.
pub fn is_private_lan(ip: Ipv4Addr) -> bool {
    ip.is_private()
}

/// Why `bind` is refused, as a message for the settings page.
pub fn validate_bind(ip: IpAddr, allow_loopback: bool) -> Result<Ipv4Addr, String> {
    let v4 = match ip {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4,
            None => return Err(format!("{ip} is an IPv6 address; the mobile server listens on private IPv4 LAN addresses only")),
        },
    };
    if v4.is_unspecified() {
        return Err("refusing to listen on 0.0.0.0 (every interface); the server binds one private LAN address".to_string());
    }
    if is_private_lan(v4) || (allow_loopback && v4.is_loopback()) {
        Ok(v4)
    } else {
        Err(format!("{v4} is not a private LAN address (10.x.x.x, 172.16-31.x.x or 192.168.x.x); refusing to listen on it"))
    }
}

/// Connections from anywhere else are dropped before the TLS handshake (defence in depth: the socket is bound to a
/// private address, but a port forward or a bridged VM could still deliver outside traffic).
pub fn peer_allowed(ip: IpAddr, allow_loopback: bool) -> bool {
    let v4 = match ip {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4,
            None => return false,
        },
    };
    is_private_lan(v4) || (allow_loopback && v4.is_loopback())
}

/// The private IPv4 address of the interface the machine would use to reach the LAN. A UDP `connect` only selects the
/// route (no packet is sent), so this needs no interface-enumeration dependency and works on every desktop platform.
/// Targets in the private ranges are tried first so that a VPN default route does not hide the LAN interface.
pub fn detect_lan_ip() -> Option<Ipv4Addr> {
    for target in [
        "192.168.255.254:9",
        "10.255.255.254:9",
        "172.31.255.254:9",
        "8.8.8.8:80",
    ] {
        let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else {
            continue;
        };
        if socket.connect(target).is_err() {
            continue;
        }
        if let Ok(addr) = socket.local_addr() {
            if let IpAddr::V4(v4) = addr.ip() {
                if is_private_lan(v4) {
                    return Some(v4);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(a, b, c, d))
    }

    #[test]
    fn private_ranges_are_accepted() {
        for ip in [
            v4(10, 0, 0, 5),
            v4(10, 255, 255, 255),
            v4(172, 16, 0, 1),
            v4(172, 31, 255, 254),
            v4(192, 168, 1, 20),
        ] {
            assert!(validate_bind(ip, false).is_ok(), "{ip}");
            assert!(peer_allowed(ip, false), "{ip}");
        }
    }

    #[test]
    fn public_wildcard_and_odd_ranges_are_refused() {
        for ip in [
            v4(0, 0, 0, 0),
            v4(8, 8, 8, 8),
            v4(172, 15, 0, 1),
            v4(172, 32, 0, 1),
            v4(100, 64, 0, 1),
            v4(169, 254, 1, 1),
            v4(192, 169, 0, 1),
            v4(127, 0, 0, 1),
            v4(255, 255, 255, 255),
            IpAddr::V6("::".parse().unwrap()),
            IpAddr::V6("::1".parse().unwrap()),
            IpAddr::V6("2001:db8::1".parse().unwrap()),
        ] {
            assert!(validate_bind(ip, false).is_err(), "{ip} must be refused");
            assert!(!peer_allowed(ip, false), "{ip} must not be a peer");
        }
        assert!(
            validate_bind(v4(0, 0, 0, 0), true).is_err(),
            "0.0.0.0 is refused even where loopback is allowed"
        );
        assert!(validate_bind(v4(8, 8, 8, 8), true).is_err());
    }

    #[test]
    fn loopback_is_only_for_tests() {
        assert!(validate_bind(v4(127, 0, 0, 1), true).is_ok());
        assert!(peer_allowed(v4(127, 0, 0, 1), true));
    }

    #[test]
    fn mapped_ipv4_is_judged_by_its_ipv4_address() {
        assert!(validate_bind(IpAddr::V6("::ffff:192.168.1.5".parse().unwrap()), false).is_ok());
        assert!(validate_bind(IpAddr::V6("::ffff:8.8.8.8".parse().unwrap()), false).is_err());
        assert!(!peer_allowed(
            IpAddr::V6("::ffff:8.8.8.8".parse().unwrap()),
            false
        ));
    }

    #[test]
    fn detection_never_returns_a_public_address() {
        if let Some(ip) = detect_lan_ip() {
            assert!(is_private_lan(ip));
        }
    }
}
