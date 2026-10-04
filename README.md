# Gustaf

Desktop AI chat and coding assistant built with Tauri 2, React and TypeScript. It talks to hosted model APIs, local models and the Codex, Claude Code and Cursor command-line agents from one window, and can edit your projects in a reviewable copy.

Gustaf was previously developed as M Code. Internal identifiers keep the old name so existing data and upgrades keep working: the application identifier `com.maksimkulakov.mcode`, the Rust crate and npm package names, and the data folders listed below.

## Install

> **Status:** no Gustaf release has been published yet. Installers are built by CI ([release notes](docs/release.md)), but the first public release is still waiting for the manual checks in the [release checklist](docs/release-checklist.md). Until then, build from source (see [Development](#development)). The instructions below describe the published release once it exists.

Download the latest release from [GitHub Releases](https://github.com/Libes6/Gustaf/releases/latest) and pick the file for your system:

| System | File | Notes |
| --- | --- | --- |
| macOS 13 or newer, Apple Silicon | `.dmg` for `aarch64` | |
| macOS 13 or newer, Intel | `.dmg` for `x64` | |
| Windows x64 | NSIS installer (`.exe`) or `.msi` | Use the `.exe` unless you deploy with MSI tooling. |
| Linux x64 | `.AppImage`, `.deb` or `.rpm` | Only the AppImage updates itself in the app. |

Windows on ARM, Linux on ARM, Flatpak, Snap and package repositories are not provided.

Some features need tools installed separately: Node.js on `PATH` for the Cursor SDK provider, Codex usage limits and the bundled TypeScript language server; the `codex`, `claude` or `cursor-agent` CLI for those providers; `gh` for creating pull requests.

### macOS: first launch

The macOS builds are **not signed with an Apple Developer ID and not notarized** (they carry an ad-hoc signature), so Gatekeeper blocks the first launch:

1. Open the `.dmg` and drag Gustaf to Applications.
2. Open Gustaf. macOS says it cannot verify the app; close the dialog.
3. Open System Settings → Privacy & Security, scroll to the message about Gustaf and click **Open Anyway**, then confirm. See [Apple's instructions](https://support.apple.com/en-us/102445).

API keys are kept in the macOS Keychain. Because the build has no stable Developer ID signature, macOS may ask again for permission to access the Keychain items after an update; choose "Always Allow" to stop the prompt for that version.

### Windows

The installers are not Authenticode signed, so Microsoft Defender SmartScreen may show "Windows protected your PC". Click **More info** → **Run anyway** if you trust the download. The installer may ask for administrator rights.

### Linux

- The AppImage checks for updates and installs them in the app. Make it executable (`chmod +x`); it needs FUSE and a writable location.
- `.deb` and `.rpm` installs do not update in the app; install the newer package by hand (`sudo apt install ./<file>.deb` or `sudo dnf install ./<file>.rpm`).
- Builds are made on Ubuntu 24.04. Distributions with an older glibc are not supported.
- Saving API keys needs a Secret Service keyring (GNOME Keyring or KWallet) running. Computer Use needs an X11 session.

### Updates

Release builds check GitHub Releases for a newer version once at startup. An update icon appears in the left rail; it downloads the update, verifies its signature and restarts after you confirm. Settings → General shows the installed version and has a manual check. Details: [release notes](docs/release.md).

### Where your data lives

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Chats, settings, review copies, attachments | `~/Library/Application Support/com.maksimkulakov.mcode` | `%APPDATA%\com.maksimkulakov.mcode` | `~/.local/share/com.maksimkulakov.mcode` |
| API keys and MCP secrets | Keychain (service `com.maksimkulakov.mcode`) | Credential Manager | Secret Service (GNOME Keyring / KWallet) |

Chats live in a local SQLite database (`app.db`) in that folder. More in [SECURITY.md](SECURITY.md).

### Uninstall

- **macOS:** quit Gustaf and move it from Applications to the Trash.
- **Windows:** Settings → Apps → Installed apps → Gustaf → Uninstall.
- **Linux:** delete the AppImage, or remove the package with `apt remove` / `dnf remove`.

Uninstalling keeps your data. To remove it too, delete the data folder above (and the app's cache folders named `com.maksimkulakov.mcode`, if present), and delete the stored keys: on macOS in Keychain Access (search for `com.maksimkulakov.mcode`), on Windows in Credential Manager, on Linux in your keyring app (Seahorse, KWalletManager).

## Features

- **Chat with many providers**: switch models per chat, compare 2-4 models side by side, retry and resume interrupted requests ([chat](docs/features/chat.md)).
- **Full-text search** across every message, Cmd+K ([search](docs/features/search.md)).
- **Interactive canvas**: assistant-written React/TSX previews in a sandbox, with revisions ([canvas](docs/features/canvas.md)).
- **Safe project edits**: by default the agent edits the project folder directly and every run starts from a checkpoint you can revert or use git; switch on "Review copy for chats" (globally or per chat) and it works in a shadow copy instead, where you review per file or per hunk, run tests there, then commit only what you accepted, optionally push and open a pull request with `gh`. A read-only AI review of the changes can run on demand or automatically after each run (optional, off by default; project rules in `.mcode/REVIEW.md`; high-severity findings ask for confirmation before accept or commit) ([files and git](docs/features/files-and-git.md)).
- **Command rules and action log**: allow/ask/deny rules for shell commands, project instruction files (`AGENTS.md`, `CLAUDE.md`, ...) ([rules](docs/features/rules-and-instructions.md)).
- **Memory**: saved global and per-project facts injected into prompts (editable in Settings and from the project menu), opt-in "suggest memories" from a chat (one extra model request that sends the chat text, redacted, to your provider; nothing saved without confirmation), and export to a managed section of `AGENTS.md` after a preview ([memory](docs/features/memory.md)).
- **Subagents and MCP servers** for API providers, with budgets and background runs ([agents](docs/features/agents.md), [MCP](docs/features/mcp.md)), plus [scheduled prompts](docs/features/scheduled-prompts.md).
- **Computer Use**: desktop control with per-action approval ([computer use](docs/features/computer-use.md)).
- **Usage telemetry and budgets**: token counts, subscription windows, daily and per-chat limits ([usage](docs/features/usage-and-budgets.md)).
- **Hardened webview**: strict CSP and narrowed Tauri capabilities ([security](docs/features/security.md)).
- **Import and export**: chats as JSON or Markdown, history from Claude Code, Codex, ChatGPT and Cursor ([import and export](docs/features/import-export.md)).
- **Accessibility**: keyboard operation, focus handling, landmarks, contrast tests and reduced motion ([accessibility](docs/features/accessibility.md)).

All feature pages are indexed in [docs/README.md](docs/README.md).

## Accessibility

The UI aims at WCAG 2.1 AA: full keyboard operation, visible focus rings in both themes, dialog focus trap and restore, labelled controls and landmarks, a polite status region for streaming and errors, contrast checked by `tests/contrast.test.mjs`, `prefers-reduced-motion` support and 24px hit areas. Details: [accessibility](docs/features/accessibility.md). Known gaps: it was reviewed from code and unit tests only (no VoiceOver or axe run in the app yet); native checkboxes are 16px; a very light custom accent can be low contrast outside the focus ring; dragging chats into sections is mouse only (the chat menu is the keyboard route); canvas artifacts and model-written Markdown are shown as given.

## Development

Requirements: Node (version in `.nvmrc`), the Rust toolchain and the Tauri 2 prerequisites for your OS. The app is developed on macOS; see [Platforms](#platforms) for Windows and Linux. Contribution guidelines, the branch flow and the checks expected on a pull request are in [CONTRIBUTING.md](CONTRIBUTING.md).

The repository is an npm-workspaces monorepo; the app lives in `apps/desktop`. Run everything from the repository root:

```sh
npm install                              # one install for all workspaces (single root package-lock.json)
npm --prefix apps/desktop/sidecar ci     # Node helpers launched by the app (standalone install, see below)
npm run tauri dev                        # native app with hot reload (same as: npm run tauri dev -w apps/desktop)
```

The root scripts `dev`, `build`, `tauri`, `test`, `test:ui`, `test:e2e` and `check` delegate to `apps/desktop`; other scripts (`test:chat`, ...) run with `npm run <name> -w apps/desktop`. `npm run dev` serves only the frontend; normal chats need the native Tauri backend. `npm run build` type-checks and builds the frontend. The canvas runtime (`apps/desktop/src/canvas/generated` and `apps/desktop/public/canvas`, git-ignored) is built by `apps/desktop/scripts/build-canvas.mjs` from the `predev` and `prebuild` hooks; run it by hand if you only run tests.

The sidecar is not a workspace member: it is bundled into the app as a resource together with its own `node_modules` (`tauri.conf.json`, `bundle.resources`), so it keeps its own `package.json`/`package-lock.json` and is installed on its own; hoisting its dependencies to the root would leave the bundle empty.

### Verification

```sh
npm run check        # i18n keys, tsc, node tests, UI tests, end-to-end tests, cargo test, protocol package (what CI runs)
```

The steps of `npm run check` can be run separately (from `apps/desktop`, or with `-w apps/desktop` from the root):

```sh
node scripts/check-i18n.mjs                               # translations
npx tsc --noEmit                                          # types (src and tests/ui)
npm test                                                  # node --test tests/*.test.mjs (pure logic)
npm run test:ui                                           # Vitest + Testing Library component tests in tests/ui
npm run test:e2e                                          # built frontend in local Chrome (playwright-core) with a fake Tauri backend; ~20 s, skips without Chrome
cargo test --manifest-path src-tauri/Cargo.toml           # Rust
```

Focused node suites: `npm run test:chat`, `test:canvas`, `test:usage`, `test:cli` (with `-w apps/desktop` from the root). Before a release, also `npm run tauri build -- --debug --bundles app`.

## Platforms

Gustaf is developed and used on **macOS**; that is the only platform on which it has been run by hand. Windows and Linux builds are compiled, tested and bundled in CI: the release workflow (`.github/workflows/release-build.yml`) runs the source and native tests and produces the Windows x64 and Linux x64 installers (a signed trial run succeeded on all four targets, see [release notes](docs/release.md)). Nobody has yet installed or launched those builds on a Windows or Linux machine, so treat them as experimental.

| Area | macOS | Windows | Linux |
| --- | --- | --- | --- |
| API keys | Keychain (`security-framework`) | Credential Manager (`keyring`) | Secret Service via D-Bus (`keyring`; needs GNOME Keyring or KWallet running) |
| Shell for `run_command` and CLI providers | login `zsh` | Windows PowerShell 5.1 | login `bash` (`sh` as the Rust-side fallback) |
| Window | overlay title bar, in-app header drags the window | native title bar | native title bar |
| Installers (`tauri build`) | `.app`, `.dmg` | NSIS `.exe`, `.msi` | `.deb`, `.rpm`, AppImage |
| Shortcuts | `⌘` | `Ctrl` (global stop: `Ctrl+Alt+Shift+Esc`) | `Ctrl` |
| Computer Use | supported (Accessibility and Screen Recording permissions) | screenshots and input only; no permission prompts; `open_app` unsupported | X11 only: a pure Wayland session is reported unsupported; `open_app` uses `gtk-launch` |

What is **not** verified outside macOS:

- Only CI exercises it: `.github/workflows/ci.yml` runs `npm run check` on `macos-latest`, `windows-latest` and `ubuntu-latest`, and the release workflow builds the installers. No UI is run on Windows or Linux.
- The installers produced from `tauri.windows.conf.json` and `tauri.linux.conf.json` have not been installed or started by hand; the shell capabilities (`capabilities/shell-*.json`) have not been exercised in a running app. The Linux system packages in the workflows are what the build needs (WebKitGTK, D-Bus, X11, PipeWire); the runtime dependencies on a user's machine are untested.
- CLI providers (Claude Code, Codex, Cursor Agent) on Windows: discovery looks on `PATH` and in the npm global directory, and the exact install locations of the Windows CLIs are assumed. A `.cmd` shim receives the prompt on stdin rather than as an argument (so `cmd.exe` cannot interpret it); that relies on `claude -p` and `codex exec` reading stdin and is unverified. The Cursor/Codex Node sidecars may not be able to start a `.cmd` shim.
- The Windows `run_command` captures stdout and stderr separately and appends stderr, so their order is not interleaved; killing a timed-out command may leave child processes running.
- Importing history: Cursor's database is looked up in the OS config directory and Claude Code's in `~/.claude`, `%USERPROFILE%\.claude`, `CLAUDE_CONFIG_DIR` or `$XDG_CONFIG_HOME/claude`; none of these paths have been checked against real installations outside macOS.
- Rust tests that need symlinks or POSIX hooks are skipped on Windows (`#[cfg(unix)]`); the portable ones run on the Windows CI runner.
- Linux: the Secret Service backend fails when no keyring daemon is running, in which case saving a key reports an error.

## Project structure

```text
apps/desktop/             the desktop app (package `mcode`)
  src/                    React UI: components/, lib/ (data, api, chat logic), providers/ (model backends),
                          agent/ (tool loop, rules, subagents, MCP), canvas/, i18n/
  src-tauri/src/          Rust backend: SQLite, files and shell, review copy, git, secrets, computer use, MCP
  sidecar/                Node helpers (Codex limits, Cursor agent); standalone npm install
  scripts/, public/, design/, index.html, vite.config.ts, vitest.config.ts, tsconfig*.json
  tests/                  node:test suites (*.test.mjs), tests/ui (Vitest component tests), tests/e2e
apps/mobile/              companion app skeleton (Expo SDK 57 dev build, expo-router); NOT an npm workspace, own lockfile
packages/protocol/        @mcode/protocol: protocol version and API/WebSocket event types (pure TypeScript)
docs/                     Architecture and per-feature documentation
```

Paths elsewhere in the documentation (`src/...`, `src-tauri/...`, `tests/...`, `sidecar/...`) are relative to `apps/desktop/`. Layers, data flow and the role of every module are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The maintainer's backlog (`TASKS.md`) is kept locally and is not in the repository; bugs and feature requests go to [GitHub Issues](https://github.com/Libes6/Gustaf/issues).

## Mobile companion app (skeleton)

`apps/mobile` is an Expo (React Native) app that will control the desktop app from a phone on the local network. Status: **skeleton only**. The screens (connection, QR pairing, projects, chat with streaming and approval cards, settings) run against an in-memory mock desktop (`src/api/mock.ts`, "Try demo mode"); the desktop server, the real pairing exchange and TLS certificate pinning do not exist yet. It has not been run on a simulator or device; only the typecheck, the unit tests, `expo-doctor` and a Metro bundle (`expo export`) were run.

It is a development build (`expo-dev-client`), not Expo Go, and is **not part of the root npm workspaces**: it has its own `package-lock.json` and `node_modules`, so Expo's pinned React / React Native cannot clash with the desktop's React. Root `npm ci` and `npm run check` do not touch it. Details in [apps/mobile/README.md](apps/mobile/README.md).

```bash
cd apps/mobile
npm ci                          # or: npm install
npm run check                   # tsc --noEmit + node --test (what the CI "mobile" job runs)
npx expo run:ios                # builds and installs the dev client (needs Xcode); or: npx expo run:android
npx expo start --dev-client     # Metro for an installed dev client
```

## Security

To report a vulnerability privately, and for what the app stores and where, see [SECURITY.md](SECURITY.md).

Release builds run under a strict Content Security Policy and a narrowed capability set (`src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`). The webview itself cannot reach the network (requests go through the Tauri http plugin), plain `http://` endpoints are limited to localhost, private networks, Tailscale and `.local`-style names (public hosts need https), and the shell scope is `zsh -lc <script>` only. `npm run test:csp` checks all of it without Tauri; the manual checklist, the reason for `'unsafe-eval'` (the canvas iframe inherits the CSP) and the one-line way to turn the CSP off are in [docs/features/security.md](docs/features/security.md).

## Providers and models

Add providers in Settings, Model providers. API keys are stored by the Rust backend (`secrets.rs`), not in the database.

| Provider | Kind | Notes |
| --- | --- | --- |
| Anthropic | API | Messages API with tool use |
| OpenAI | API | Responses API |
| Gemini, OpenRouter | API | OpenAI-compatible endpoints |
| Ollama, LM Studio | local API | No key; detected on their default ports |
| Custom | API | Any OpenAI-compatible base URL |
| Cursor | SDK | Cursor API key; runs through the sidecar |
| Codex, Claude Code, Cursor Agent | CLI | Uses the installed CLI and its own sign-in, tools, approvals and MCP configuration |

- API providers run Gustaf's own tool loop (read, edit, search, shell, MCP, subagents, Computer Use where the model supports it); CLI providers run their own tools in the project folder and are streamed through the shell plugin.
- The model list comes from each provider; context windows and image/tool capabilities are shown when the provider reports them and are unknown otherwise.
- Sign-in is verified by a small test request or a successful chat response, not by listing models. Transient API failures are retried with backoff before any text reaches the chat ([streaming robustness](docs/features/chat.md#streaming-robustness)).
- Subscription windows (Codex, Claude Code) and token usage: [usage and budgets](docs/features/usage-and-budgets.md). Which model hosts subagents, compaction and commit messages: [agents](docs/features/agents.md).
- Image attachments work with CLI providers too (written to a temporary folder per chat, see [files and git](docs/features/files-and-git.md)).

## License

[MIT](LICENSE). Third-party assets and dependencies retain their own licenses, including the [model icons](apps/desktop/public/icons/LICENSE).
