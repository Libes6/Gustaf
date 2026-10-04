# Quick ask window

A Spotlight-like window: a global shortcut opens a small always-on-top window, you type a question and get a streamed answer from your default model. **Open in Gustaf** continues the exchange as a normal chat in the main window. It is **off by default**.

## Using it

1. Settings, General, Keyboard shortcuts, **Quick ask window**: turn the switch on. The shortcut is registered immediately.
2. Press the shortcut anywhere. The window appears centered on the screen that holds the mouse pointer, with the question box focused.
3. Type a question, Enter sends (Shift+Enter adds a line). The answer streams in as Markdown. **Stop** ends the request and keeps what arrived.
4. **Copy** copies the answer. **Open in Gustaf** stores the exchange as a new chat (no project), shows and focuses the main window and opens that chat; the quick-ask window closes.
5. Esc hides the window (and stops a running request). With "Hide when the window loses focus" (default on) clicking elsewhere hides it too. Showing the window again always starts a fresh question.

The window states it plainly: **a quick ask is not stored unless you click Open in Gustaf.** Nothing is written to the chat database, the draft store or the message search before that.

### Shortcut

Defaults (chosen to be unlikely to clash; there is no preset that no program uses):

| OS | Default |
| --- | --- |
| macOS | Command+Shift+Alt+Space (`⌘⇧⌥Space`). `Cmd+Alt+Space` is Finder search and `Ctrl(+Alt)+Space` switches the input source, so neither is used |
| Windows, Linux | Control+Alt+Space (Windows' own `Alt+Space` is the window menu and PowerToys Run's key) |

The settings row shows the current shortcut, **Record** lets you press a new one and **Reset to default** restores it. A recorded shortcut needs a key and at least one non-Shift modifier (a bare key or Shift+letter would hijack typing everywhere), and is refused when it is a combination the OS owns (for example `⌘Space`, `Alt+Tab`) or when it duplicates another global shortcut of the app. These checks are `validateAccelerator` in `src/lib/quickAsk.ts`; Rust validates again (`parse_accelerator`).

If the shortcut cannot be registered (another app owns it, the OS refused it) the settings page shows a notice below the switch; the app keeps running and the switch stays on so you can pick another shortcut. The same happens at startup for a stored shortcut.

### Include clipboard text

An explicit switch in the window, **off by default** and off again every time the window is shown. Turning it on reads the clipboard once and shows a preview (first 400 characters) and the character count of the text that will be sent; that exact text is sent after the question in a fenced block and stored the same way by Open in Gustaf. At most 20 000 characters are sent (the preview says when the text was cut). The clipboard is never read in the background; there is no selection capture and no screenshots in this version.

### Model

The window uses the model selected in the main window (the "selection" setting) and lists the other usable models in a chip you can switch for the current question. Models of CLI-native providers (Claude Code, Codex, Cursor Agent, the Cursor API provider) are not offered: they run through the shell plugin, which this window deliberately does not have. When the default model is one of those the window shows another model and says so; with no API provider at all it explains that.

### What the turn is

A plain chat turn: no tools, no project, no Computer Use, no MCP, no skills or memory. The system prompt says it is a quick ask without tools (`QUICK_ASK_SYSTEM`). Provider keys are read lazily from the Keychain like in the main window, on the first request.

Usage is recorded like for a normal run: when a request ends, the window tells the main window (event `quick-ask:usage`), which updates the token statistics, the provider usage counter and the provider health exactly as `checkProvider` does. A request that is stopped reports nothing (no usage is known). The daily token budget is respected: when it is already used up the window refuses to ask and says so. Tokens of quick asks that were not opened in Gustaf are not in the Budgets banner (it is computed from stored chat messages); once opened, the assistant message carries its `usage` like any other and counts.

## Design

```
global shortcut --(Rust handler)--> quick_ask::toggle --> create window "quick-ask" (first time) / show / hide
                                                           |
quick-ask.html  (own Vite entry: src/quick-ask/main.tsx, shared theme, i18n, providers, Markdown; not the app shell)
   QuickAskView ---- adapter.turn(tools: []) ----> provider (plugin-http)
        |  emit "quick-ask:usage"          -> main window: token stats, usage counter, provider health
        |  Open in Gustaf: createChat + addMessage (shared SQLite via db_* commands)
        |  emit "quick-ask:open-chat"      -> main window: reload chats, open the chat
        |  invoke quick_ask_open_main      -> show, unminimize, focus main; hide quick-ask
        `  invoke quick_ask_resize(height) <- ResizeObserver: window follows the content (clamped 160..520)
