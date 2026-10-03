# Desktop distribution and signed updates

## Current state

`release-build.yml` is a manually started three-platform bundle pipeline. It uploads CI artifacts; it does **not** publish a GitHub release or send files anywhere. This checkout has no Git remote, update endpoint, updater public key, or Apple credentials configured. A local build is ad-hoc signed on macOS. Windows artifacts are unsigned. Generated artifacts and OS support are not considered tested until CI and the device checklist below pass.

Application Settings displays the installed version and explicitly says updates are unconfigured. The update controller separates check, download, and installation; its native transport is activated only when a build contains a nonempty public key and HTTPS update endpoints. It uses the official Tauri updater, whose download verifies the update signature before enabling installation. Endpoint/key values are never taken from a chat or runtime user input. A failed check must never display “up to date”.

## macOS signing and notarization

Provide these repository secrets, then manually run the workflow with `signed_macos=true`:

- `APPLE_CERTIFICATE`: base64 export of the Developer ID Application certificate/private key (.p12).
- `APPLE_CERTIFICATE_PASSWORD` and `KEYCHAIN_PASSWORD`: certificate and temporary CI keychain passwords.
- `APPLE_SIGNING_IDENTITY`: full Developer ID Application identity; never `-`.
- `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID`: notarization credentials.

Missing credentials fail the signed job. The temporary keychain is removed on completion. The pipeline verifies the bundle signature, Gatekeeper assessment, and notarization staple. Do not commit certificates or credentials. The artifact is for the runner's native architecture; an Intel/ARM matrix must be added and tested before claiming universal support.

## Provisioning real auto-updates

After choosing the real release repository/HTTPS endpoint and obtaining the signing key:

1. Generate a Tauri updater key pair with `tauri signer generate`; store the private key in the release secret store and back it up securely.
2. Set repository variables `M_CODE_UPDATER_PUBLIC_KEY` and `M_CODE_UPDATER_ENDPOINT` (a real HTTPS feed URL, optionally containing Tauri's target/arch/version placeholders). Both must be present. Set `TAURI_SIGNING_PRIVATE_KEY` and optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as secrets. The workflow then merges updater config and generates signed update artifacts. A partial configuration or missing private key fails the build. The updater/process plugins and frontend transport are already installed and wired; no code change is required. Local config deliberately omits these values and stays disabled.
3. Publish installer/update artifacts, their `.sig` files, and a version/platform manifest to the chosen endpoint. This requires a separate publishing workflow; the current workflow intentionally only builds artifacts. The manifest's platform/architecture URLs must correspond to the actual runner artifacts.
4. Verify the provisioned build enables checking. Download verifies the signature before the separate install control appears; install then relaunches through the process plugin. Never override signing keys from a user-entered endpoint or disable signature checks.
5. Keep check, download, and install as separate user actions. Test a valid update, wrong signature, unavailable network, unsupported architecture, interrupted download, install failure, and restart preserving the database/providers.

Primary references: [Tauri updater](https://v2.tauri.app/plugin/updater/) and [macOS signing](https://v2.tauri.app/distribute/sign/macos/).

## Device smoke checklist

Run on clean macOS, Windows, and Linux machines; keep the OS/version/architecture and artifact hash with the result.

- Install, start without development servers, quit/reopen, and uninstall. Confirm icon, window controls, saved settings, and existing database migration.
- Provider discovery/login, model selection, real chat, cancellation/retry, image attachments, permissions, and secure key storage.
- Project read/edit/review accept/reject/rollback, existing shell commands, built-in terminal input/resize/stop, and external CLI dependencies missing/present.
- Computer Use permissions, screenshot/click/type/focus; Linux X11 and Wayland limitations must be recorded separately.
- Canvas rendering, menu mouse/keyboard/outside-click behavior, optional MCP, unavailable network, and supported locale switching.
- Updates: a test release one version newer, signature rejection, explicit install/restart, and data preservation. Until provisioning completes, verify the disabled message instead.
