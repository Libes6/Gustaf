# Changelog

All notable user-visible changes to Gustaf are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Gustaf was previously developed as M Code.

## [Unreleased]

## [0.1.0] - 2026-10-04

First public release. Installers: macOS (Apple Silicon and Intel, DMG), Windows x64 (NSIS and MSI), Linux x64 (AppImage, DEB, RPM). See the [README](README.md#install) for installation.

### Added

#### Chat and providers

- Providers: Anthropic, OpenAI, Gemini, OpenRouter, any OpenAI-compatible endpoint, Ollama and LM Studio (detected locally), Cursor (SDK), and the Codex, Claude Code and Cursor Agent CLIs with their own sign-in.
- Model picker per chat, Ask / Plan / Agent modes with a plan card (Approve, Edit, Reject).
- Streaming with automatic retries for transient errors, Stop, Retry and resume of interrupted requests; classified errors (rate limit, quota, auth, network, server).
- Message actions: edit and resend, regenerate, delete, branch into a new chat.
- Queue follow-up messages and clarify an active task; shared per-chat coordination for interactive and scheduled runs.
- Linked chat branches with independent histories and provider/session context handling.
- Attach another chat as reference context through the composer, with a frozen snapshot.
- Compare 2-4 models side by side on one prompt.
- Drafts (text and images) restored after a restart; image attachments (also for CLI providers); paste or take a screenshot; voice input through an OpenAI-compatible transcription model.
- Cursor account pool with browser-login profiles and rotation when a quota runs out.
- Light, dark and system themes, accent colour, keyboard shortcuts, English and Russian UI, accessibility work toward WCAG 2.1 AA.

#### Agents and multi-agent

- Subagents (`explore`, `plan`, `review`, `general`) for API providers, with per-type models, budgets (steps, tool calls, time, tokens) and a concurrency limit; multi-task plans with dependencies and retries.
- Background tasks column with live cards, transcripts, Stop and "Continue this agent"; also shows the native subagents of Codex and Claude Code.
- Scheduled prompts that run while the app is open, with capped access and approval cards.
- System notifications and dock badge for finished runs and pending approvals.

#### Code review and git

- The agent edits a shadow copy of the project; review per file or per hunk, comment on hunks and send the feedback to the agent, AI review of pending diffs.
- Shadow-copy setup: linked directories, setup command and a "Run tests" button.
- Commit accepted files with a generated or hand-written message, push the current branch (never forced; protected branches ask first) and create a pull request with `gh`.
- Checkpoints with rollback, and Undo for individual file edits in the action log.

#### Tools: MCP, web, terminal, LSP, memory, skills

- Command rules (allow / ask / deny, global or per project) with built-in protections, tool approvals and an action log.
- Project instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules`) and per-project custom instructions.
- MCP servers over stdio and streamable HTTP: tools, resources, prompts, OAuth sign-in, secrets in the OS credential store.
- Web search (Brave API) and web fetch with domain rules; semantic search over a project index (Ollama or a compatible embeddings endpoint).
- Integrated terminal in the changes panel; "Open command in terminal" from tool cards; approved `read_terminal` for the agent.
- Diagnostics through a project check command or LSP (bundled TypeScript language server; rust-analyzer and Python servers if installed).
- Memory: global and per-project facts added to prompts, editable in Settings.
- Skills and slash commands (`/review`, `/test`, `/explain`, `/commit`, plus `SKILL.md` and command files from the project and home folders).
- Dev-server Preview tab in the changes panel.

#### Canvas

- Interactive React/TSX canvas cards in a sandboxed iframe: Result, Code and Changes tabs, revisions, multi-file artifacts, `lucide-react` icons, restart, export as TSX or standalone HTML.

#### Computer Use

- Desktop control for every provider with screenshot verification after each batch and per-action approval for risky steps (macOS fully; Windows screenshots and input only; Linux X11 only).

#### Search, import and export

- Cmd+K full-text search across all chats, with project and model filters.
- Export chats as Markdown or JSON (secrets scrubbed best effort), share a chat as a self-contained HTML file, import JSON exports.
- Import history from Claude Code, Codex, ChatGPT and Cursor.

#### Settings and updates

- Usage telemetry from provider-reported tokens, Codex and Claude subscription windows, daily and per-chat token budgets with a warning banner.
- Raw CLI event capture for debugging (off by default).
- Signed in-app updates from GitHub Releases: update icon in the rail, one-click download, signature check and restart; manual check in Settings (AppImage only on Linux).
- API keys stored in the macOS Keychain, Windows Credential Manager or Linux Secret Service; strict webview CSP and narrowed Tauri capabilities.

### Known limitations

- The macOS app is ad-hoc signed only (no Apple Developer ID, not notarized): the first launch needs System Settings → Privacy & Security → Open Anyway, and the Keychain may ask again after updates. Windows installers are not Authenticode signed (SmartScreen warning).
- Windows and Linux builds are compiled, tested and bundled in CI but have not been installed or launched by hand. CLI provider discovery and the sidecar on Windows are unverified.
- An installed-app update from an older to a newer version has not yet been completed on real devices on every platform.
- Many features are covered by unit, component and browser tests but were not smoke-tested in the running app, among them MCP (OAuth only against fakes), push and pull requests (not run against GitHub), scheduled prompts, Plan mode flags for the real CLIs, live Codex multi-agent cards and Computer Use timing.
- Linux: built on Ubuntu 24.04, older glibc distributions are not supported; DEB and RPM do not update in the app; saving keys needs a running Secret Service keyring; Computer Use needs X11.
- No Windows ARM, Linux ARM, Flatpak, Snap or package-repository builds.
- Budgets count tokens only; no cost is estimated.
- Accessibility was reviewed from code and tests only (no VoiceOver or axe run in the app).
- The canvas needs `'unsafe-eval'` in the app CSP, and a runaway canvas loop can still freeze its renderer.
- The mobile companion app is a skeleton and is not shipped.

[Unreleased]: https://github.com/Libes6/Gustaf/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Libes6/Gustaf/releases/tag/v0.1.0
