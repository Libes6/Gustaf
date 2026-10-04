# Release smoke checklist

Manual checks on the **CI-built installers** of a draft release, before it is published. Pipeline, signing and the updater-specific checks are in [release.md](release.md); the local update round trip is in [updater-smoke.md](updater-smoke.md). Branch and release flow: [branching.md](branching.md).

Copy this file (or the tables) into the release notes draft or an issue for each platform you test, and fill in every row. Use a clean user account or a machine without development servers running. Use a throwaway test repository and test API keys with low limits; never paste real keys into notes or screenshots.

Result values: **pass**, **fail** (open an issue and link it in notes), **skip** (say why).

## Run details

| Field | Value |
| --- | --- |
| OS and version | |
| Architecture | Apple Silicon / Intel / x64 |
| Build / version | (Settings → General, and the workflow run URL) |
| Artifact and SHA-256 | (`shasum -a 256 <file>` / `Get-FileHash <file>`) |
| Date | |
| Tester | |

## macOS

| # | Step | Expected | Result | Notes |
| --- | --- | --- | --- | --- |
| 1 | Download the DMG for this architecture from the draft release, open it and drag Gustaf to Applications. | DMG mounts; app copies. Hash matches the release. | | |
| 2 | Open Gustaf. Then System Settings → Privacy & Security → **Open Anyway**, confirm. | First attempt is blocked by Gatekeeper (unsigned build); after Open Anyway the app starts with the onboarding or main window. Later launches open without a prompt. | | |
| 3 | Add an API provider (for example Anthropic or OpenAI) with a test key in Settings → Model providers. | Key saves; the sign-in check succeeds; models are listed. Keychain may prompt; record the prompt text and the choice made. | | |
| 4 | Quit and reopen the app. If this build was installed as an update over an older one, note the Keychain behaviour. | Provider still signed in. Keychain prompt reappears at most once per version ("Always Allow" stops it); record what happened. | | |
| 5 | In a new chat send a short message; send a long one and press **Stop** mid-stream. | First reply streams to completion; Stop ends the second at once, the partial reply stays, Retry is offered. | | |
| 6 | Run one CLI provider that is installed (Codex, Claude Code or Cursor Agent) on a test project. | CLI is detected, the reply streams, its tool cards show readable names and results. Note which CLI and version. | | |
| 7 | With an API provider in "Ask for commands" mode, ask the agent to run `git status` in the test project. | Approval card appears; Deny blocks; Allow runs and shows the output; the action log lists both. | | |
| 8 | Ask the agent to edit two files. In Changes accept one file as a whole, then accept one hunk and reject another hunk of the second file. | Diffs show; accepted file and hunk land in the project; rejected hunk does not; remaining hunks stay pending. | | |
| 9 | Open the commit dialog for the accepted changes in the test repository (with a local or test remote): generate a message, commit, **Push**, then **Create pull request** (needs `gh` signed in; use a test repo). | Only ticked files are committed; push succeeds without force; pushing `main`/`master` asks first; the PR form opens and returns a PR URL, or shows the manual command if `gh` is missing. | | |
| 10 | Ask for a canvas (for example a counter in `tsx-canvas`). Open the card: **Preview**, **Code** tab, **Restart**, Export HTML. | Preview renders and is interactive; Code shows the source; Restart resets state; the HTML file saves through the save dialog and opens offline. | | |
| 11 | Attach an image (file picker or paste) and send it to a vision model. | Thumbnail shows in the composer and the sent message; the model describes the image. | | |
| 12 | Open every Settings page one by one. | Each page renders without errors or blank areas. | | |
| 13 | Press Cmd+K, search a word from an earlier message, press Enter. | Results with highlights; Enter opens the chat and scrolls to the message. | | |
| 14 | Type a draft (with an image) in a chat without sending, quit the app, reopen and open that chat. | Draft text and image are restored. | | |
| 15 | Export a chat as Markdown and JSON (chat menu), Share as HTML, then Settings → Import → import the JSON. | Native save dialog appears for each; files are written; import adds the chat once (second import of the same file is skipped). | | |
| 16 | Set a small daily token budget in Settings → Usage → Budgets and send messages until it is crossed. | Warning banner at the threshold, exceeded state above the limit; sending is not blocked. | | |
| 17 | With an API provider in a writable project, ask for work that starts two subagents (for example "use two explore subagents to …"). | Background tasks column opens with a card per subagent; transcript opens; Stop works; finished runs move to "Finished". | | |
| 18 | Open the Terminal in the changes panel; run `pwd`; send selected output to the chat. | Shell starts in the project (or review copy); output appears; selection is added to the composer. | | |
| 19 | Add an MCP server (for example a stdio server via `npx`) in Settings → MCP servers; **Test connection**; ask the agent to use one of its tools. | Server connects and lists tools; the call asks for approval; the result appears in the chat. | | |
| 20 | Settings → General: check for updates. | Shows the installed version and either "up to date" or an offered version; no false "up to date" when offline. For the full update round trip see [release.md](release.md). | | |
| 21 | CSP check. Release builds have no web inspector, so build the same commit as a debug bundle (`npm run tauri build -- --debug --bundles app`, it uses the release CSP), open the web inspector (right-click → Inspect) and repeat steps 5, 10, 11 and 12. | No `Refused to …` CSP errors. If there are any, record them and see the CSP revert note at the end of [security.md](features/security.md). | | |
| 22 | Quit the app. | App exits cleanly; no leftover `node`, CLI or MCP processes (Activity Monitor). | | |

## Windows and Linux

Windows and Linux builds have not yet been launched by hand, so the first run on each matters most. Run the macOS rows above where they apply (use Ctrl instead of Cmd; the global stop shortcut on Windows is Ctrl+Alt+Shift+Esc) and these platform rows:

| # | Step | Expected | Result | Notes |
| --- | --- | --- | --- | --- |
| W1 | Windows: run the NSIS `.exe`; on another clean machine or after uninstalling, the `.msi`. | SmartScreen warning appears (not Authenticode signed): More info → Run anyway; install completes; the app starts from the Start menu. | | |
| W2 | Windows: save an API key, restart the app. | Key is stored in Credential Manager and survives the restart. | | |
| W3 | Windows: CLI provider and `run_command` (PowerShell). | The CLI on `PATH` or in the npm global folder is found; commands run; note any `.cmd` shim problems. | | |
| W4 | Windows: uninstall from Settings → Apps. | App is removed; data in `%APPDATA%\com.maksimkulakov.mcode` remains (expected). | | |
| L1 | Linux: AppImage (`chmod +x`, run); DEB (`sudo apt install ./<file>.deb`); RPM on a Fedora-like system. | Each starts; note the distribution, glibc version, desktop and X11/Wayland. | | |
| L2 | Linux: save an API key with GNOME Keyring or KWallet running; then try without a keyring daemon. | With a keyring the key is saved and survives a restart; without one, saving shows an error (expected). | | |
| L3 | Linux: Settings → General update check in the AppImage and in the DEB/RPM install. | AppImage offers update checks; DEB/RPM show updates as disabled. | | |
| L4 | Linux: Computer Use on X11, then on a pure Wayland session. | X11 works; Wayland is reported as unsupported. | | |

## Sign-off

- [ ] Every row is pass or has a linked issue / justified skip.
- [ ] Artifact hashes recorded for every tested file.
- [ ] Release notes and the `notes` in `latest.json` reviewed together ([release.md](release.md)).
- [ ] Publication explicitly approved by the owner.
