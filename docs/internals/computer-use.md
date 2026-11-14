# Computer use

Agents in a thread the user allows can see and drive the whole Mac. The executor lives in the
Gustaf shell (`apps/shell/src-tauri/src/computer_use/`); the wire types are in
`packages/contracts/src/computerUse.ts`.

## Why the executor is in the shell, reached over a socket

- **Only the shell is a real app.** macOS grants Screen Recording and Accessibility to an app
  bundle. The server is a plain binary started by the shell, and a web or mobile client is on
  another machine.
- **The server reaches it directly, not through the page.** The shell starts the server with
  `GUSTAF_COMPUTER_USE_SOCKET` (a Unix socket in the per-user temporary directory, mode 0600)
  and `GUSTAF_COMPUTER_USE_TOKEN` (minted at each launch). A page-relayed design would stop
  working while the window reloads, push every screenshot through the web view and the
  WebSocket, and let a desktop client connected to a remote environment offer its own Mac to
  that environment. Here an environment without the variables, such as one on a VPS, simply
  has no executor.
- **No Tauri command exposes it.** `capabilities/default.json` grants the page nothing for
  computer use or global shortcuts, and `ipc_scope.rs` tests that. Settings, stop and status
  for every client go through the server.
- **The server must delete both variables from its own environment at startup**, before it
  spawns any provider. Every agent subprocess inherits the server's environment, and an agent
  holding the token could skip the server's per-thread checks.

## The server's side

- **A thread's permission is the shell session.** Allowing a thread starts the session at once,
  so "the Mac is busy" shows when the user allows a thread, not mid-task, and the menu-bar
  indicator is on whenever an agent may act. Any end of the session, from wherever, revokes the
  permission; nothing is stored, so a restart needs a new Allow.
- **Every agent action is checked in `ComputerUseService`**: the calling thread must hold the
  session and its provider must show tool images to its model. The provider list
  (`computerUseSupportsDriver` in contracts) comes from reading each adapter: Claude and Codex pass
  MCP images natively, OpenCode attaches them as files, Pi copies them into model content. Driving
  a screen without seeing it is refused rather than attempted.
- **Two kinds of connection.** Session requests share one long-lived connection, because the
  session belongs to it. Stop, status and turning the feature on or off each open their own, so a
  step in flight or the confirm dialog waiting for the person at the Mac never delays a Stop.
  Permission changes are serialized: once a Stop starts, no later action is sent.
- **The MCP tools are listed only where the shell gave the server its executor**, and never to a
  delegated child; elsewhere they cost no agent context.

## Ownership and lifecycle

- One owner per Mac user, across threads, environments and Gustaf builds: an `flock` on
  `~/Library/Application Support/Gustaf/computer-use.lock`, a path no app identifier changes.
  The kernel drops it when the process dies, so a crash never leaves the Mac claimed. The file
  holds the owner's label only to explain a refusal.
- The session belongs to the socket connection that started it and ends when that connection
  closes, when Gustaf quits, when a permission is found revoked, when the feature is turned
  off, from the menu bar, or with the emergency shortcut ⌃⌥⌘⎋. Nothing resumes after a
  restart: the on/off switch persists in `shell-settings.json`, a session does not.
- A session that cannot register the emergency shortcut does not start.
- Stopping bumps an epoch under the state lock, then takes the backend lock to release held
  buttons and keys. Each event checks the epoch while holding the backend lock, so nothing is
  posted after a stop and the step already posting is the last one.
- Turning the feature on shows a native dialog on the Mac. A remote client or a page can ask,
  but only a person at the Mac can agree.

## Threat model and its limit

The shell's checks protect the official path only. macOS attributes a child process's
privacy access to the app responsible for it, so once Gustaf holds Screen Recording and
Accessibility, an agent's shell command (for example `screencapture` or `osascript`) may use
them without asking. SnapShots already asks for both. Closing that gap means starting the
server with its responsibility disclaimed, which changes how every agent's file-access
prompts look and is not done yet.

Gustaf is ad hoc signed, so macOS may forget both permissions after each update.

## Whose permissions are checked

The helper asks macOS (`CGPreflightScreenCaptureAccess`, `AXIsProcessTrusted`) from the same
process that captures and posts events, so the check and the action always agree. macOS
attributes that unbundled child to the app responsible for it: the installed Gustaf bundle, or,
for a dev shell started from a terminal, that terminal app (or whatever app ran the command).
A process keeps the first Screen Recording answer it got, so the shell drops the helper after
any check that finds it off and the next check runs in a fresh one. A helper that cannot be asked reports no permissions,
which clients show as a failed check rather than as permissions to grant.

## The OS calls

`native/ComputerUse.swift` is a helper process, like SnapShots: one request per line, one OS
call per request, no decisions and no logging. Capture uses ScreenCaptureKit
(`SCScreenshotManager`, macOS 14 and later; older systems get an explicit error), input uses
`CGEvent`, text goes in as Unicode strings so it does not depend on the keyboard layout, and
apps are activated through Launch Services because a background process may not activate
another app on macOS 14 and later. If the shell disappears, the helper releases what it
pressed when its input closes.

Agents address points in pixels of a screenshot by its `captureId`. The shell maps them to
global display points, so Retina scale, displays left of or above the main one, and downscaled
images need no handling elsewhere. If the display changed since the capture, the action is
refused and the agent takes a new screenshot.
