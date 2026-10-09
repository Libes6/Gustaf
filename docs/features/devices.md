# Devices

Part of the [Gustaf documentation](../README.md).

## Driver

The driver (`apps/desktop/src/device/driver.ts`) is what talks to simulators and emulators for the Device panel and the agent tools. It implements `DeviceDriver` (`src/device/types.ts`) in plain TypeScript; every process is started through an injected runner (`runner.ts`). The real runner is `shellRunner.ts` (it wraps `providers/processHost.ts`, so every device process is in the process ledger and stops gracefully); tests pass a fake that replays recorded output.

### Commands used

| Call | iOS (macOS only) | Android |
| --- | --- | --- |
| `list` | `xcrun simctl list devices available -j` (iOS runtimes only) | `adb devices -l`, `adb -s <id> emu avd name`, `adb -s <id> shell getprop ro.build.version.release`, `emulator -list-avds` (an AVD that is not running is a shutdown device with id `avd:<name>`) |
| `boot` | `xcrun simctl boot <udid>` then `simctl bootstatus` (already booted is fine) | `emulator -avd <name>`, detached through the runner (does not block; the new emulator appears in `list` as `emulator-<port>`) |
| `shutdown` | helper session closed, `xcrun simctl shutdown <udid>` | `adb -s <id> emu kill` |
| `frame` | `xcrun simctl io <udid> screenshot --type=jpeg - \| base64` (PNG with `frameFormat: "png"`) | `adb -s <id> exec-out screencap -p \| base64` |
| everything else | `agent-device`, see below | `agent-device --platform android --serial <id>` |

Frames go through `base64` on the shell side because the runner returns text; the pixel size is read from the JPEG/PNG header (`image.ts`) without decoding.

The helper commands, with `--session gustaf-<id> --udid <id> --platform ios --json` (Android: `--serial`, `--platform android`) always appended, so devices never mix:

| Driver call | Helper command |
| --- | --- |
| `snapshot` | `snapshot -i` |
| `tap` | `press @ref --settle` or `press x y --settle` |
| `longPress` | `longpress @ref [ms] --settle` |
| `swipe` | `swipe x1 y1 x2 y2`, or `gesture pan x y dx dy ms` when a duration is given |
| `type` | `type <text>` |
| `fill` | `fill @ref <text> --settle` |
| `scroll` | `scroll <dir> [0.05..0.8] --settle` (the amount is a fraction of the viewport; direction as the helper names it: `scroll down` reveals content below) |
| `press` | `home`, `back --settle` (Android `back --system`), `type "\n"` (Android `keyboard enter`), `app-switcher`; volume keys on Android through `adb shell input keyevent 24/25`; iOS has none |
| `openApp` | `open <app> --foreground`, then a snapshot |
| `release` | `close` |

### The helper

