# Gustaf releases

`.github/workflows/ci.yml` (Gustaf Tauri) builds one macOS bundle per PR. Pushes to `dev` warm the Rust caches; version tags and manual runs build all desktop targets. The tag release job publishes Gustaf installers and `gustaf` CLI archives, and dispatches the Android release workflow. It does not publish upstream T3 npm, AUR, hosted web, relay, EAS or nightly channels.

Release tags must match `apps/shell/src-tauri/tauri.conf.json` and point to a commit on `main`. Configure `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and the updater public-key variable before publishing. See `ci.yml` for the artifact set and publication gates.

## CLI archives

The install scripts, `gustaf update`, desktop-managed SSH hosts and the npm launcher download `gustaf-<version>-<platform>-<arch>.tar.gz` (`.zip` on Windows) for `darwin-arm64`, `linux-x64` and `win32-x64` from the release, and check it against `SHA256SUMS.txt`. Names come from `cliArchiveFileName` in `packages/shared/src/cliRelease.ts`.

- Each bundle job builds its archive once: `pnpm build:runtime` packs the server with `scripts/build-cli-archive.ts`, keeps a copy in `release/gustaf-cli`, and unpacks the same files as the app's `runtime/` (renaming `gustaf` back to `t3`, which the shell and installed launchers run). A pull request builds and smoke-tests the macOS archive without publishing it.
- The archive's version is the app's: the bundle job runs `apps/shell/scripts/stamp-version.mjs` before building, which writes the `tauri.conf.json` version into `apps/server` and `apps/web` `package.json`. The checked-in versions stay at T3's 0.1.7, so local builds report 0.1.7. The orchestration protocol version is separate and unchanged.
- The release job refuses to publish unless it has exactly three archives named for the tag's version.

## Gustaf Android release APK

Every `vX.Y.Z` release gets a signed production APK (`io.github.libes6.gustaf`, arm64-v8a and
armeabi-v7a) from `.github/workflows/mobile-android-release.yml`. The `release` job in `ci.yml`
dispatches it after publishing, because a release published with `GITHUB_TOKEN` fires no
`release` event; a release published by hand triggers it directly. It builds the tag's source
with `APP_VARIANT=production` and attaches three assets to the release:

- `Gustaf-<version>-Android.apk` and its `.sha256`
- `latest-android.json`: `version`, `versionCode`, `apkUrl`, `sha256`, `size` and `pubDate`. The
  newest copy is always at
  `https://github.com/Libes6/Gustaf/releases/latest/download/latest-android.json`.

The tag sets the app version and `versionCode = X*10000 + Y*100 + Z`
(`apps/mobile/androidVersion.ts`), so minor and patch must stay below 100. Android refuses an
update with a lower or equal `versionCode`. Tags created before this workflow existed cannot be
built by it.

To rebuild, run **Gustaf Android release** from the Actions tab with the tag, or leave it empty
for the latest release. The upload replaces the existing assets.

Signing uses the `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`
secrets, and the job fails unless the APK's certificate SHA-256 equals `EXPECTED_CERT_SHA256` in
the workflow. Never regenerate or replace this key: installed apps accept updates only from the
same certificate, so a new key forces every user to uninstall and lose app data. Keep an offline
backup of the keystore.
