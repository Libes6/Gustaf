# M Code documentation

- [Architecture](ARCHITECTURE.md): code layout (frontend, Rust backend, sidecar), key flows and conventions.
- [Tasks](../TASKS.md): roadmap and backlog.

Code paths in these documents are relative to `apps/desktop/` (see the note at the top of the architecture page).

## Features

Behaviour, design decisions and test pointers per feature. The [project README](../README.md) has setup and an overview.

| Area | Page | Covers |
| --- | --- | --- |
| Chat | [chat.md](features/chat.md) | Chat sessions and drafts, provider sign-in checks, streaming robustness and retries, message actions and branching, model comparison, theme and shortcuts |
| Chat | [search.md](features/search.md) | Cmd+K full-text search across all chats |
| Chat | [canvas.md](features/canvas.md) | Interactive TSX canvas, sandbox, verification |
| Platform | [security.md](features/security.md) | Webview CSP, Tauri capabilities, canvas versus CSP inheritance, manual checklist |
| Providers | [usage-and-budgets.md](features/usage-and-budgets.md) | Token and subscription-limit telemetry, daily and per-chat budgets |
| Data | [import-export.md](features/import-export.md) | Export and import of chats, import from Claude Code, Codex and ChatGPT |
| Agent | [rules-and-instructions.md](features/rules-and-instructions.md) | Command rules and action log, project instruction files |
| Agent | [files-and-git.md](features/files-and-git.md) | Actions and context, file review in a shadow copy, setup and tests, partial accept, committing accepted changes |
| Agent | [agents.md](features/agents.md) | Subagents, background agents, multi-agent orchestration |
| Agent | [mcp.md](features/mcp.md) | MCP servers |
| Providers | [cursor-accounts.md](features/cursor-accounts.md) | Cursor account pool, browser-login profiles, quota rotation |
| Agent | [scheduled-prompts.md](features/scheduled-prompts.md) | Prompts that run on a schedule while the app is open |
| Agent | [computer-use.md](features/computer-use.md) | Computer Use (desktop control) |
| UI | [accessibility.md](features/accessibility.md) | Keyboard, focus, semantics, contrast, motion and target size; regression tests; known gaps |
