# M Code

Desktop AI chat and coding assistant built with Tauri 2, React and TypeScript. It talks to hosted model APIs, local models and the Codex, Claude Code and Cursor command-line agents from one window, and can edit your projects in a reviewable copy.

## Features

- **Chat with many providers**: switch models per chat, compare 2-4 models side by side, retry and resume interrupted requests ([chat](docs/features/chat.md)).
- **Full-text search** across every message, Cmd+K ([search](docs/features/search.md)).
- **Interactive canvas**: assistant-written React/TSX previews in a sandbox, with revisions ([canvas](docs/features/canvas.md)).
- **Safe project edits**: the agent works in a shadow copy; you review per file or per hunk, run tests there, then commit only what you accepted ([files and git](docs/features/files-and-git.md)).
- **Command rules and action log**: allow/ask/deny rules for shell commands, project instruction files (`AGENTS.md`, `CLAUDE.md`, ...) ([rules](docs/features/rules-and-instructions.md)).
- **Subagents and MCP servers** for API providers, with budgets and background runs ([agents](docs/features/agents.md), [MCP](docs/features/mcp.md)), plus [scheduled prompts](docs/features/scheduled-prompts.md).
- **Computer Use**: desktop control with per-action approval ([computer use](docs/features/computer-use.md)).
- **Usage telemetry and budgets**: token counts, subscription windows, daily and per-chat limits ([usage](docs/features/usage-and-budgets.md)).
- **Hardened webview**: strict CSP and narrowed Tauri capabilities ([security](docs/features/security.md)).
- **Import and export**: chats as JSON or Markdown, history from Claude Code, Codex, ChatGPT and Cursor ([import and export](docs/features/import-export.md)).

All feature pages are indexed in [docs/README.md](docs/README.md).

## Install and development

Requirements: Node (version in `.nvmrc`), the Rust toolchain and the Tauri 2 prerequisites for your OS. The app is developed on macOS (Computer Use and the CI run there).

```sh
npm install
npm --prefix sidecar ci      # Node helpers launched by the app
npm run tauri dev            # native app with hot reload
```

`npm run dev` serves only the frontend; normal chats need the native Tauri backend. `npm run build` type-checks and builds the frontend. The canvas runtime (`src/canvas/generated` and `public/canvas`, git-ignored) is built by `scripts/build-canvas.mjs` from the `predev` and `prebuild` hooks; run it by hand if you only run tests.

### Verification

```sh
npm run check        # i18n keys, tsc, node tests, UI tests, cargo test (what CI runs)
```

The steps of `npm run check` can be run separately:

```sh
node scripts/check-i18n.mjs                               # translations
npx tsc --noEmit                                          # types (src and tests/ui)
npm test                                                  # node --test tests/*.test.mjs (pure logic)
npm run test:ui                                           # Vitest + Testing Library component tests in tests/ui
cargo test --manifest-path src-tauri/Cargo.toml           # Rust
```

Focused node suites: `npm run test:chat`, `test:canvas`, `test:usage`, `test:cli`. Before a release, also `npm run tauri build -- --debug --bundles app`.

## Project structure

```text
src/            React UI: components/, lib/ (data, api, chat logic), providers/ (model backends),
                agent/ (tool loop, rules, subagents, MCP), canvas/, i18n/
src-tauri/src/  Rust backend: SQLite, files and shell, review copy, git, secrets, computer use, MCP
sidecar/        Node helpers (Codex limits, Cursor agent)
tests/          node:test suites (*.test.mjs) and tests/ui (Vitest component tests)
docs/           Architecture and per-feature documentation
```

Layers, data flow and the role of every module are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The backlog is in [TASKS.md](TASKS.md).

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
