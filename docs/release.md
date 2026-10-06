# Gustaf desktop releases and signed updates

## Implemented pipeline

The existing `.github/workflows/release-build.yml` builds macOS Apple Silicon and Intel, Windows x64, and Linux x64. `workflow_dispatch` produces CI artifacts without publishing. A push to `main` whose source version has no `vX.Y.Z` tag yet builds all platforms, then tags that commit and creates/updates a **draft** GitHub Release in [Libes6/Gustaf](https://github.com/Libes6/Gustaf). Every matrix job must succeed before the tag and draft are created. A retry refuses to modify an already public release. Branch model and CI: [branching.md](branching.md).

The draft contains installers, updater payloads, `.sig` files, and one complete `latest.json`. Architecture prefixes prevent macOS archive collisions. Manifest URLs point to the immutable version tag; the application checks `https://github.com/Libes6/Gustaf/releases/latest/download/latest.json`. Drafts are unavailable through this public endpoint. Public publication requires separate human authorization; the workflow never publishes a draft automatically. No release has been published or signature/certificate secret configured by this change.

The product and window name are Gustaf. The existing application identifier, Rust crate, npm workspace names, and data paths remain stable to preserve upgrades and existing user data. License terms are unchanged.

## Versioning

From repository root:

```sh
npm run version:check
npm run version:bump -- patch # also minor, major, or an explicit higher stable X.Y.Z
npm run test:release
```

The bump command synchronizes root/desktop package.json, root package-lock.json (including workspace entries), Cargo.toml, the app's Cargo.lock entry, and tauri.conf.json. It does not create commits or tags. Mobile, sidecar and protocol packages have independent versions and are not desktop release versions. Stable SemVer only: prereleases and non-increasing versions are rejected.

## Release flow

`dev` is the integration branch, `main` the release branch ([branching.md](branching.md)).

1. On `dev`, through a normal pull request, run `npm run version:bump -- <level>` and commit the changed version files.
2. After release approval, open a pull request from `dev` into `main`; CI runs on it. Merge.
3. The push to `main` starts the release workflow. Its `plan` job (`scripts/release-plan.mjs`) reads the version from the desktop version files and checks whether tag `vX.Y.Z` exists on origin:
   - tag missing: all four platforms are built; only if every job succeeds, job `draft` creates tag `vX.Y.Z` on the merged `main` commit and a **draft** release `vX.Y.Z` with installers, signatures and `latest.json`;
   - tag exists and a release (draft or published) exists for it (docs-only push, merge without a bump): the build is skipped with a `::notice::` ("Tag vX.Y.Z already exists: nothing to release") and the run succeeds. Nothing is tagged or released;
   - tag exists but **no** release exists for it (a stray tag): `plan` fails with an `::error::` naming the tag and the commit it points at. Nothing is built. See below.
4. Review the draft and publish it by hand (see the checklist below). The workflow never publishes.

`plan` fails the run for a push to any other branch, from a fork, or of a commit that is not on `origin/main`. These refusals come first: GitHub is asked about releases only for an eligible push whose tag exists. `plan` looks the release up with `gh release view vX.Y.Z`; any `gh` error other than "release not found" (authentication, network) also fails the run rather than counting as "no release". Seeing draft releases needs `contents: write`, so the `plan` job has it; it only reads.

**Do not create or push `vX.Y.Z` tags by hand.** The workflow has no tag trigger, so a pushed tag starts nothing. Worse, the merge to `main` with that version then finds the tag without a release, and `plan` fails the run ("Tag vX.Y.Z exists on <sha> but has no release"); nothing is built. The same happens with a tag left over from an abandoned attempt. Fix it by deleting the stray tag on origin (`git push origin :refs/tags/vX.Y.Z`) and re-running the workflow (or pushing to `main` again), or by bumping to a higher version. Earlier versions of `plan` skipped silently in this case, so a version could go unreleased unnoticed.

If the run fails after the tag was pushed (for example during upload), use "Re-run failed jobs" on that run: it re-runs only the failed `draft` job and reuses the successful `plan` job's outputs, so the tag that now exists does not stop it. The draft job accepts an existing tag only when it points at the same commit, and keeps an existing draft's notes. Do not use "Re-run all jobs" or a new push to `main` for this: both run `plan` again, which then skips (if the incomplete draft exists) or fails as a stray tag (if the draft was never created). A failure before the tag (a bundle job) is retried by re-running, or by the next push to `main`.

Do not retag a released version. Build a higher version for corrections. Review generated release notes and the manifest's `notes` together before publication: edit both if wording changes, otherwise installed clients see the original generated notes.

## Hotfix

1. Branch from `main` (`git switch -c hotfix/<topic> main`), fix, and bump the patch version (`npm run version:bump -- patch`).
2. Open a pull request into `main`. Merging it produces the draft release as above; review and publish it.
3. After the release, merge `main` back into `dev` (pull request `main` → `dev`) so the fix and the version bump reach `dev`. On a version conflict keep the higher version, then run `npm run version:check`.

## Required settings before the first real release

Generate a Tauri updater key pair outside the repository using `npm run tauri -- signer generate -w /secure/path/gustaf.key`. Do not paste private keys into chat, commit them, or print them in CI. Back up the private key securely: existing installations trust this key and losing it prevents future signed updates.

Repository **variable**:

- `GUSTAF_UPDATER_PUBLIC_KEY`: public key contents generated by the Tauri signer, not a path. Until the repository variable is renamed, the workflow falls back to the variable's earlier name `M_CODE_UPDATER_PUBLIC_KEY`. The endpoint is fixed to this repository; the old endpoint variable is no longer used.

Repository **secrets**:

- `TAURI_SIGNING_PRIVATE_KEY`: private updater key contents. A local path is accepted by the CLI but is not available on GitHub runners.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: key password; empty only for a key created without a password.

Optional Apple Developer ID/notarization secrets (not needed for the initial release):

- `APPLE_CERTIFICATE`: base64 exported Developer ID Application certificate and private key (.p12).
- `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`: export password and temporary CI keychain password.
- `APPLE_SIGNING_IDENTITY`: full `Developer ID Application: …` identity.
- `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID`: notarization credentials.

Release builds (push to `main` with a new version) always require the free Tauri updater signing key; missing updater credentials fail the pipeline. Paid Apple Developer Program membership is **not required** for this initial distribution. By default, macOS bundles use the existing ad-hoc signature (`signingIdentity: "-"`) without Developer ID or notarization, including release builds. Users may need to allow the first launch in System Settings → Privacy & Security → Open Anyway after attempting to open the downloaded app; see [Apple's instructions](https://support.apple.com/en-me/102445). This first-launch exception and subsequent update/relaunch behavior must be tested on a real Mac.

If Apple membership is obtained later, set the optional repository variable `GUSTAF_SIGNED_MACOS=true` to enable Developer ID signing and notarization for release and manual builds, or use `signed_macos=true` for one manual run. When either option is enabled, all Apple secrets above are required and missing credentials fail the job. Leave the variable unset or `false` for the current free distribution. Updater signing is independent of Apple notarization and Windows Authenticode signing. The Windows installer is **not Authenticode signed** by this workflow; SmartScreen warnings may remain. No Windows certificate has been provisioned. Temporary Apple certificates/keychains are removed after every job.

The automatically supplied `GITHUB_TOKEN` needs Actions `contents: write` for the draft job, and for the `plan` job, which only reads but must see draft releases. Enable Actions for the repository and permit this scoped token. The other jobs retain read-only permissions. The repository and release assets must be publicly accessible for this unauthenticated updater endpoint. Private repositories need a different authenticated distribution design; do not embed a GitHub personal token in the application.

## Application behavior

A provisioned build checks once at startup and shares the result with Settings. An update icon appears immediately above the account icon when a new version is available. Its explicit “Update to … and restart” action downloads, verifies, installs and relaunches in one click. Active generation requires interruption consent, checked again after download. Settings also retains separate download/install controls. Checking is read-only. Settings displays the installed version, offered version, release notes as plain text, bytes/progress, and signature verification state. The native updater verifies signatures before the Install control appears. Installation requires an explicit restart confirmation. Active interactive or scheduled generation requires an additional interruption consent; cancellation leaves the update downloaded. The controller rejects duplicate concurrent operations. Network failures never report “up to date”; signature failures block installation; manual checking retries either error. Builds without configuration remain disabled.

The plugin's Windows installer can exit the application itself; macOS/Linux installation is followed by the Tauri process relaunch API. The restart confirmation therefore comes **before** native installation on every platform. Scheduled generation is checked again when confirming. Application files are replaced by the updater; settings/database migration still requires the device checklist below.

## Supported distribution formats

| Platform | Installers | In-app update feed | Limits |
| --- | --- | --- | --- |
| macOS arm64, x64 | APP, DMG | Signed `.app.tar.gz` per architecture | macOS 13+; ad-hoc signing by default; first-launch permission may be needed; writable installation location |
| Windows x64 | NSIS EXE, MSI | Signed EXE and installer-specific MSI manifest entry | Native installer may request elevation and exit app; no Authenticode setup |
| Linux x64 | AppImage, DEB, RPM | Signed AppImage | Built on Ubuntu 24.04; older glibc distributions are not claimed supported; DEB/RPM in-app checks deliberately disabled; update through package tools/manually; AppImage/FUSE dependencies and write permissions |

Windows ARM, Linux ARM, mobile, Flatpak/Snap and package-manager updates are not provided by this pipeline. The installed Tauri updater version has DEB/RPM install paths, but this feed intentionally does not produce their installer-specific entries. macOS archives and Windows installers follow the [official Tauri updater formats](https://v2.tauri.app/plugin/updater/). Matrix runners use the published [GitHub runner labels](https://github.com/actions/runner-images).

## Verification and publication checklist

For a private macOS `0.1.0 → 0.1.1` test on the current machine, use the [local updater smoke-test procedure](updater-smoke.md). It builds a separate signed pair and loopback feed without a public release.

Local checks: `npm run version:check`, `npm run test:release`, `npm test`, `npm run test:ui`, `npm run build`, and `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml -- --test-threads=1`. Release tests verify real version-file rewrites in an isolated checkout, tag/version mismatch, complete platform manifest, payload extensions and missing/empty signatures. Updater tests cover offline/retry, no newer version, signature rejection, duplicate checks, install errors and interruption consent. These are not evidence of a successful signed installer or an actual cross-platform upgrade.

Before publishing the draft:

1. Run the workflow with real signing credentials. Verify all four matrix jobs, updater payloads and signatures, full manifest and reviewed release notes. Apple signature/Gatekeeper/notarization checks apply only when paid Apple signing is explicitly enabled.
2. On clean macOS Intel/Apple Silicon, Windows NSIS/MSI, Linux AppImage: install an older provisioned version and upgrade to a newer test version using the real native updater. Record OS, architecture, artifact hashes and outcomes. A private staging feed/test fixture may be used; drafts cannot be fetched via the public latest endpoint.
3. Exercise offline check, unavailable feed (including first-release 404), wrong signature, interrupted download, unwritable install location, install failure, no newer version, active interactive/scheduled generation and declined restart. Confirm existing database/providers/projects/drafts survive relaunch. Verify DEB/RPM checks stay disabled.
4. Install/start without development servers; verify chat, cancellation, tools, secure key storage, OS permissions, and dependencies. Windows/Linux application features and sidecar external Node/CLI dependencies require independent device validation.
5. Only with explicit authorization, publish the reviewed draft in GitHub Releases. Confirm unauthenticated `latest.json` retrieval and an end-to-end update on every supported format. Never describe the release as signed/tested until those checks actually pass.

## Local validation of this change

On the local macOS checkout: version consistency and six release tests passed; TypeScript/frontend production build and i18n check passed; 756 Node tests passed (two skipped), 174 UI tests passed, and 18 browser E2E tests passed. Native tests passed serially: 188 passed, one ignored. Parallel native testing reproduced an existing MCP restart timing failure; CI uses serial native testing. Initial sandbox restrictions blocked loopback sockets/Chrome; successful native/E2E runs used the required local access. Workflow YAML parses. Subsequent GitHub validation is recorded below; an actual installed-app upgrade round trip remains pending.

Apple signing policy update: Apple credentials are now optional for tag builds as well as manual builds. GitHub trial builds use this unpaid signing policy. Apple notarization and an installed-app update round trip remain pending.

CI portability fixes: Windows MCP absolute paths are accepted; path/file-name test fixtures respect Windows rules. Git fixtures pin the bare repository HEAD to main and explicitly request text for large diff tests. Linux builds use Ubuntu 24.04 because the existing libspa dependency cannot compile against Ubuntu 22.04 PipeWire headers. Compatibility with older Linux distributions requires a separate build strategy and has not been verified.

Further CI validation found and fixed Windows verbatim-path LSP URIs, Windows separator handling in linked review directories, and a race between MCP crash notification and its restart state. The full local native suite still passes (188 tests, one ignored). Unix-only shell/symlink fixtures are gated; portable tests remain enabled on Windows. Hosted-runner cold Python startup is given 15 seconds in the LSP fixture.

## Signed GitHub trial build (2026-10-03)

[Run 37127524274](https://github.com/Libes6/Gustaf/actions/runs/37127524274) completed successfully for source commit `9378938ac6e55dccd15f4d5b1cda3501712f7959`: macOS Apple Silicon and Intel, Windows x64, and Linux x64 all passed source/native checks and produced installers. Paid Apple signing was disabled. Encrypted updater credentials are provisioned in GitHub Secrets; the public key is in the repository variable.

Downloaded updater signatures were verified with `minisign_verify`, the native updater's verifier, against the configured public key: both macOS `.app.tar.gz` archives, Windows EXE/MSI, and Linux AppImage (also DEB/RPM). Each altered payload was rejected. A complete five-entry `latest.json` was generated from these actual artifacts; it pins URLs to `v0.1.0`. This trial did not create a tag, draft, or public release, so those URLs are not yet live. Workflow artifacts expire after 14 days.

The latest local native suite passed 189 tests (one ignored); all six release tests passed. Windows LSP diagnostics now match resolved file URIs even when a server normalizes drive casing or encoding. Staging excludes internal DEB archives. Actual installation, first launch, data preservation, and an older-to-newer native updater round trip on devices remain required before publication.

Local smoke-test preparation: signed release-mode Apple Silicon test builds `0.1.0` and `0.1.1` use an isolated source snapshot and a loopback-only feed. No working-checkout updater override is needed. Test metadata, ad-hoc bundle signatures, updater signatures, payload hashes and failure-mode HTTP routes are checked. The rail action passed all 178 UI tests and a real Chrome scenario covering placement above account, keyboard activation and native call order. Actual device installation/relaunch and data preservation still require the manual smoke steps.