```

* **Rust** (`src-tauri/src/quick_ask.rs`): `quick_ask_configure(enabled, accelerator, hide_on_blur)` (re)registers the shortcut and always releases the previous one first; `quick_ask_show/hide/toggle/ready/resize/open_main`. The window (label `quick-ask`, 640x160, borderless, always on top, skipped in the taskbar, visible on all workspaces, not resizable) is created on first use, never at startup, and only hidden afterwards. It is shown once its page calls `quick_ask_ready` (no white flash), then Rust emits `quick-ask:shown` on every show so the page starts a fresh question. Closing the main window destroys it so it cannot keep the app alive. Errors are `<code>: <message>` (`invalid_shortcut`, `needs_modifier`, `shortcut_unavailable`, `window_error`).
* **Entry**: `quick-ask.html` is a second input of `vite.config.ts` (`build.rollupOptions.input`) and a second page in `dist`; Tauri serves it under the same strict CSP, with the same nonce/hash injection. A route inside the main bundle was rejected: it would load the whole app shell (and its listeners and timers) into a window that must open in an instant.
* **Frontend** (`src/quick-ask/QuickAsk.tsx`, pure logic and the state machine in `src/lib/quickAsk.ts`, Tauri bridge in `src/lib/quickAskApi.ts`, main-window side in `src/lib/quickAskHost.ts`, settings in `src/components/QuickAskSettings.tsx`). State machine: idle, streaming, then done, error or stopped; events arriving in any other phase (a late chunk after Stop) are ignored.
* **Setting**: `quickAsk` = `{ enabled: false, accelerator: null (platform default), hideOnBlur: true }`.

## Capability and CSP

`src-tauri/capabilities/quick-ask.json` applies to the label `quick-ask` only and grants: `core:event:allow-listen`, `allow-unlisten`, `allow-emit-to` (the three events above), `core:window:allow-start-dragging` (drag the borderless window by its top strip) and `http:default` with the same URL scope as the main window (it makes the same provider requests). Showing, hiding, resizing and focusing are app commands (Rust), which capabilities do not gate, so the window holds no `core:window:*` permission besides dragging. It has no shell, dialog, opener, notification, global-shortcut, updater or process permission. `tests/csp.test.mjs` pins the exact list, that the main capability does not list the window and that the http scope stays identical.

CSP: no change. The production policy is unchanged and `tests/csp.test.mjs` now also checks that `quick-ask.html` has no inline script, handler or style, and boots in a real Chrome under the production policy without violations.

## Tests

* `cargo test`: `quick_ask` unit tests (default accelerator per OS, accelerators parse and need a modifier, height clamp, centering on a monitor including negative origins and monitors smaller than the window).
* `tests/quickAsk.test.mjs` (node): state machine, open-in-Gustaf payload, clipboard block and limits, model choice, accelerator recording/validation/display, parity of the default accelerators with the Rust source.
* `tests/ui/QuickAsk.test.tsx`, `QuickAskSettings.test.tsx`, `QuickAskHost.test.tsx` (vitest): streaming, stop, copy, open in Gustaf, clipboard preview, budget, model fallback, the settings switch and recording, startup registration, usage and open-chat events.

## Not verified without a real window

These need a real desktop session and were **not** exercised by any automated test or by the author:

* Focus behaviour: that the window takes keyboard focus when shown from another app (macOS activation policy may require activating the app first), that focus loss hides it, that Esc reaches the page.
* Always-on-top above full-screen apps and on every macOS Space (`visible_on_all_workspaces` is set; full-screen Spaces may still win).
* Placement on the monitor with the pointer on multi-monitor and mixed-DPI setups (the arithmetic is unit-tested, the monitor lookup is not), negative-origin monitors, and monitors with a top menu bar or taskbar (the window is centered on the full monitor area, not the work area).
* Global shortcut registration and delivery on each OS: macOS (Accessibility is not needed for registered hotkeys, but other apps may own the combination), Windows (the combination may be reserved), X11, and **Wayland**, where global shortcuts through this plugin generally do not work at all and window positioning, focus stealing and always-on-top are controlled by the compositor. On Wayland expect the shortcut notice or a window that does not come to the front.
* The borderless window frame on each OS (no native shadow or rounded corners on Windows/Linux, a square window on macOS), dragging by the top strip, and the Tauri build of `quick-ask.html` served by the real asset protocol (checked in Chrome under the same CSP header only).
* The clipboard read: WKWebView may show a system "Paste" bubble for `navigator.clipboard.readText()`; denial is handled (the switch stays off with a message), the prompt itself is untested.
* Staying alive when the main window is closed on macOS (closing the main window quits the app, as before).
