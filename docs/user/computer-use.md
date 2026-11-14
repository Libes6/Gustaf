# Control your Mac

An agent in a thread you allow can see your Mac's screen and use its mouse and keyboard: open an
app, type, click, scroll, and take a new screenshot to check the result. It works only in the
Gustaf app on macOS, for the Mac that app runs on. An environment on another machine, such as a
VPS, shows that control is not available there.

Only one thread controls the Mac at a time, across every environment and Gustaf window on it.

## Turning it on

1. Open the thread and click **Control Mac** (the monitor icon) in its header.
2. Click **Turn on for this Mac**. A dialog appears on the Mac; only someone sitting at it can
   allow it.
3. If Gustaf lacks a permission, click **Open on the Mac** next to it. Allow Gustaf under
   **System Settings › Privacy & Security › Screen Recording** and **Accessibility**, then click
   **Check again**. macOS may ask you to reopen Gustaf after granting Screen Recording.
4. Click **Allow this thread**. Then ask the agent to do the task, for example "Open TextEdit,
   type a short note and save it to Desktop/test".

Control works with Claude, Codex, OpenCode and Pi. Other providers do not show screenshots to
their model, so the tools refuse there.

Gustaf is not signed by Apple, so macOS may forget both permissions after an update. Grant them
again the same way.

## Stopping

Any of these ends control at once. Nothing the agent asked for after that runs, and no key or
button stays pressed:

- **Stop** in the thread header, in any thread, on desktop or web.
- **Stop** in the thread on your phone, over any connection to the environment.
- **Stop control** in the Mac's menu bar, or the emergency shortcut **⌃⌥⌘⎋** (Control-Option-
  Command-Escape), which works even when Gustaf is not in front.
- Stopping, archiving or deleting the thread that controls the Mac.
- The agent finishing and handing control back.

Control also ends when Gustaf quits or a permission is turned off. It never resumes by itself: to
continue, allow the thread again. **Turn off on this Mac** in the same menu switches the feature
off until someone at the Mac turns it back on.

## What the agent cannot do

A locked screen, a password field, and some system dialogs are off limits; the agent is told to
ask you to handle them. While a thread controls the Mac, a second thread is refused until you
stop the first.
