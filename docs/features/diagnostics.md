# Diagnostics and user-operated terminal integration

## LSP diagnostics

Settings → Git and commands → Diagnostics lets each project choose its existing check command or LSP with that command as fallback. Existing settings remain command-based. Automatic diagnostics remain opt-in. The LSP tool accepts a relative file path; after edits it checks the edited file in the review workspace. Launching a server requires the agent's normal explicit command approval, even for read-only analysis: language servers may run project build scripts. Declining approval does not launch a fallback command.

The shipped sidecar includes `typescript-language-server` and a compatible TypeScript 6 `tsserver.js`. An installed Node runtime is required; PATH, Homebrew and nvm installations are searched. TypeScript 7 removed the classic tsserver used by this adapter, so the bundled server stays on TypeScript 6; project compiler/check-command results remain authoritative for version-specific behavior. A project/global TypeScript language-server executable takes precedence over the shipped fallback.

Rust uses an installed `rust-analyzer`; Python uses `basedpyright-langserver`, `pyright-langserver`, or `pylsp`. Nothing is installed automatically. A rustup shim is not proof the component is installed; launch failures are reported and a configured command can be used as fallback. For a manual check in Settings, enter a root-relative file path and explicitly click Run LSP file check.

The native client uses real stdio JSON-RPC with Content-Length framing: initialize, initialized, didOpen, workspace configuration replies, publishDiagnostics, shutdown, and exit. Checks are bounded by the configured deadline and input/output limits. Every check owns a bounded server process group and cleans it up on success/failure/timeout; there is no persistent daemon. This favors predictable cleanup over warm-server latency. A future persistent session cache can improve repeated checks.

Diagnostics carry relative file paths, 1-based lines, UTF-16 columns, ranges, severity, code, source, and message. Tool cards show diagnostics and allow inspecting the relevant source lines in the same workspace that produced the report. An empty published snapshot is not proof that all analysis or project tests passed. Unsupported file types, absent servers, startup errors, and timeouts remain explicit rather than becoming a fake clean result.

## Terminal commands and reading output

Tool cards for shell commands offer Open command in terminal. Clicking it opens a new terminal tab with the command preview and the visible working directory. The shell does not receive the command until the user clicks Run command. Review workspaces remain the default terminal directory while pending reviews exist; the preview always shows the actual directory. This is a user-operated action, not an agent shell-write tool.

The model can request `read_terminal`. Each request—including listing terminal IDs—requires explicit approval because terminal output can contain secrets. Output is scoped to the run's canonical workspace root. It is a text transcript, not an emulation of the current terminal screen. ANSI/OSC control sequences are removed, requests are capped at 500 lines / 30,000 characters, and native memory is bounded to 1 MiB per transcript / 32 transcripts (active PTYs remain capped at 16). Closed transcripts can remain until evicted or the app quits; output is not persisted to disk.

The model cannot send PTY input, create PTYs, or bypass command rules using this read tool. Terminal output remains untrusted data. Existing selection-to-chat behavior is preserved.
