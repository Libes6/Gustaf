# Devices

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