- `agent-device` **0.21.23**, exact version (`HELPER_VERSION`). It has no dependencies and no install scripts, so it is installed with `--ignore-scripts`.
- `installHelper` runs `npm install agent-device@0.21.23 --save-exact --ignore-scripts` in `<appDataDir>/device-helper/` (progress lines go to the callback), then checks the installed version. It never runs by itself. It needs Node.js 22.12 or newer (the helper's own engine requirement) and says so when Node is missing or old.
- The helper runs as `node <appDataDir>/device-helper/node_modules/agent-device/bin/agent-device.mjs`: never a global install, never `npx` at call time. Without the file every helper-backed call throws `DeviceError` `helper-missing`.
- `toolchain()` reports `ios` / `android` availability with a reason a person can act on, and the helper (`installed`, `version`, `pinned`, plus a `reason` when Node is missing or too old).

### Behaviour worth knowing

- **Coordinates**: every `Target`, `Rect` and `Point` is in the helper's unit: device points on iOS (402x874 for an iPhone 17 Pro), pixels on Android (so on Android `Frame.points` equals `Frame.pixels`). The iOS screen size in points comes from the largest snapshot viewport seen (a keyboard shrinks the viewport) and, before any snapshot, from a guess by pixel width (3x for iPhone widths, else 2x).
- **A helper session is bound to one app.** The driver opens it on the home screen (`com.apple.springboard`) the first time, on the app after `openApp`, and back on the home screen after `press home`. When a tap lands on a home-screen icon the driver finds the app by the icon's label (English name from `simctl listapps` and the name in the simulator's language from `<lang>.lproj/InfoPlist.strings`, `appNames.ts`) and moves the session to it. An app opened some other way (by a person in the Simulator window, or from an app) is not followed: use `openApp`. A system alert hides the app's tree (the snapshot then holds the alert's buttons: tap one).
- **Results**: after every action the driver takes a fresh snapshot, so the refs the helper accepts next are the ones the agent sees, and builds `ActionResult.diff` with our own `diffMaps`/`renderDiff` against the previous map (when the screen was replaced, only the new elements are listed). Without a usable before/after pair it falls back to the helper's own settle diff lines. `settled` is the helper's settle result (always `true` for actions without `--settle`).
- **Errors** (`DeviceError.code`): `stale-ref` (the helper rejected a ref), `timeout` (the runner killed the process), `helper-missing`, `toolchain` (no Xcode command line tools, adb or Node), `no-device`, `failed` (message from the helper: for example "Another automation session holds this device" when another `agent-device` session has the simulator, or "Gesture trajectory does not fit inside the viewport"). A lost helper session (its daemon idles out) is reopened once and the call retried.
- **Concurrency**: `KeyedQueue` serialises snapshots and every mutating call per device id; different devices run in parallel. `frame` never queues (it only calls `simctl`/`adb`) and concurrent frames share one screenshot. Concurrent snapshots share one helper call unless an action was queued in between.
- After `openApp` or a transition the helper may report few nodes and a warning (`foreground-owner-unverified`); the driver looks again (up to two more times, 600 ms apart).

### Verified live (macOS, iOS 26.2 simulator "iPhone 17 Pro", Russian UI)

Through a real shell runner: install into an empty folder, list, frame (valid JPEG 1206x2622, points 402x874), snapshot, openApp Settings, tap a Settings row by ref, back, fill the search field, type, Enter, stale ref (`stale-ref`), scroll, swipe, long press, press home, tap a home-screen icon (the session followed Settings), app switcher, release and rebinding after it. Typical latencies on an Apple silicon Mac (each helper call includes about 0.5 s of Node start-up): frame 130-160 ms (about 400 KB JPEG), list 80-190 ms, snapshot 0.7 s (0.2-0.3 s warm inside an app), tap with settle 2-4.5 s (the helper waits for the screen to be quiet for 500 ms; most of it is that wait), type 0.6-0.9 s, press home 2.5 s (rebinding to the home screen), openApp 1-3.5 s.

Test fixtures in `apps/desktop/tests/fixtures`: `device-ios-helper.json` and `device-simctl.json` are real recordings (paths scrubbed); `device-android-synthetic.json` is **synthetic**.

### Not verified

- **Android**: no emulator or AVD was available. List parsing, framing, helper flags, `back --system`, `keyboard enter`, the foreground-app lookup (`dumpsys window`) and volume keys are tested only against hand-written fixtures in the documented formats. The first run on a real emulator needs: boot an AVD from the panel, list shows `emulator-<port>`, a frame arrives, snapshot and tap work.
- **Windows / Linux**: scripts are POSIX (`base64`, pipes); the runner on Windows is PowerShell, so frames and the Android path are untested there. iOS needs macOS.
- **Physical devices** (iOS or Android): not covered; the list contains USB Android devices, but nothing was tried on them.
- Following an app opened outside the driver, and several booted simulators at once with the same app (sessions are separate per device id, but only one device was available).

## Panel

