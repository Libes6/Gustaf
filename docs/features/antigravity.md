# Antigravity (Google's ACP agent)

Gustaf runs Google's official **Antigravity ACP agent** (`agy_acp_server`) as a provider. It speaks the Agent Client
Protocol ([agentclientprotocol.com](https://agentclientprotocol.com)): JSON-RPC 2.0, one JSON object per line, over the
agent's stdio. Like Claude Code and Codex it runs its own tools in the project folder; Gustaf relays text, tool cards and
approvals. The agent has its **own Google sign-in**, separate from the Antigravity IDE or CLI.

**Status: built and tested against a synthetic ACP agent and synthetic archives only.** The real binary is proprietary and
was never downloaded or run for this work, neither by the ACP client nor by the managed installer. Everything below
marked "not verified" needs the manual steps at the end.

## What works

- Provider "Antigravity" in Settings, Model providers (Add provider, tile "Antigravity"; one provider per Google account).
- Settings page: managed runtime (Install, Update, Remove), binary path, sign-in method (Google account, Gemini Enterprise, Gemini API key, Agent Platform / Vertex
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

## Install

### Managed install (Settings, Model providers, Antigravity, Runtime)

The Runtime row has an **Install Antigravity** button. Nothing is downloaded or run until you press it and confirm a dialog
that shows the source URL, the version (1.3.0), the download and on-disk size, the install folder, and that the software
is Google's proprietary software under [Google's terms](https://antigravity.google/terms). Then:

1. **Download** the pinned archive for this machine, with a progress bar (MB received of total) and **Cancel**.
2. **Unpack** it into a temporary folder, set the executable bits, write `manifest.json`.
3. **Verify**: the executable is started in a throwaway home and answers an ACP `initialize` request (no sign-in, no
   session), then it is killed.
4. The finished folder is moved into place with a rename. Status shows "Installed 1.3.0 (managed)".

The provider uses the managed executable when **Binary path** is empty (before `agy_acp_server` on PATH); an explicit Binary
path always wins. **Remove runtime** deletes the folder (after a confirmation); it is refused while a chat holds a live
Antigravity session, a sign-in is waiting, or a provider's Binary path points inside the managed folder. Your Google
sign-in lives in the per-provider profile and is not touched.

Supported: Apple Silicon macOS, Linux x64 and ARM64, Windows x64 and ARM64. Elsewhere the button stays disabled with the
reason. **Intel Macs are excluded**: T3 Code's release table lists an `x86_64` macOS archive, but its user documentation
says managed install supports Apple Silicon only (Intel Macs "can connect to a supported remote environment"), and the
Intel build was never run by us, so Gustaf follows the documented rule. Intel Mac users install manually (below).

#### Folder layout

```text
<app data>/antigravity-runtime/
  .tmp/install/        download.part + download.json (resume state), runtime/ (unpack), work/ (probe home and temp)
  1.3.0/
    agy_acp_server.par (agy_acp_server.exe on Windows)
    localharness_external (.exe on Windows)
    manifest.json      version, platform, source URL (no query), archive SHA-256, per-file size and SHA-256, time
```

`.tmp` is deleted at every app start, so quitting (or crashing) mid-download leaves nothing half-installed; only a finished
version folder is ever used. Free space needed is about 1.9 GB on macOS, 1.7 GB on Windows and 2.7 GB on Linux (archive + unpacked
files + 256 MB slack + 1 GB for the agent's own self-unpack during the probe); the install refuses to start with a clear
message when the disk has less (the free-space probe exists on macOS and Linux; on Windows a full disk surfaces as a write
error instead).

#### Safety rules

- HTTPS only. The URL is built in code from constants (`https://dl.google.com/agy-extensions/releases/<macos|linux|windows>/agy-acp-server-1.3.0-<platform>.zip`);
  no registry JSON or other data fetched at runtime can change it, and no setting can either. The first request must go to
  `dl.google.com` on port 443.
- Redirects are followed (at most 5) only to `google.com`, `googleusercontent.com`, `googleapis.com` and `gvt1.com`
  (Google's download CDNs) hosts, over HTTPS; anything else aborts the install. This is defence in depth: integrity does not
  depend on it, the pinned SHA-256 does. `gvt1.com` is Google's Chrome/updates CDN domain and is on the list because
  `dl.google.com` is known to use it for other products; whether the Antigravity archive actually redirects there was not
  observed.
- No auto-update, no background check. A newer pinned version in a later Gustaf release shows as "Update available" and
  needs a click and the same confirmation. One install at a time. Cancel stops the transfer and removes the partial file.
- The only thing logged or shown about the network is a URL without query string and byte counts.
- Unpacking accepts exactly the two pinned files, flat names only: any other member, folder, symlink, special file,
  encrypted member, absolute or `..` path, repeated member, or a member whose size differs from the pinned size (also while
  streaming) aborts the install. That also caps the unpacked size at the sum of the pinned sizes.
- A partial download is resumed only after a network failure inside the same app run, and only if it provably is the same
  file: same URL and pinned size, a strong ETag recorded from the first response, `Range` + `If-Range`, a `206` with the
  matching `Content-Range`. Otherwise it restarts. The SHA-256 of the whole file is checked either way.

#### Integrity: what is and is not checked

Google's registry entry does **not** publish checksums. The SHA-256 and byte sizes pinned in `antigravity_runtime.rs` were
copied from T3 Code's release table (MIT, `antigravityRelease.ts`, "hashes and sizes were checked on 2026-10-05"). They were
**not re-computed by us**, because the archives were never downloaded for this work. So the trust chain is: TLS to
`dl.google.com`, plus the downloaded bytes matching a hash someone else computed from Google's file. If a pinned value is
wrong or Google replaces the file, the install fails closed ("did not match the expected size or checksum") and installs
nothing; fix by re-pinning in the next release after checking the file. The pins are per platform and per version.

After install, `manifest.json` records the SHA-256 of the archive and of each unpacked file. Opening the settings page
re-hashes the installed files against it; a mismatch shows "The managed runtime changed after it was installed" and offers
Install again, and the provider stops using the managed copy when file sizes differ. The manifest is a tripwire against
accidental or casual modification only: anyone who can write the folder can rewrite the manifest too.

#### macOS Gatekeeper and quarantine

The files are written by Gustaf itself through its own network client, so macOS never attaches a
`com.apple.quarantine` attribute to them (that is added by browsers and some downloaders, not by a plain file write). Gustaf
therefore does not run `xattr`, does not disable Gatekeeper, and does not change any system security setting; the files are
exactly as trusted as anything an app downloads and runs. Whether the real `.par`/helper pair runs without a Gatekeeper
prompt, or needs a signature, was **not verified**; if macOS blocks it the verify step reports "did not start" and nothing
is kept.

### Manual install

Use this on Intel Macs and unsupported systems, or to pin your own copy.

1. Download the archive for your platform from the official ACP registry entry `antigravity-acp`
   (github.com/agentclientprotocol/registry). Check the download is from `dl.google.com`.
2. Extract it. Keep the ACP executable (`agy_acp_server`, `.par` on macOS and Linux, `.exe` on Windows) and its
   `localharness_external` helper in the same folder, at the same version. `chmod +x` both on macOS and Linux.
3. In Settings, Model providers, Antigravity: set **Binary path** to the executable, or leave it empty to use the managed
   runtime or `agy_acp_server` (or `agy_acp_server.par`) from the login-shell PATH.

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
| Install seam (typed Tauri commands) | `src/providers/antigravityRuntime.ts` |
| Managed install: download, unpack, probe, manifest | `src-tauri/src/antigravity_runtime.rs` |
| Install/remove confirmation | `src/components/AntigravityRuntimeDialog.tsx` |
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

- Managed install is not available on Intel Macs (manual install only); updates are never automatic.
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
profile folders in Rust, and the managed install (`antigravity_runtime.rs` tests) against synthetic zips served by a local
127.0.0.1 server: platform and URL mapping, host and redirect policy, size/hash/redirect/HTTP errors, resume, zip-slip, size cap,
symlinks, executable bits, manifest tamper detection, cancel, temp cleanup, probe failure, update and remove. Fixtures are synthetic, written from the public ACP spec and T3 Code's schemas.

Not verified: the real download (pinned hashes and sizes, redirect hosts, Gatekeeper behaviour, `initialize` probe on the real
agent, free space needed) and everything else with the real `agy_acp_server`: its actual `initialize` answer (protocol version, auth method
ids, `resume` support), the exact sign-in link format and where it is printed, `authenticate` behaviour for each method,
model and thought-level option shapes, `logout`, WKWebView link opening, the macOS Keychain prompt.

## Manual check on a Mac with the real runtime

1. On an Apple Silicon Mac: Settings, Model providers, Add provider, Antigravity, Connect. In the Runtime row press Install
   Antigravity: the dialog lists `https://dl.google.com/...darwin-arm64.zip`, 1.3.0, about 111 MB download and 397 MB on disk,
   the folder, and the link to Google's terms. Confirm; watch Downloading, Unpacking and Checking; the status becomes
   "Installed 1.3.0 (managed)" with a Remove runtime button. Also try Cancel mid-download (the `.tmp` folder disappears) and
   quitting the app mid-download (it is cleaned at the next start). Check `ls -l` of the folder: both files are `rwxr-xr-x`,
   `xattr -l` shows no `com.apple.quarantine`.
2. Sign in with Google: the browser opens the Google page, finish it; the status becomes "Signed in" and models appear. Cancel
   once mid-way: the status returns to idle and no `agy_acp_server` process remains (`pgrep agy_acp`).
3. Send a prompt in a project chat: text streams. Ask it to run a command: an approval card appears; Allow once runs it, Deny refuses.
4. Press Stop during a long answer: the partial answer stays; send another message, it works in the same session.
5. Send a message while it works: the turn ends softly and the message is answered next.
6. Quit and reopen Gustaf, continue the chat: the agent remembers the earlier turns (resume). If not, the history is replayed.
7. Sign out, then try a prompt: "Sign in to Antigravity ..." appears.
8. Press Remove runtime while a chat is running: it is refused. Close the chat and remove it: the folder is gone and the Install
   button returns.
9. Switch the method to Gemini API key, save a key (it must not appear in settings.json or logs), Connect, send a prompt.
