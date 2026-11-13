# Install Gustaf

Gustaf runs coding agents on your computer. Use the desktop app on that computer, or the Android
app as a remote. Set up the computer first.

Downloads are on [GitHub Releases](https://github.com/Libes6/Gustaf/releases). There is no install
script and no npm package.

## Desktop app

| System              | File                                                                 |
| ------------------- | -------------------------------------------------------------------- |
| macOS Apple Silicon | `Gustaf-<version>-macOS-arm64.dmg`                                   |
| Windows x64         | `Gustaf-<version>-Windows-x64-setup.exe` or the `.msi` beside it     |
| Linux x64           | `Gustaf-<version>-Linux-x64.AppImage`, `.deb`, or `.rpm`             |

Intel Macs are not published. Linux and Windows builds are x64 only.

To launch an AppImage, open a terminal in its download folder and replace the name below with the
file you downloaded:

```bash
chmod +x ./Gustaf-0.12.0-Linux-x64.AppImage
./Gustaf-0.12.0-Linux-x64.AppImage
```

Install a `.deb` with `sudo apt install ./Gustaf-<version>-Linux-x64.deb`. Install a `.rpm` with
your distribution's package tool.

The desktop app checks GitHub Releases and updates itself. See [Updating Gustaf](./updating.md).

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects there. Install
the provider CLIs inside that distro. Gustaf does not install its server there: copy the `runtime`
folder from the same version's Linux x64 package to `~/.gustaf/runtime` inside the distro, so that
`~/.gustaf/runtime/t3` exists. The Windows runtime cannot run inside Linux. Copy it again after you
update Gustaf.

Changing the WSL settings restarts Gustaf. WSL appears as a second environment next to Windows.
WSL-only mode makes it the main environment instead; if it cannot start, Gustaf says why and falls
back to Windows. Turning WSL off also turns off WSL-only mode. The WSL server keeps its data in
`~/.gustaf` inside the distro, separate from the Windows data.

## Command line

<a id="command-line"></a>

The desktop app runs the server. The same server is the `gustaf` command when that command is on
your `PATH`.

<a id="the-gustaf-command"></a>

| Task                                             | Command                                                   |
| ------------------------------------------------ | --------------------------------------------------------- |
| Start the server without a browser               | `gustaf serve`                                            |
| Allow the local network                          | `gustaf serve --lan`                                      |
| Pair another device                              | `gustaf pair`                                             |
| Keep it running in the background (macOS, Linux) | `gustaf service install` ([details](./background-service.md)) |
| Move a command-line install to a newer release   | `gustaf update`                                           |

Run `gustaf help` for the full reference. To start in a new working directory, use an explicit
path such as `gustaf ./my-project`. A bare directory name is accepted only if it already exists.

If `gustaf` reports an already running server, connect to that server instead. Stop it before
starting a replacement, or use a different `--base-dir` for an independent server.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
gustaf app
```

This opens a new thread for the current directory, adding the project if needed. Pass a path, such
as `gustaf app ../my-project`, to open another directory. It requires the desktop app. If the
command cannot reach the app, start or update the desktop app and try again.

## Android app

<a id="mobile-app"></a>

Download `Gustaf-<version>-Android.apk` from the same
[GitHub Releases](https://github.com/Libes6/Gustaf/releases) and install it. To update, install a
newer APK over the one you already have. The phone connects to a server on a computer. Follow
[remote access](./remote-access.md).

If the app crashes during launch, open Settings → Diagnostics on the next launch that succeeds. It
lists startup crashes from the last 7 days with the error and component stack. Copy the report and
paste it into a [GitHub issue](https://github.com/Libes6/Gustaf/issues). Error messages can quote
values from the app, so read it over before sharing.

## Nix (nixpkgs)

Gustaf is not published in nixpkgs. Use the desktop app or APK from GitHub Releases.

## Requirements

You need an installed, authenticated provider before starting a thread. You can open Gustaf and
configure providers afterwards.

## Providers

Open **Settings → Providers** in the desktop app, select the environment, and enable the provider
you want. Installation, login, and configuration belong to that environment's machine, even when
you connect from a phone or another computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from Gustaf's provider settings.                                                                                         |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If Gustaf cannot find one, set its **Binary path**
in provider settings, especially when using a version manager. Cursor's executable is
`cursor-agent`, although its login command is `agent login`. Codex connected through ChatGPT and
Antigravity can use their managed runtimes without a `PATH` entry.

Gustaf warns when a provider version has known compatibility problems with your release. Check
**Settings → Providers** on that environment for the recommended version or range. When its
package manager supports installing a specific version, you can install the recommendation there.
Otherwise use the provider's installer on the environment's machine. An unlisted version is
unverified.

When a provider CLI is behind its latest release, its provider card shows the available version.
**Update now** runs the installer that owns the CLI (Homebrew, mise, or a global npm, pnpm, Yarn,
Bun, Volta, or Vite+ install), or the CLI's own update command when Gustaf cannot tell. Gustaf
runs `mise upgrade` only for a tool your mise config requests as `latest` when the provider's
binary path is a mise shim or under the tool's `installs/<tool>/latest` link; update a pinned
version, or a path into one version's directory, through mise yourself. Cursor and Antigravity
update with Gustaf. Homebrew and Chocolatey installs compare against the version their package
manager offers, which can trail the npm release; update Claude installed with Chocolatey through
Chocolatey.

Add another provider instance for a separate account or configuration. Each instance can have its
own environment variables, such as API keys or a custom base URL. Mark secret values as
sensitive; after saving, Gustaf does not display their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating Gustaf](./updating.md): update the app and the Android app.
- [Managed policy](./managed-policy.md): configure Gustaf for everyone on a machine.
