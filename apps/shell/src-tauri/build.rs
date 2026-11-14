fn main() {
    println!("cargo:rerun-if-changed=native/SnapShot.swift");
    println!("cargo:rerun-if-changed=native/ComputerUse.swift");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let output =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("gustaf-snapshot");
        let target = std::env::var("TARGET").unwrap();
        let arch = if target.starts_with("aarch64") {
            "arm64"
        } else {
            "x86_64"
        };
        let status = std::process::Command::new("xcrun")
            .args([
                "swiftc",
                "-O",
                "-target",
                &format!("{arch}-apple-macosx12.0"),
                "native/SnapShot.swift",
                "-o",
            ])
            .arg(output)
            .status()
            .expect("Swift compiler is required for macOS SnapShots");
        assert!(status.success(), "failed to compile SnapShot helper");
        let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap())
            .join("gustaf-computer-use");
        let status = std::process::Command::new("xcrun")
            .args([
                "swiftc",
                "-O",
                "-target",
                &format!("{arch}-apple-macosx12.0"),
                "native/ComputerUse.swift",
                "-o",
            ])
            .arg(output)
            .status()
            .expect("Swift compiler is required for macOS computer use");
        assert!(status.success(), "failed to compile computer-use helper");
    }
    // Naming a command here gives it a permission the capability file can grant.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "ssh_request",
            "dropped_paths",
            "drag_window",
            "snap_shot_command",
            "read_connection_catalog",
            "write_connection_catalog",
            "reveal_window",
            "window_fullscreen_state",
            "set_window_theme",
            "read_client_settings",
            "write_client_settings",
            "local_environment_bootstraps",
            "local_environment_bearer_token",
            "local_environment_enabled",
            "set_local_environment_enabled",
            "server_exposure_state",
            "set_server_exposure_mode",
            "set_tailscale_serve_enabled",
            "advertised_endpoints",
            "client_platform",
            "app_branding",
            "update_state",
            "update_check",
            "update_download",
            "update_install",
            "account_state",
            "account_sign_in",
            "account_cancel_sign_in",
            "account_sign_out",
            "account_devices",
            "account_register_device",
            "account_revoke_device",
            "cli_command_state",
            "cli_command_install",
            "cli_command_uninstall",
            "cli_command_add_to_path",
            "client_config",
            "account_report_problem",
        ]),
    ))
    .expect("failed to run tauri-build");
}
