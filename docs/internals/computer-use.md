# Computer use

Agents in a thread the user allows can see and drive the whole Mac. The executor lives in the
desktop app's main process ([`apps/desktop/src/computerUse`](../../apps/desktop/src/computerUse))
with a Swift helper ([`native/computer-use`](../../native/computer-use)); the wire types are in
[`packages/contracts/src/computerUse.ts`](../../packages/contracts/src/computerUse.ts).

## Why the desktop app, TypeScript and a Swift helper

- **Only the app is a real app.** macOS grants Screen Recording and Accessibility to an app
  bundle. The server is a plain child process and a web or mobile client is on another machine,
  so the executor must run under the desktop app's identity.
- **TypeScript decides, Swift only calls the OS.** The dialog, tray, global shortcut and
  settings are Electron APIs the main process already wraps, so the state machine is TypeScript
  and testable against a fake Mac. The helper makes one OS call per request line, with no
  decisions and no logging, because ScreenCaptureKit is Swift-first and killing a process is a
  hard stop. A Rust sidecar would need a second channel back to the main process for every
  dialog and shortcut, for no extra rights: macOS attributes any helper to the app anyway.

## Why a file-descriptor pair, not a socket with a token

- The desktop app gives only its primary backend, on macOS, fd 8 (replies and status events) and
  fd 9 (requests) at spawn. There is no address, token or environment variable an agent could
  find, and Node does not pass undeclared descriptors to the server's children, so an agent's
  shell cannot skip the server's per-thread checks.
- **The session belongs to the backend run.** When that run ends (exit, crash, restart), its
  connection closes and the session ends as `connection-lost`. WSL and extra backends never get
  the pair and report `unsupported`, as does a server on a VPS or the `gustaf` CLI.
- One pipe carries every request by id. Session requests keep their order; status, stop and
  switching the feature on or off run at once, so a step in flight or the consent dialog waiting
  for the person at the Mac never delays a Stop.

## Ownership and lifecycle

- One owner per Mac user, across threads, environments, instances and builds: an `flock` on
  `~/Library/Application Support/Gustaf/computer-use.lock`, a path no app identifier changes, so
  the older Tauri builds are excluded too. A separate helper process (`--hold-lock`) holds it for
  the session, because the working helper is replaced after timeouts and permission checks. The
  kernel drops the lock when that process dies, so a crash never leaves the Mac claimed.
- Stopping bumps an epoch at once, then takes the OS-call lock to release held buttons and keys.
  Each event checks the epoch while holding that lock, so nothing posts after a stop and the step
  already posting is the last one.
- A session that cannot register ⌃⌥⌘⎋ does not start. The menu-bar item is text only; there is
  no screen overlay, which would land in screenshots and under the agent's clicks.
- Turning the feature on shows a native dialog on the Mac whose default button refuses. A remote
  client can ask; only a person at the Mac can agree. The switch persists in the desktop
  settings, a session never survives a quit.

## macOS identity: whose permissions these are

- Grants belong to the signed bundle: `io.github.libes6.gustaf` for installed builds. A dev run
  is its own bundle, `com.t3tools.t3code.dev.<checkout folder>` shown as "T3 Code (Dev)", so each
  worktree needs its own grants and a grant to the installed app does not cover it.
- Gustaf is signed without a Developer ID unless the release has `CSC_LINK`, so macOS may forget
  both grants after every update and the user grants them again.
- The helper asks macOS (`CGPreflightScreenCaptureAccess`, `AXIsProcessTrusted`) from the
  process that captures and posts events, so the check and the action agree. A process keeps the
  first Screen Recording answer it got, so the helper is replaced after any check that finds it
  off. A helper that cannot be asked reports no permissions, which clients show as a failed check
  rather than as permissions to grant.

## Threat model and its limit

The executor's checks protect the official path only. macOS attributes a child process's
privacy access to the app responsible for it, so once Gustaf holds Screen Recording and
Accessibility, an agent's shell command (for example `screencapture` or `osascript`) may use
them without asking. SnapShots already asks for both. Closing that gap means starting the
server with its responsibility disclaimed, which changes how every agent's file-access
prompts look and is not done.

## Coordinates

Agents address points in pixels of a screenshot by its `captureId`. The executor maps them to
global display points, so Retina scale, displays left of or above the main one, and downscaled
images need no handling elsewhere. If the display changed since the capture, the action is
refused and the agent takes a new screenshot.