The **Device** tab of the right-hand panel (next to Changes, Terminal and Preview) shows an iOS simulator or Android emulator, lets you drive it with the mouse and keyboard, and lets you inspect its interface. The driver that talks to the simulators is a separate module (`src/device/driver*.ts`); the panel only consumes the `DeviceDriver` contract in `src/device/types.ts`. The panel gets its driver from `DeviceDriverContext` / `registerDeviceDriver()` (`src/components/device/driverContext.ts`); without one it says "Device control is not available".

- **Setup.** If neither Xcode command line tools nor `adb` are found, the panel lists the reason for each and offers "Check again". If the helper is missing, a banner shows **Install helper (agent-device 0.21.23, from npm)**. Nothing is installed until you click it; the installer's output appears as progress lines. Without the helper you can still start devices and watch them, but taps and the interface map report that the helper is needed.
- **Devices.** The list shows each device with its state, **Start** for a stopped one (it opens as soon as it has booted), **Open** and **Power off** for a running one.
- **Live view.** The screen is drawn letterboxed in its box with its aspect ratio kept. The picture is polled: about 4 frames per second while the pointer is moving over the panel, about one every 1.5 s when idle, and no polling at all while the tab is hidden or the window is not focused. A request never starts before the previous one has finished.
- **Interact mode.** Click = tap, drag = swipe, hold for about half a second = long press. Click the screen to focus it, then type: characters are sent in batches, Enter is pressed as a key, pasting sends the text. Buttons: Home, App switcher, and Back on Android. Backspace and arrow keys are not forwarded. Actions run strictly one after another: a second click while one is running is queued (the busy chip shows "(+1)"), never dropped. After every action the picture and the interface map are refreshed.
- **Inspect mode.** Nothing is sent to the device. Hovering outlines the element under the pointer with a chip (`role · label`); clicking pins it. The details card shows role, label, id, value, rectangle, enabled / hittable / covered, the parent chain, and **Copy ref** (`@e7`), **Copy label**, **Tap this** (taps by ref). A pinned element is re-found by role, id and label after a map refresh.
- **Interface map.** A collapsible pane next to the screen (under it when the panel is narrower than about 640 px) with the app name, bundle id, screen size and element count, a "truncated" note when the helper stopped at its element limit, a search box, an "Interactive only" filter and the tree of visible elements with role chips. Hovering a row outlines the element on the screen, clicking a row pins it, and actionable rows have a **Tap** button. **Refresh map** reads the screen again.
- **Agent control.** When the host passes `agentActive` (and optionally `agentLabel`), a banner "Agent is controlling this device" with a **Stop** button (`onStopAgent`) appears. While it is shown, taps, keys and the Tap buttons are disabled and a click on the screen explains why. Inspecting stays available. The agent integration itself lives elsewhere; the panel only exposes these props.
- **Accessibility.** Every control is a real button reachable with Tab, with focus rings and labels. The screen is a focusable group with `aria-busy` while an action runs. Spinners stop under `prefers-reduced-motion`. Colours come from the theme tokens, so light and dark both work.

### What is verified

- Vitest (`tests/ui/DevicePanel.test.tsx`, `tests/ui/poller.test.tsx`) with the fake driver and the real iOS 26.2 Settings snapshot: setup states, helper install on click only, list/boot/power off, click-to-device-point mapping through the letterbox bars, swipe and long press, batched typing, serial actions and the busy state, inspect hover/pin and the details card, map tree, search and filter, row hover outline, agent banner, polling pause when hidden or unfocused, no overlapping frame requests, error display.
- `tests/deviceScreenGeometry.test.mjs`: point mapping, gesture classification, map rows, re-matching a pinned element, polling rate.
- The layout was looked at in Chrome through a throw-away harness with the fake driver at 900 px and 360 px, dark and light. It was not run in the Tauri window.

### What is not verified

- A real simulator or emulator: frame rate and latency, how the real driver reports errors, long presses and swipes as the helper performs them.
- WKWebView rendering of the panel (the `data:` image, container queries).
- Windows and Linux (Android only there).
- Keyboard input for non-Latin layouts and IME: the browser delivers composed characters as single `key` values, which is untested on a device.

