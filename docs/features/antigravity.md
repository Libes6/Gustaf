# Antigravity (Google's ACP agent)

Gustaf runs Google's official **Antigravity ACP agent** (`agy_acp_server`) as a provider. It speaks the Agent Client
Protocol ([agentclientprotocol.com](https://agentclientprotocol.com)): JSON-RPC 2.0, one JSON object per line, over the
agent's stdio. Like Claude Code and Codex it runs its own tools in the project folder; Gustaf relays text, tool cards and
approvals. The agent has its **own Google sign-in**, separate from the Antigravity IDE or CLI.

**Status: built and tested against a synthetic ACP agent only.** The real binary is proprietary and was never downloaded
or run for this work. Everything below marked "not verified" needs the manual steps at the end.

## What works

- Provider "Antigravity" in Settings, Model providers (Add provider, tile "Antigravity"; one provider per Google account).
- Settings page: binary path, sign-in method (Google account, Gemini Enterprise, Gemini API key, Agent Platform / Vertex
  AI), API key (system Keychain), GCP project and location, runtime status (an `initialize`-only probe), Sign in / Sign out.
- A live session per chat (one agent process, one ACP session; reused by the next turn, released when idle for 30 min).
- Streaming answer text, tool calls as cards (`shell`, `read`, `edit`, `search`, `web_fetch`, others by title), plans as a
  checklist card. Thoughts are dropped, like those of the other providers.
- Approvals: `session/request_permission` becomes Gustaf's approval card (command kind; title as the command, detail as the
  reason). Only "allow once" and "reject once" are ever chosen, never "allow always". Read-only access and Plan/Ask chats
  deny, Full access allows, a missing approver denies. Native agent questions (`interaction_*` ids, options that are not
  allow/reject) cannot be shown as an approval and are answered "cancelled".
- Stop: `session/cancel`, the turn keeps its partial output (`interrupted`), the process is killed only if the agent does not
  end the prompt within 5 s. A message sent while a turn runs (follow-up mode "restart"): the running prompt is cancelled
  softly and the message is sent next on the same live session (ACP has no steer).
- Resume after restart: `session/resume` (or `session/load` with the history replay muted); if the agent no longer knows the
  session, a new one starts and the history is replayed as text.
- Models from the session's `model` config option (legacy `models` block as fallback), reasoning levels from a
  `thought_level` option if the agent has one. Token usage when the prompt result reports it.
- Images are sent as ACP image blocks when the agent advertises `promptCapabilities.image`.

## Install (manual)

Managed download is **not** implemented yet (the Install button is disabled; `providers/antigravityRuntime.ts` holds the
seam: version 1.3.0, about 317 MB for darwin-aarch64, `installRuntime(onProgress)`).

1. Download the archive for your platform from the official ACP registry entry `antigravity-acp`
   (github.com/agentclientprotocol/registry). Check the download is from `dl.google.com`.
2. Extract it. Keep the ACP executable (`agy_acp_server`, `.par` on macOS and Linux, `.exe` on Windows) and its
   `localharness_external` helper in the same folder. `chmod +x` both on macOS and Linux.
3. In Settings, Model providers, Antigravity: set **Binary path** to the executable, or leave it empty to use
   `agy_acp_server` (or `agy_acp_server.par`) from the login-shell PATH.

## Sign-in methods

| Method | Needs | Notes |
| --- | --- | --- |
| Google account | nothing | Browser sign-in; uses your subscription |
| Gemini Enterprise | GCP project and location | Browser sign-in |
| Gemini API key | API key | Billed by usage; no browser |
| Agent Platform (Vertex AI) | API key, or GCP project and location | Billed by usage |

**Sign in** runs `authenticate` with the method. For the browser methods the agent reports a Google authorization link. Gustaf
accepts only `https://accounts.google.com/o/oauth2/v2/auth` links with `response_type=code`, a `state` and a
`redirect_uri` of `http://127.0.0.1:<port>/` (the agent's own listener; on the same machine the redirect lands there, so no
callback forwarding is needed), opens it in the OS browser and shows "Waiting for browser sign-in" with Cancel and a
5-minute limit. Cancel or timeout stops the agent process (which closes its listener). Any other link is ignored.
The link is read from the agent's own stdout/stderr line and from a `BROWSER` helper Gustaf sets so the agent never opens
a browser itself (POSIX only). **Sign out** sends the agent's `logout` request when it has one and deletes the provider's
private profile folder.

The sign-in state lives in a private folder per provider (`<app data>/antigravity-profiles/<id>/home`, passed as
`GEMINI_HOME`; `tmp/` beside it is the agent's unpack folder). The API key is stored in the Keychain
(`provider:<id>`), read at first use and handed to the agent only in its environment (never in a script, URL, log or
setting). The user's own `GEMINI_API_KEY`, `GOOGLE_*` credential variables are unset before launch so they cannot override
the chosen method. Errors shown in the UI are scrubbed of the key.

A background check never signs in: the status probe runs only `initialize`; listing models or running a turn without a
saved sign-in fails with "Sign in to Antigravity in Settings".

## Design (for developers)

| Piece | File |
| --- | --- |
| JSON-RPC plumbing, typed `AcpError`, timeouts, defensive classification | `src/providers/acp/rpc.ts` |
| ACP client (initialize, authenticate, session new/load/resume, prompt, cancel, permission and fs requests) | `src/providers/acp/client.ts` |
| `session/update` to text, cards, plan | `src/providers/acp/updates.ts` |
| Project-root confinement of `fs/*` | `src/providers/acp/fsPolicy.ts` |
| Launch script/env, sign-in link check, settings, models | `src/providers/antigravitySupport.ts` |
| Live session, turn, probe, sign in/out (Tauri-free) | `src/providers/antigravitySession.ts` |
| Tauri glue: process host, profile, Keychain, opener, adapter | `src/providers/antigravity.ts` |
| Install seam | `src/providers/antigravityRuntime.ts` |
| Private profile folders | `src-tauri/src/antigravity_profile.rs` |
| Settings UI | `src/components/AntigravitySettings.tsx` |

The ACP client is generic (the agent is injected as a `Duplex`); another ACP agent (Gemini CLI...) needs a launch command
and an adapter like `antigravity.ts`. The client advertises `terminal: false` and answers `terminal/*` with "method not
found". `fs/read_text_file` / `fs/write_text_file` are implemented and confined to the project root (lexical check here,
real-path check in the Rust file tools), but the adapter does **not** enable them: the existing `fs_read` returns
line-numbered text, not raw content, and the agent works fine with its own file tools. Adapted from T3 Code (MIT,
github.com/pingdotgg/t3code); attribution headers are in the files.

## Protocol generations (ACP v1 and v2)

Agents in the wild mix two generations of the protocol (Antigravity reports `protocolVersion: 2` with the v1 answer shape,
as T3 Code notes). The client sends one `initialize` carrying both generations' fields (`protocolVersion: 2`, `info`,
`capabilities` and `clientCapabilities`, `clientInfo`) and decides the generation from the **shape** of the answer: `info`
present means v2, `agentInfo` means v1, whatever the number says. Differences, v1 to v2, all normalised inside
`providers/acp/` so the session code does not care:

