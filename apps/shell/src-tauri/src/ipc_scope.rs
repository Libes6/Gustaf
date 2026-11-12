//! Commands of the shell may be called only by the page of the server the shell started.
//!
//! The server's port is not known until it runs, so the grant is added at startup for that
//! exact origin. A static grant for every loopback port would also give the shell's commands
//! (including the one that returns the server's bearer token) to any other local web page the
//! window opens, such as an app an agent is running.

use serde_json::json;

/// The commands and plugin permissions the page needs; one list for the whole app.
const PERMISSIONS_FILE: &str = include_str!("../capabilities/default.json");

pub(crate) const CAPABILITY_ID: &str = "server-origin";

pub(crate) fn server_capability(port: u16) -> String {
    let mut capability: serde_json::Value =
        serde_json::from_str(PERMISSIONS_FILE).expect("capabilities/default.json is valid JSON");
    capability["identifier"] = json!(CAPABILITY_ID);
    capability["local"] = json!(false);
    capability["remote"] = json!({
        "urls": [format!("http://127.0.0.1:{port}"), format!("http://localhost:{port}")]
    });
    capability.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::utils::acl::capability::CapabilityFile;

    fn parse(port: u16) -> tauri::utils::acl::capability::Capability {
        match server_capability(port)
            .parse::<CapabilityFile>()
            .expect("a capability")
        {
            CapabilityFile::Capability(capability) => capability,
            _ => panic!("expected one capability"),
        }
    }

    #[test]
    fn the_grant_names_only_the_servers_own_origin() {
        let capability = parse(3773);
        let urls = capability.remote.expect("remote grant").urls;
        assert_eq!(urls, ["http://127.0.0.1:3773", "http://localhost:3773"]);
        assert!(!capability.local);
        assert_eq!(capability.windows, ["main"]);
    }

    #[test]
    fn the_static_file_grants_no_remote_origin_of_its_own() {
        let file: serde_json::Value = serde_json::from_str(PERMISSIONS_FILE).unwrap();
        assert!(file.get("remote").is_none());
    }

    #[test]
    fn the_grant_carries_every_permission_of_the_file() {
        let file: serde_json::Value = serde_json::from_str(PERMISSIONS_FILE).unwrap();
        let expected = file["permissions"].as_array().unwrap().len();
        assert!(expected > 20);
        assert_eq!(parse(1).permissions.len(), expected);
    }
}
