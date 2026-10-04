# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately**, not in a public issue, pull request or discussion.

- Use GitHub's private vulnerability reporting: [Report a vulnerability](https://github.com/Libes6/Gustaf/security/advisories/new) (repository **Security** tab → **Advisories** → **Report a vulnerability**).
- Include the Gustaf version (Settings → General) or commit, your OS and architecture, the provider involved, steps to reproduce and the impact you expect. Remove real API keys and tokens from anything you send.

This is a small project maintained in spare time. Expect an acknowledgement within about a week; a fix ships in a new release, and the advisory is published after that release is available. Please give us a reasonable time to fix the issue before disclosing it.

## Supported versions

Only the **latest published release** receives security fixes. Older versions are not patched; update through the in-app updater or by installing the latest release. Builds from `dev` or from source are not supported releases.

At the time of writing no release has been published yet (see [docs/release.md](docs/release.md)).

## What Gustaf stores and where

Gustaf is a local desktop app with no account and no server of its own. It does not collect analytics or telemetry.

| Data | Where |
| --- | --- |
| API keys of model providers, secret MCP env values and headers, MCP OAuth tokens, the Brave search key | The OS credential store, never the database: macOS Keychain, Windows Credential Manager, Secret Service on Linux (GNOME Keyring or KWallet), under the service name `com.maksimkulakov.mcode` |
| Chats, messages, drafts, settings, projects, agent runs, action log | Local SQLite database `app.db` in the app data folder |
| Review (shadow) copies of projects, checkpoints, semantic-search cache, Cursor login profiles | Subfolders of the app data folder |
| Image attachments for CLI providers | `<app data>/attachments/<chat id>/`, removed when the reply ends |
| Raw CLI event logs | `<app data>/raw-cli/`, **only** when Settings → General → Developer → "Record raw CLI events" is switched on (off by default); secrets are scrubbed best effort, at most 5 MB in total |

The app data folder is `~/Library/Application Support/com.maksimkulakov.mcode` on macOS, `%APPDATA%\com.maksimkulakov.mcode` on Windows and `~/.local/share/com.maksimkulakov.mcode` on Linux. The identifier keeps the project's earlier name (M Code) so upgrades keep existing data.

Data on disk is not encrypted by Gustaf beyond what the OS credential store provides. Anyone with access to your user account can read the database.

## What leaves your machine

Gustaf sends data only to services you configure or explicitly use:

- **Model providers** you add (API, local or CLI): your messages, attached images and files, project instruction files (`AGENTS.md`, `CLAUDE.md`, ...), memory facts, tool results and, for AI review, commit messages and PR descriptions, bounded diffs. Local providers (Ollama, LM Studio) stay on your network.
- **CLI providers** (Codex, Claude Code, Cursor Agent) run as separate programs with their own sign-in, tools, network access and MCP configuration; Gustaf does not control what they send.
- **Optional tools**, only when enabled: MCP servers you connect, web search (Brave API) and web fetch, an embeddings endpoint for semantic search, a transcription provider for voice input, and `git push` / `gh pr create` when you click them.
- **Update check**: release builds fetch `latest.json` from this repository's GitHub Releases once at startup and when you check manually. Downloaded updates are installed only after their signature is verified against the public key built into the app.

Exported chats and shared HTML files are written only where you save them; secrets in them are scrubbed best effort, so review a file before sharing it.

## Security design

The webview runs under a strict Content Security Policy with narrowed Tauri capabilities; agent shell commands go through approval and allow/ask/deny rules; project edits happen in a review copy that you accept per file or hunk. These are guardrails, not an OS sandbox. Details and known trade-offs (for example `'unsafe-eval'` for the canvas): [docs/features/security.md](docs/features/security.md), [docs/features/rules-and-instructions.md](docs/features/rules-and-instructions.md), [docs/features/files-and-git.md](docs/features/files-and-git.md).

Release installers carry signed updater payloads, but the macOS app is not signed with an Apple Developer ID or notarized, and the Windows installers are not Authenticode signed. Download Gustaf only from [GitHub Releases](https://github.com/Libes6/Gustaf/releases).