| Area | v1 | v2 draft |
| --- | --- | --- |
| initialize answer | `agentInfo`, `agentCapabilities`, `authMethods[].id` | `info`, `capabilities.session`, `authMethods[].methodId` |
| sign in / out | `authenticate`, `logout` | `auth/login`, `auth/logout` |
| continue a session | `session/load` (replays history) or `session/resume` | only `session/resume` (`replayFrom: {type: "start"}` to replay) |
| config options | `id` | `configId`; `session/set_config_option` needs `type: "id"` |
| prompt | the response carries `stopReason` and `usage` | the response only acknowledges; the end is a `state_update` idle notification with `stopReason` and `usage` |
| tool calls | `tool_call` then `tool_call_update` | `tool_call_update` (with `name`) plus `tool_call_content_chunk` |
| plan | `plan` with `entries` | `plan_update` with `plan: {type: "items", entries}` |
| messages | chunks | chunks and a final whole `agent_message` (shown only if no chunk of it was) |
| permission request | `toolCall` | `title`, `description`, `subject` (`tool_call` or `command`) |
| model / mode | `session/set_model`, `session/set_mode` | removed (method not found) |

Cancel is the same `session/cancel` notification in both. Both generations are exercised **only against synthetic
fixtures** modelled on T3 Code's effect-acp schemas (`tests/helpers/fakeAcp.mjs`, `tests/acpClient.test.mjs`), including a
v2-numbered but v1-shaped initialize answer; no real agent was run.

## Limits

- No managed install or update; manual install only.
- No terminal capability, no conversation rewind (editing an earlier message starts a new agent session with the history as text).
- Subagent activity appears as ordinary tool cards; Antigravity cannot be used for Gustaf subagents.
- Native agent questions are cancelled; "allow always" is never chosen; no `session/set_mode` (permissions are decided by Gustaf).
- Windows sign-in link capture relies on the agent's own line only (no `BROWSER` helper); Windows and Linux are untested.
- A force-killed agent can leave its unpacked temp folder (about 1 GB) in `<app data>/antigravity-profiles/<id>/tmp`; Sign out or deleting the provider removes it.
- "Always allow" on the approval card adds the action title to the command allowlist text; it does not widen what the agent may do.

## Verified and not verified

Verified (automated): the ACP client against a synthetic agent (`tests/acpClient.test.mjs`), the session, sign-in, probe,
Stop, follow-up, resume and permission flows (`tests/antigravitySession.test.mjs`), launch/link/settings helpers
(`tests/antigravitySupport.test.mjs`), the settings UI with a fake adapter (`tests/ui/AntigravitySettings.test.tsx`), the
profile folders in Rust. Fixtures are synthetic, written from the public ACP spec and T3 Code's schemas.

Not verified: everything with the real `agy_acp_server`: its actual `initialize` answer (protocol version, auth method
ids, `resume` support), the exact sign-in link format and where it is printed, `authenticate` behaviour for each method,
model and thought-level option shapes, `logout`, WKWebView link opening, the macOS Keychain prompt.

## Manual check on a Mac with the real runtime

1. Install as above; open Settings, Model providers, Add provider, Antigravity, Connect. The status shows "Installed, version ...".
2. Sign in with Google: the browser opens the Google page, finish it; the status becomes "Signed in" and models appear. Cancel
   once mid-way: the status returns to idle and no `agy_acp_server` process remains (`pgrep agy_acp`).
3. Send a prompt in a project chat: text streams. Ask it to run a command: an approval card appears; Allow once runs it, Deny refuses.
4. Press Stop during a long answer: the partial answer stays; send another message, it works in the same session.
5. Send a message while it works: the turn ends softly and the message is answered next.
6. Quit and reopen Gustaf, continue the chat: the agent remembers the earlier turns (resume). If not, the history is replayed.
7. Sign out, then try a prompt: "Sign in to Antigravity ..." appears.
8. Switch the method to Gemini API key, save a key (it must not appear in settings.json or logs), Connect, send a prompt.
