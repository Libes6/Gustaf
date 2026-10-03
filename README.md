# M Code

Desktop AI chat and coding assistant built with Tauri 2, React and TypeScript. It talks to hosted model APIs, local models and the Codex, Claude Code and Cursor command-line agents from one window, and can edit your projects in a reviewable copy.

## Features

- **Chat with many providers**: switch models per chat, compare 2-4 models side by side, retry and resume interrupted requests ([chat](docs/features/chat.md)).
- **Full-text search** across every message, Cmd+K ([search](docs/features/search.md)).
- **Interactive canvas**: assistant-written React/TSX previews in a sandbox, with revisions ([canvas](docs/features/canvas.md)).
- **Safe project edits**: the agent works in a shadow copy; you review per file or per hunk, run tests there, then commit only what you accepted, optionally push and open a pull request with `gh` ([files and git](docs/features/files-and-git.md)).
- **Command rules and action log**: allow/ask/deny rules for shell commands, project instruction files (`AGENTS.md`, `CLAUDE.md`, ...) ([rules](docs/features/rules-and-instructions.md)).
- **Subagents and MCP servers** for API providers, with budgets and background runs ([agents](docs/features/agents.md), [MCP](docs/features/mcp.md)), plus [scheduled prompts](docs/features/scheduled-prompts.md).
- **Computer Use**: desktop control with per-action approval ([computer use](docs/features/computer-use.md)).
- **Usage telemetry and budgets**: token counts, subscription windows, daily and per-chat limits ([usage](docs/features/usage-and-budgets.md)).
- **Hardened webview**: strict CSP and narrowed Tauri capabilities ([security](docs/features/security.md)).
- **Import and export**: chats as JSON or Markdown, history from Claude Code, Codex, ChatGPT and Cursor ([import and export](docs/features/import-export.md)).
- **Accessibility**: keyboard operation, focus handling, landmarks, contrast tests and reduced motion ([accessibility](docs/features/accessibility.md)).

All feature pages are indexed in [docs/README.md](docs/README.md).

## Accessibility

The UI aims at WCAG 2.1 AA: full keyboard operation, visible focus rings in both themes, dialog focus trap and restore, labelled controls and landmarks, a polite status region for streaming and errors, contrast checked by `tests/contrast.test.mjs`, `prefers-reduced-motion` support and 24px hit areas. Details: [accessibility](docs/features/accessibility.md). Known gaps: it was reviewed from code and unit tests only (no VoiceOver or axe run in the app yet); native checkboxes are 16px; a very light custom accent can be low contrast outside the focus ring; dragging chats into sections is mouse only (the chat menu is the keyboard route); canvas artifacts and model-written Markdown are shown as given.

## Install and development

Requirements: Node (version in `.nvmrc`), the Rust toolchain and the Tauri 2 prerequisites for your OS. The app is developed on macOS; see [Platforms](#platforms) for Windows and Linux.

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

M Code is developed and used on **macOS**; that is the only platform on which it has been run by hand. Windows and Linux support is code-complete in the places listed below but **has never been built, launched or smoke-tested on a Windows or Linux machine**. Treat those builds as experimental.

| Area | macOS | Windows | Linux |
| --- | --- | --- | --- |
| API keys | Keychain (`security-framework`) | Credential Manager (`keyring`) | Secret Service via D-Bus (`keyring`; needs GNOME Keyring or KWallet running) |
| Shell for `run_command` and CLI providers | login `zsh` | Windows PowerShell 5.1 | login `bash` (`sh` as the Rust-side fallback) |
| Window | overlay title bar, in-app header drags the window | native title bar | native title bar |
| Installers (`tauri build`) | `.app`, `.dmg` | NSIS `.exe`, `.msi` | `.deb`, `.rpm`, AppImage |
| Shortcuts | `⌘` | `Ctrl` (global stop: `Ctrl+Alt+Shift+Esc`) | `Ctrl` |
| Computer Use | supported (Accessibility and Screen Recording permissions) | screenshots and input only; no permission prompts; `open_app` unsupported | X11 only: a pure Wayland session is reported unsupported; `open_app` uses `gtk-launch` |

What is **not** verified outside macOS:

- Nothing beyond CI compiles and tests it: the matrix in `.github/workflows/ci.yml` runs `npm run check` (i18n, `tsc`, Node tests, `cargo test`) on `macos-latest`, `windows-latest` and `ubuntu-latest`, but no installer is built there and no UI is run. Whether those jobs pass on a fresh machine has not been observed from here.
- The Tauri bundle configuration (`tauri.windows.conf.json`, `tauri.linux.conf.json`), the shell capabilities (`capabilities/shell-*.json`) and installer output are untested. The Linux system packages in the CI file are a best guess (WebKitGTK, D-Bus, X11, PipeWire).
- CLI providers (Claude Code, Codex, Cursor Agent) on Windows: discovery looks on `PATH` and in the npm global directory, and the exact install locations of the Windows CLIs are assumed. A `.cmd` shim receives the prompt on stdin rather than as an argument (so `cmd.exe` cannot interpret it); that relies on `claude -p` and `codex exec` reading stdin and is unverified. The Cursor/Codex Node sidecars may not be able to start a `.cmd` shim.
- The Windows `run_command` captures stdout and stderr separately and appends stderr, so their order is not interleaved; killing a timed-out command may leave child processes running.
- Importing history: Cursor's database is looked up in the OS config directory and Claude Code's in `~/.claude`, `%USERPROFILE%\.claude`, `CLAUDE_CONFIG_DIR` or `$XDG_CONFIG_HOME/claude`; none of these paths have been checked against real installations outside macOS.
- Rust tests that need symlinks or POSIX hooks are skipped on Windows (`#[cfg(unix)]`); the others avoid hard-coded `/` paths but have not been run there.
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
apps/mobile/              placeholder for the planned React Native (Expo) companion app
packages/protocol/        @mcode/protocol: protocol version and API/WebSocket event types (pure TypeScript)
docs/                     Architecture and per-feature documentation
```

Paths elsewhere in the documentation (`src/...`, `src-tauri/...`, `tests/...`, `sidecar/...`) are relative to `apps/desktop/`. Layers, data flow and the role of every module are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The backlog is in [TASKS.md](TASKS.md).

## Security

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

- API providers run M Code's own tool loop (read, edit, search, shell, MCP, subagents, Computer Use where the model supports it); CLI providers run their own tools in the project folder and are streamed through the shell plugin.
- The model list comes from each provider; context windows and image/tool capabilities are shown when the provider reports them and are unknown otherwise.
- Sign-in is verified by a small test request or a successful chat response, not by listing models. Transient API failures are retried with backoff before any text reaches the chat ([streaming robustness](docs/features/chat.md#streaming-robustness)).
- Subscription windows (Codex, Claude Code) and token usage: [usage and budgets](docs/features/usage-and-budgets.md). Which model hosts subagents, compaction and commit messages: [agents](docs/features/agents.md).
- Image attachments work with CLI providers too (written to a temporary folder per chat, see [files and git](docs/features/files-and-git.md)).