Manual check with a booted iPhone simulator and the helper installed: open the Device tab, press Open, click a row in Settings and see the screen navigate; switch to Inspect, hover the rows and pin one; type into the search field of an app; press Power off.

## Agents

Agents can see and drive an iOS simulator or Android emulator: read the screen as text, tap, type, swipe, scroll, press system keys and open apps. It is **off by default** and per install: Settings, Computer use, **Devices**, "Agent device access". The second switch, "Ask before the agent uses a device for the first time in a chat", is on by default. The agent side is written against the `DeviceDriver` contract (`src/device/types.ts`) and never imports a concrete driver.

### Tools (API models)

Defined in `src/agent/deviceCore.ts`, run by `src/agent/deviceTools.ts`.

| Tool | What it does |
| --- | --- |
| `device_list` | Devices with platform, OS, state and id; the chat's current device is marked. No approval (it reads names only). |
| `device_open` | Chooses a device (id, name, or a unique part of the name; the only booted device when `device` is omitted) and boots it if it is off. It becomes the chat's current device, so later calls may omit `device`. |
| `device_snapshot` | `renderMap` text (the app, then the visible elements with `@refs`). `screenshot: true` also attaches the frame as an image part, like Computer Use (PNG only; a JPEG frame is left out and the text says so). |
| `device_tap`, `device_long_press` | An element (`ref`) or a point (`x`, `y`), the last resort. `ms` for the hold. |
| `device_swipe` | `from_x`, `from_y`, `to_x`, `to_y`, optional `ms`. |
| `device_type`, `device_fill` | Append to the focused field / replace a field's text (at most 2000 characters). |
| `device_press` | `home`, `back`, `enter`, `app-switcher`, `volume-up`, `volume-down`. |
| `device_scroll` | `up`/`down`/`left`/`right`, optional `amount` (0.05-0.8 of the screen, the driver's range). |
| `device_open_app` | An app name or bundle id (no options, paths or shell characters). |
| `device_close` | Ends the automation session (`release`) and forgets the device as the chat's one. `shutdown: true` powers it off. |

- **Results.** Every action returns the driver's message and its screen diff (`renderDiff`), or "No visible change on screen.", so the agent verifies without another snapshot. When the diff is not empty the text reminds that older refs may be stale; when the screen had not settled it asks for a `device_snapshot`.
- **Strict arguments.** Types, ranges (coordinates 0-100000 and inside the screen: the last snapshot's viewport, else the frame's size in points), text length cap, control characters, unknown properties and "ref or x/y, not both" are checked before the driver is called. A wrong call is a tool error the model reads, never an exception.
- **Stale refs.** A ref must come from the device's last snapshot or from the diff of an action since (the diff lists the new screen's elements with refs). Otherwise the call fails with "take a new device_snapshot" without touching the device; a driver `stale-ref` error gives the same message and drops the cached snapshot, so the next ref use needs a fresh one.
- **Memory per chat** (`deviceTools.ts`): the chosen device, the refs seen and the devices the user already allowed live in a module-level map keyed by chat id (`resetDeviceMemory`).
- **Stop.** The run's `AbortSignal` races every driver call, boot wait and approval: the tool returns at once ("Cancelled by user."). The driver contract has no cancellation, so a call that already reached the helper finishes on its own and its result is dropped.

### Who gets the tools

`deviceToolsEligible` (pure): access on, **interactive chat in agent mode, access not read-only**. Subagents (`subagent` or a `toolNames` allowlist), scheduled runs and mobile-triggered runs (both carry `source`) get nothing unless the call site passes `devices: true` in `RunOptions`; Plan, Ask and read-only runs never get them, even with the opt-in. The tools are not offered, and a call that comes anyway is blocked ("device access is off or not available in this run"). Nothing in the app passes `devices: true` today.

### Approvals

