# Skills, memory, terminal and diagnostics

Desktop code lives in `apps/desktop`.

Skills are Markdown workflows in `~/.gustaf/skills/<name>/SKILL.md` or `<project>/.gustaf/skills/<name>/SKILL.md`. Compatible Claude skills and Cursor commands are discovered too. A project workflow wins over a global name. Type `/` in the composer to choose a workflow and append arguments. Skills supply instructions; they never grant additional access. Built-ins: `/review`, `/test`, `/explain`, `/commit` (commit preparation requires explicit authorization before committing).

Settings → Memory stores selected facts globally or per project, also reachable from a project's menu ("Memory…"). Relevant facts are inserted into subsequent model prompts with a size limit; this sends them to the selected provider. Facts can be added by hand, by the model (`remember` / `forget`, with confirmation by default) or from a chat's "Suggest memories" action (one extra model request, confirmation required), and exported to a managed section of the project's `AGENTS.md`. Details: [memory](features/memory.md). Do not put credentials into facts.

A project chat's changes panel includes Terminal. Open it explicitly to start the platform shell, add tabs, resize, use Ctrl-C, or send selected output to the chat. In a review workspace, cwd is the review copy. Closing the tab or app terminates its session. Tool cards can stage a command in the terminal; press Run to execute it. The API agent can request bounded terminal output with `read_terminal`; every read requires approval, including full-access mode. It cannot write to the PTY.

Settings → Git and commands → Diagnostics configures a project command. Detection proposes an existing typecheck/lint script or an installed TypeScript binary; it does not install dependencies. Enable checking after API file edits, or ask the agent to call `diagnostics`. Checks use the current workspace and the same command permission rules as ordinary commands. Failed/declined checks are reported alongside the successful edit. Native CLI providers receive a check instruction and must execute it through their own tools; this is not enforced by the API edit wrapper.

Computer Use result data includes time spent in actions, settling, capture, encoding and macOS Accessibility lookup. Accessibility labels are bounded untrusted context, not actionable permissions. Compare total task time and successful tasks on the actual Mac before claiming a speed increase.

Release provisioning and platform checks: [release.md](release.md).


## Screenshots, search and preview

Paste an image into the composer or choose Take screenshot from the plus menu. Captures become ordinary attachments, with model image support checked before sending.

Settings → General → Web enables `web_search` (Brave API key in Keychain) and `web_fetch` for API agents. Domain allow/deny rules apply to redirects too; private networks are blocked. Results are untrusted context. Ask/Plan modes do not use these tools.

Settings → Git and commands → Semantic search enables indexing for a project. Choose local Ollama or a compatible embeddings endpoint/model. Cloud indexing sends source chunks to that provider. The private incremental JSON cache respects ignored/generated/sensitive files. Configure the model before building the index; then the API agent can use `semantic_search`.

The changes panel's Preview tab starts an explicitly configured dev command and displays a loopback page, process logs and console errors. Stop terminates the process. Use Reload after changes: WebSocket HMR is not supported by this proxy. Instrumentation removes the page's original CSP/frame headers inside the isolated preview.

Diagnostics also offers LSP checks with file, line, range, severity and code. TypeScript's language server is bundled; Node must be installed. Rust/Python need their language server installed. Each check is bounded and terminates its server. The API agent requests permission before server launch; unavailable/timed-out LSP can fall back to the configured command, through command permissions. File navigation is bound to the trusted project/review workspace.
