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
