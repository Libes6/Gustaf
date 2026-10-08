# Devices

Part of the [Gustaf documentation](../README.md).

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

**How it works** (only while the setting is on, only for runs that would get the API tools):

1. `src-tauri/src/device_bridge/gustaf-device.sh` (a small `sh` + `curl` launcher, embedded in the binary) is written to `<app data>/device-bridge/bin/`.
2. The agent process is started with that folder first on its `PATH` and with `GUSTAF_DEVICE_URL` and `GUSTAF_DEVICE_TOKEN` in its environment (`TurnInput.device`; set in `invocationScript`, so it works for the live Claude session, the per-turn `claude`/`cursor-agent`/`codex exec` processes and the Codex app-server). The system prompt gets one paragraph (`DEVICE_CLI_PROMPT`) only then.
3. The launcher POSTs its arguments (a repeated form field, so any text survives quoting) to a loopback server in Rust (`device_bridge.rs`, `tiny_http`). The server hands them to the webview as the `device-bridge-request` event; `deviceBridge.ts` parses them (`parseDeviceArgv`, then the same `parseDeviceCall` validation), runs the same `runDeviceTool` with the run's approver and Stop signal, and answers through `device_bridge_reply`. Status 200 with the text, or 422 with the error (the launcher then prints it to stderr and exits 1).
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
