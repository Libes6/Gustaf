# Gustaf documentation

- [Architecture](ARCHITECTURE.md): code layout (frontend, Rust backend, sidecar), key flows and conventions.
- [Releases](release.md): release pipeline, signing and update settings; [release checklist](release-checklist.md): manual smoke test of the built installers before publishing.
- [Local macOS update test](updater-smoke.md).
- [Contributing](../CONTRIBUTING.md), [security policy](../SECURITY.md) and [changelog](../CHANGELOG.md).

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
| Agent | [files-and-git.md](features/files-and-git.md) | Actions and context, file review in a shadow copy (an opt-in setting; off by default), setup and tests, partial accept, AI review (manual and automatic, `.gustaf/REVIEW.md` rules), committing accepted changes |
| Agent | [workspaces.md](features/workspaces.md) | One git worktree per task: New workspace, composer option, sidebar rows, archive, changes and commit in the worktree |
| Agent | [agents.md](features/agents.md) | Subagents, background agents, multi-agent orchestration |
| Agent | [plan-mode.md](features/plan-mode.md) | Ask / Plan / Agent mode switch, plan card with Approve / Edit / Reject, CLI plan flags |
| Agent | [mcp.md](features/mcp.md) | MCP servers |
| Agent | [skills.md](features/skills.md) | Skills and slash commands |
| Agent | [diagnostics.md](features/diagnostics.md) | LSP diagnostics, terminal commands and `read_terminal` |
| Agent | [memory.md](features/memory.md) | Saved facts: what is stored where, what is sent to the provider, project menu editor, suggest memories from a chat, export to AGENTS.md |
| Agent | [agent-workflows.md](agent-workflows.md) | Skills, memory, terminal, diagnostics, web tools, semantic search, preview |
| Agent | [hooks.md](features/hooks.md) | Hooks: user commands on agent events (pre/post tool, post edit, stop, approval request), schema, exit codes, safety |
| Providers | [antigravity.md](features/antigravity.md) | Antigravity (Google ACP agent): manual install, sign-in methods, ACP client, limits, manual checks |
| Providers | [cursor-accounts.md](features/cursor-accounts.md) | Cursor account pool, browser-login profiles, quota rotation |
| Agent | [scheduled-prompts.md](features/scheduled-prompts.md) | Prompts that run on a schedule while the app is open |
| Agent | [computer-use.md](features/computer-use.md) | Computer Use (desktop control) |
| UI | [accessibility.md](features/accessibility.md) | Keyboard, focus, semantics, contrast, motion and target size; regression tests; known gaps |
| Agent | [merge-queue.md](features/merge-queue.md) | Early conflict detection (`git merge-tree`) and a merge queue for workspace worktrees: strategies, test hand-off, halting, state and locking; UI and conflict resolver not built |
| Mobile | [mobile-server.md](features/mobile-server.md) | Mobile companion server (read-only slice): LAN-only HTTPS + WebSocket, QR pairing, device tokens, threat model, what is not covered |
| Agent | [verification-gates.md](features/verification-gates.md) | Verification gates: per-project required checks (definition of done) run when an agent stops after editing files, fix loop, kill criteria, project `.gustaf/done.json` switch |
| UI | [quick-ask.md](features/quick-ask.md) | Quick ask window: a global shortcut (off by default) opens a small always-on-top window with a streamed answer from the default model; Open in Gustaf stores it as a chat; clipboard option, capability, what could not be verified |
| Agent | [knowledge-base.md](features/knowledge-base.md) | Knowledge collections of folders, PDFs, Markdown and text: embeddings index in app data, per-chat selection, `knowledge_search` tool with citations, privacy and what is not done |
