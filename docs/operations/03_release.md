# Release runbook

Gustaf ships from `Libes6/Gustaf` through one workflow, [`gustaf-release.yml`](../../.github/workflows/gustaf-release.yml) (it calls [`gustaf-release-desktop.yml`](../../.github/workflows/gustaf-release-desktop.yml) once per desktop platform). Pushing a `vX.Y.Z` tag builds and publishes everything; there are no nightly, preview or npm channels.

## Cut a release

1. On `main`, set the version everywhere it lives and commit it: `node .github/scripts/set-release-version.cjs X.Y.Z` (server, desktop, web and contracts packages). Optionally add `docs/release-notes/X.Y.Z.md`; it is used verbatim as the release notes and the update card. Otherwise the notes are `feat` pull request titles since the previous tag (up to seven bullets) and a `Plus N bug fixes and improvements.` line for `fix` and `perf`.
2. Run **Gustaf release** from the Actions tab (a dry run, see below) and fix whatever it reports.
3. Tag that commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The `meta` job refuses a tag whose version differs from `apps/desktop/package.json`, or whose commit is not on `main`.

## What the workflow does

| Job                                                 | Result                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop_linux`, `desktop_macos`, `desktop_windows` | Electron installers and the `t3-<version>-<platform>.tar.gz` / `.zip` CLI archive, each on a runner of its own architecture, unsigned. Windows starts after Linux because it embeds the Linux CLI archive as its WSL runtime. Linux and macOS also launch the packaged app once.                        |
| `android`                                           | A release APK (`io.github.libes6.gustaf`, `arm64-v8a` and `armeabi-v7a`) signed with the keystore secrets, checked against the pinned certificate digest, and `latest-android.json`.                                                                                                                    |
| `release`                                           | Signs the three update files, checks every signature against the public key the apps carry, writes `latest.json` and `SHA256SUMS` (the CLI archives), and publishes a draft that becomes the latest release only after every file is attached. It is the only job with the signing key or write access. |

Release files: `Gustaf-<v>-macOS-arm64.dmg`, `.app.tar.gz` (+ `.sig`); `Gustaf-<v>-Windows-x64-setup.exe` (+ `.sig`); `Gustaf-<v>-Linux-x64.AppImage` (+ `.sig`) and `.deb`; `t3-<v>-darwin-arm64.tar.gz`, `linux-x64.tar.gz`, `win32-x64.zip`; `SHA256SUMS`; `latest.json`; `Gustaf-<v>-Android.apk` (+ `.sha256`); `latest-android.json`.

A manual run (**Run workflow**, optionally with a version) is a dry run. It builds and signs everything and checks every signature against the public key, then keeps the files for seven days as the `release-files` artifact and publishes nothing. Do the first run of any change to this pipeline that way.

## How updates reach users

`https://github.com/Libes6/Gustaf/releases/latest/download/latest.json` lists, per platform, the update file's URL and its minisign signature. The desktop app ([`GustafUpdater`](../../apps/desktop/src/updates/GustafUpdater.ts)) reads it 15 seconds after start and every four hours. It offers a release that is newer than the running version, downloads the file for its platform, and installs it only if the signature verifies against the public key baked in at build time. It installs nothing for a release it cannot verify, and nothing from any host but the GitHub release (or an administrator's mirror, see [managed policy](../user/managed-policy.md)).

| Platform | Install, once the user accepts the update                                                                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | The app quits; a helper replaces `Gustaf.app` with the unpacked update (quarantine removed) and reopens it. The app's folder must be writable by the user, or the update fails before quitting and says so. |
| Windows  | The app quits and the NSIS installer runs silently (`--updated /S --force-run`), then starts Gustaf.                                                                                                        |
| Linux    | An AppImage replaces itself and reopens. A `.deb` install cannot: it is told to download the release.                                                                                                       |

Builds are unsigned, which is why Gustaf does not use `electron-updater`: Squirrel.Mac refuses an unsigned app. Our signature protects the update; it does not make macOS or Windows trust the app. A first install from the DMG or setup file still meets Gatekeeper ("open anyway" in System Settings) and SmartScreen ("more info, run anyway"). Files the app downloads itself carry no quarantine, so updates after that do not.

Android has no in-app update yet: install the new APK over the old one (same certificate, higher `versionCode`). `latest-android.json` (`version`, `versionCode`, `apkUrl`, `sha256`, `size`, `pubDate`) is published for a future in-app check. `versionCode = X*10000 + Y*100 + Z` from the tag, so minor and patch stay below 100. Over-the-air updates (`GUSTAF_MOBILE_UPDATES_URL`) need an Expo Updates protocol server and are not served from GitHub; iOS is not built.

Servers update to the desktop's version from the `t3-*` archives on the same release, checked against `SHA256SUMS`; see [server updates](../internals/07_server-updates.md).

## One-time setup

- **Secrets:** `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the minisign key that signed the Tauri-era releases; it now signs the Electron update files. Tauri-era apps verify the same signatures, but whether they can install an Electron build over themselves is untested), `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`.
- **Variable:** `M_CODE_UPDATER_PUBLIC_KEY`, the matching public key as `tauri signer generate` prints it (or `GUSTAF_UPDATER_PUBLIC_KEY`, which wins). The desktop builds embed it as `gustaf-updater.json`; a build without it has updates off. The release job refuses to publish if it does not verify the signatures it just made.
- The Android certificate's SHA-256 is pinned as `EXPECTED_CERT_SHA256` in the workflow. Never replace the keystore: installed apps accept updates only from the same certificate. Keep an offline backup.

No Apple, Windows, Discord, AUR, npm or Cloudflare credentials are used.

## Pulling a bad release

Delete the release and its tag (`gh release delete vX.Y.Z --cleanup-tag`). `releases/latest` then points at the previous release, so `latest.json` offers the previous version, which the apps ignore because it is not newer. To replace a bad release, publish a higher version.

## Known gaps

- The in-app update path has not been exercised on a real installed app on every platform; the first release after a change here should be installed and updated once by hand per platform.
- `ci.yml` and a few scripts (`release-smoke.ts`, `resolve-nightly-release.ts`, `build-npm-launcher.ts`) still describe T3's nightly and npm pipeline; nothing in the Gustaf release uses them.