- The first device action in a chat, per device, asks (ApprovalCard, new request kind `device`, naming the device). "Allow" stays valid for the rest of the chat; it is not saved across restarts. With the second switch off, nothing is asked at first use.
- Powering a device off (`device_close` with `shutdown`) **always** asks, with a different question, even when first-use asking is off or the device was allowed before. There is no uninstall or erase tool.
- The card has no "Allow for this task" button: the approval already covers the whole chat, and the destructive card must not offer a blanket allow.
- Scheduled and mobile runs cannot be asked (their approver only forwards command approvals), which is one more reason they get no device tools.

### Cards, log and the panel banner

- A device call is a tool card with a phone icon, the verb "Device" and a one-line target (`tap @e7`, `swipe 200,600 → 200,200`; `describeDeviceCall`). A screenshot shows in the card like a Computer Use one. The action log records the same line and how the call ended.
- `src/device/agentActivity.ts` is the tiny store the panel reads for its "Agent is controlling this device" banner: `getAgentActivity()` / `subscribeAgentActivity()` (wrap in `useSyncExternalStore`), `agentActivityFor(deviceId)`. An entry (`chatId`, `deviceId`, `name`, `tool`, `since`) is set when a device tool starts and stays through the run; it is cleared when the run ends, fails or is stopped (`runAgent` clears it on abort and in `finally`; subagent runs do not clear their parent's).

### CLI agents (Claude Code, Codex, Cursor Agent)

They run their own tools and cannot call app tools, so they get a **command**: `gustaf-device` (`list`, `open`, `snapshot [--screenshot]`, `tap`, `long-press`, `swipe`, `type`, `fill`, `press`, `scroll`, `open-app`, `close [--shutdown]`; global `--device <id|name>`). It prints the same text as the tools, with command wording (`gustaf-device snapshot` instead of `device_snapshot`). A screenshot is written to a file in the app folder and its path is printed, for the agent's file-reading tool.

**How it works** (only while the setting is on, only for runs that would get the API tools; a CLI agent is recognised by its adapter, `supportsDeviceCommand`, not by `supportsTools`, because CLI models are listed with tool support):

1. `src-tauri/src/device_bridge/bridge-launcher.sh` (a small `sh` + `curl` launcher, embedded in the binary; the same script serves `gustaf-device` and `gustaf-agent`, see [agents.md](agents.md)) is written as `gustaf-device` (and `gustaf-agent`) to `<app data>/device-bridge/bin/`.
2. The agent process is started with that folder first on its `PATH` and with `GUSTAF_BRIDGE_URL` and `GUSTAF_BRIDGE_TOKEN` in its environment (shared by both commands) (`TurnInput.device`; set in `invocationScript`, so it works for the live Claude session, the per-turn `claude`/`cursor-agent`/`codex exec` processes and the Codex app-server). The system prompt gets one paragraph (`DEVICE_CLI_PROMPT`) only then.
3. The launcher POSTs its arguments (a repeated form field, so any text survives quoting) to `/v1/device` on a loopback server in Rust (`device_bridge.rs`, `tiny_http`; the same server answers `/v1/agent`). The server hands them to the webview as the `device-bridge-request` event (with the command name; `cliBridgeNative.ts` routes it); `deviceBridge.ts` parses them (`parseDeviceArgv`, then the same `parseDeviceCall` validation), runs the same `runDeviceTool` with the run's approver and Stop signal, and answers through `device_bridge_reply`. Status 200 with the text, or 422 with the error (the launcher then prints it to stderr and exits 1).
4. Claude Code is started with `--allowedTools=Bash(gustaf-device:*)` so the command does not hit a permission prompt in headless mode (not in Plan/Ask/read-only).

**Why this route.** Alternatives looked at:

- *An MCP server for the CLIs.* Gustaf has an MCP **client** only (`agent/mcp/`), so it would need a new stdio server process plus an entry in each CLI's own config (`~/.claude.json`, `~/.codex/config.toml`, Cursor's `mcp.json`) or per-run config flags that differ by CLI and version. That writes into files the user owns, outlives the setting, and is invasive.
- *The mobile server.* It is a LAN HTTPS + WebSocket server with pairing and a certificate; far more than a same-machine call needs.
- *A launcher on PATH + a loopback endpoint* (what T3 Code does for its helper). Nothing outside the app folder is touched, access ends when the setting does (the launcher also asks the app, which refuses when the setting is off), and the same code path serves all three CLIs. The loopback server follows the pattern of `webhooks.rs` and `preview.rs`.

