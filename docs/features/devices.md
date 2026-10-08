# Devices

Part of the [Gustaf documentation](../README.md).

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
