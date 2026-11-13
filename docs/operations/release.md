# Gustaf releases

`.github/workflows/ci.yml` (Gustaf Tauri) builds one macOS bundle per PR. Pushes to `dev` warm the Rust caches; version tags and manual runs build all desktop targets. The tag release job publishes Gustaf installers and dispatches the Android release workflow. It does not publish upstream T3 npm, AUR, hosted web, relay, EAS or nightly channels.

Release tags must match `apps/shell/src-tauri/tauri.conf.json` and point to a commit on `main`. Configure `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and the updater public-key variable before publishing. See `ci.yml` for the artifact set and publication gates.

## Pull request macOS previews

Labeling a PR `preview:mac` publishes a signed, notarized Apple Silicon DMG with T3 Connect enabled
to the rolling `desktop-preview` prerelease, and works for fork PRs. The label is a one-shot request
for the commit it is applied to: the trusted workflow removes it once the build is in hand, and later
pushes do not build until a maintainer applies it again. Every signed preview is therefore a
per-commit maintainer decision, which matters because the result carries the Developer ID signature.
Vouching a contributor lets their labeled commits be signed; it is not a standing grant. The build is
split so the Developer ID certificate never shares a job with PR code:

- `.github/workflows/desktop-macos-preview.yml` runs on `pull_request` with no secrets and builds
  only the JS bundle from the PR.
- `.github/workflows/desktop-macos-preview-publish.yml` runs on `workflow_run` from `main`. It
  refuses unless the PR is open, still labeled, its head is the built commit, and the author is a
  bot, a collaborator, or listed in `.github/VOUCHED.td` (read from the default branch, so a PR cannot vouch
  for itself). It then packages and signs the bundle through `release-desktop.yml` checked out at
  `main`, so packaging, native helpers, and the Electron/desktop dependencies come from `main`, not
  the PR. Only the version and the public T3 Connect identifiers in `.env.example` are read from the
  PR commit, as data, so the signed app's passkey entitlement matches the bundle. A PR that changes
  packaging needs a separate packaging validation.

Before handing the bundle to the signing runner, the trusted workflow validates its ZIP entries
and accepts only regular files under `server/dist` and `desktop/dist-electron`, plus the directory
entries that lead to those roots. The artifact cannot
overwrite packaging code or installed dependencies. The bundle is copied into the app, never executed,
on the signing runner. The
`pull_request_target` cleanup job in the publish workflow removes the download when the PR closes, or
when the label is removed by hand before a build consumed it, and never checks out PR code.

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
