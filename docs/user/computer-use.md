# Control your Mac

An agent in a thread you allow can see your Mac's screen and use its mouse and keyboard: open an
app, type, click, scroll, and take a new screenshot to check the result. It works only in the
Gustaf app on macOS, for the Mac that app runs on. An environment on another machine, such as a
VPS, shows that control is not available there.

Only one thread controls the Mac at a time, across every environment and Gustaf window on it.

## Turning it on

1. Open the thread and click **Control Mac** (the monitor icon) in its header.
2. Click **Allow this thread**. The first time, a Gustaf dialog appears on the Mac; only someone
   sitting at it can allow it. Later threads skip that dialog.
3. If Gustaf lacks a macOS permission, the panel names the missing one. Click **Open settings**
   next to it and switch Gustaf on under **System Settings › Privacy & Security** (**Screen
   Recording** or **Accessibility**). macOS may show its own prompt for the same permission; it
   leads to the same switch. The panel notices the change within a few seconds; then click
   **Allow this thread** again.
4. Ask the agent to do the task, for example "Open TextEdit, type a short note and save it to
   Desktop/test".

When Gustaf already has both permissions, step 3 never appears.

Control works with Claude, Codex, OpenCode and Pi. Other providers do not show screenshots to
their model, so the tools refuse there.

Gustaf is not signed by Apple, so macOS treats each update as a new app: the list can show
several **Gustaf** entries, and one switched on for an older version does not count. If the
panel still asks for a permission that looks granted, remove the Gustaf entries with **−** and
click **Open settings** again. If macOS offers to quit and reopen Gustaf after you grant Screen
Recording, you only need to when the panel still asks for it.

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
