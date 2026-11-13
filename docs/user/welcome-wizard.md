# Welcome wizard

Gustaf shows a setup flow when you open a new installation. Existing
workspaces skip this flow.

Close setup while no import is running to go straight to the app. You can connect
computers and agents later from Settings, or open `/welcome` to run setup again.
Direct links, such as Settings, open normally before setup is done.

## Connect your computers

Select one or more computers to set up. If you opened Gustaf directly from a
server or the desktop app, that computer is already connected and selected.
It is identified by its name, which may differ from the device running your
browser.

You can add more computers before continuing:

- **Gustaf relay** adds a phone that is signed in to the same GitHub account.
  Register the computer under **Settings → Account**, then use
  [Connect a phone](./remote-access.md#gustaf-relay).
- **Add a computer** connects directly to a server on your network or tailnet.
  Start the server with `gustaf serve`, then run `gustaf pair --tailscale` and paste
  the pairing link. You can also run `gustaf serve --host <address>` and use
  `gustaf pair` when the server is already reachable on your network.

A computer marked **Client not supported** runs a Gustaf version that cannot
talk to this app. The message under its name says which side to update.

Saved computers are selected by default. Uncheck any you do not want to set up;
this does not disconnect them.
Continue when your selected computers are connected. Setup checks
agents across the selected computers, then offers project import grouped by computer.

If Gustaf cannot confirm the workspace during startup, the setup flow shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If Gustaf cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Check your agents

Gustaf checks each selected computer for Claude Code and Codex. If an agent is
not installed or signed in, select its action to open a terminal with the
correct command ready to run. Install uses the vendor's own installer, which
keeps **Update now** working in Settings. Other providers can be enabled in
Settings.

The setup terminal uses the home directory and environment configured for the
selected provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

## Import your projects

Gustaf finds directories that Claude Code, Codex or Pi has used. Git repositories
are listed first, newest activity on top. When the remote is on GitHub, the
group shows the repository as `owner/name`. Clones with the same remote share
one group. Directories that are not git repositories sit under "Other folders".

The default selection includes git repositories active within the last 30 days
with at least three conversations. Use the checkboxes, or "Select all" and
"Select none", to change the selection. Linked worktrees of bare repositories
can be offered as separate projects. Other linked git worktrees, Codex scratch
directories under `Documents/Codex`, and anything under `Downloads` are not
offered.

A large or malformed history can reach the scan limit. Gustaf keeps the
projects it found and warns when projects or conversations may be missing.

Imported projects include Claude, Codex and Pi conversations active within the last
30 days. You can continue those conversations in Gustaf. Pi is off by default:
enable it in Settings, then open `/welcome` to import its sessions. Pi sessions
are read from each enabled Pi provider's session directory, which follows
`PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR` in its environment. A
Pi conversation imports its active branch, the one Pi reopens.

Conversation import is best effort. Gustaf keeps the first user prompt and the
newest remaining visible user and assistant messages, with 200 messages total.
It omits tool activity and attachments. For Codex, it omits generated setup
context only when a canonical user event and a valid shared turn ID identify the
same user turn. Ambiguous legacy or response-only context stays in the imported
conversation so Gustaf does not remove user text. It reads one conversation at
a time and skips files larger than 4 GiB. It also skips a conversation when the
message text and metadata it keeps need more than 32 MiB of memory. Tool output
does not count toward that limit. It ignores malformed records and skips
unreadable or unparseable conversations.

Each import attempt reads up to 100 conversation files and 4 GiB per project,
with up to 100,000 input records. Run import again to continue a large batch.
Completed conversations are not imported again. You can continue without the
remaining history.

You can continue without configuring agents or importing projects, or return to an earlier step
using the setup progress bar. Navigation pauses while an import is running.
