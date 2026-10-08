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