**Threat model and limits.**

- Binds `127.0.0.1` on a random port, started on first use. Every request needs `Authorization: Bearer <token>` for a token the webview registered (`device_bridge_register`; 64 hex characters, one per chat, kept in memory, handed only to that chat's agent process). Requests with an `Origin` header (a browser page) or a `Host` other than `127.0.0.1:<port>` / `localhost:<port>` are refused (DNS rebinding), bodies are capped at 128 KB and 16 arguments, wrong tokens get 401. Another process of the same user that can read the agent's environment could use the token while a run is active; that is the same trust boundary as the agent itself.
- A request is served only while that chat has an active agent run and the setting is on; otherwise the launcher prints why. First-use and shutdown approvals appear in the chat like for API agents; the request waits for them (up to 10 minutes).
- macOS and Linux only (the launcher is POSIX `sh` and needs `curl`). On Windows `device_bridge_prepare` fails and CLI agents get no command and no prompt paragraph.
- **Codex** in its default `workspace-write` sandbox has no network access, so `curl` to loopback fails ("cannot reach Gustaf" with that hint); use Full access for device work. **Cursor Agent** runs shell commands unprompted only with Full access. The **Cursor SDK** provider (a different adapter from `cursor-agent`) does not get the command.
- A live CLI process keeps the environment it was started with. Turning the setting on starts a fresh Claude process (the flag is part of the session signature); a Codex app-server connection that is already open keeps running without it until it restarts. With the setting turned off the app refuses requests anyway.

### Wiring (for whoever assembles the feature)

- `src/device/driverSeam.ts`: call `setDeviceDriver(realDriver)` once at startup. Until then the tools fail with "Device driver not available" (a tool error).
- The panel reads `src/device/agentActivity.ts` for its banner.
- Rust: `device_bridge` is registered in `lib.rs` (`DeviceBridge` state and three commands). Nothing else to wire.

### Tests

`tests/deviceTools.test.mjs` (validation, text, memory per chat, stale refs, approvals, eligibility, Stop, activity store), `deviceAgent.test.mjs` (the real agent loop with a scripted model and the fake driver: who is offered the tools, approval, the result with refs and an image, errors, Stop, the CLI environment), `deviceCli.test.mjs` (argv parsing, the real launcher against a local HTTP server, PATH/env script, Claude flag), `deviceBridge.test.mjs`, UI tests for the settings and cards, and the Rust tests in `device_bridge.rs` (form parsing, tokens, a loopback round trip, refusals, timeout, screenshots).

### Not verified automatically

- Real agents calling the tools or the command on a live simulator (the fake driver and the fixture stand in), and the real driver behind `driverSeam.ts`.
- The `gustaf-device` route inside a real Claude Code, Codex or Cursor Agent run: that Claude accepts `--allowedTools=Bash(gustaf-device:*)` in this form, that the Codex app-server and Cursor processes see the PATH and variables, the Codex sandbox behaviour, and that the Tauri event/command round trip works in the packaged app. Manual steps: turn the setting on, start a new chat with Claude Code on a project, ask it to "list my simulators and open Settings on the booted one"; the approval card appears; `gustaf-device snapshot` output shows in the tool card; press Stop during an approval and during a tap and check the banner clears. Repeat with Codex (Full access) and Cursor Agent (Full access). Turn the setting off and confirm the command prints "not available here" in a new chat.
