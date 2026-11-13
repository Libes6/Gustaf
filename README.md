# Gustaf

Gustaf runs coding agents on your computer with the subscriptions you already have, and lets you
follow and steer them from a desktop app or your phone.

- **Desktop app** for macOS (Apple Silicon), Windows and Linux, built on Tauri. It runs the Gustaf
  server locally and updates itself from GitHub Releases.
- **Android app** that connects to your computer over the local network, Tailscale, or the
  end-to-end encrypted Gustaf relay.
- **Interface** in English and Russian.

## Supported agents

Gustaf drives the agent CLIs installed and signed in on your computer. It does not resell model
access; each agent uses your own account.

- Codex: install the [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Claude Code: install [Claude Code](https://claude.com/product/claude-code) and run
  `claude auth login`
- Cursor: install the [Cursor CLI](https://cursor.com/cli) and run `agent login`
- Grok Build: install the [Grok Build CLI](https://x.ai/cli) and run `grok login`
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
- Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**
  ([guide](./docs/user/providers-antigravity.md))
- Kiro: install the Kiro CLI and run `kiro-cli login` ([guide](./docs/user/providers-kiro.md))
- Pi, Muse Code, fx, and agents from the ACP Registry ([Pi](./docs/user/providers-pi.md),
  [Muse Code](./docs/user/providers-muse.md), [fx](./docs/user/providers-fx.md),
  [ACP](./docs/user/providers-acp.md))
- Ollama: chat only, against a local Ollama server

Enable and check each agent under **Settings → Providers**. You can launch Gustaf first and set up
agents afterwards.

## Download and install

Get the latest version from [GitHub Releases](https://github.com/Libes6/Gustaf/releases/latest).

| Platform              | File                                                     |
| --------------------- | -------------------------------------------------------- |
| macOS (Apple Silicon) | `Gustaf-<version>-macOS-arm64.dmg`                       |
| Windows (x64)         | `Gustaf-<version>-Windows-x64-setup.exe` or `.msi`       |
| Linux (x64)           | `Gustaf-<version>-Linux-x64.AppImage`, `.deb`, or `.rpm` |
| Android               | `Gustaf-<version>-Android.apk`                           |

`SHA256SUMS.txt` in each release lists the checksums of every file.

### macOS

Open the `.dmg` and drag Gustaf to Applications. The app is not notarized by Apple, so the first
launch may be blocked: open **System Settings → Privacy & Security** and choose **Open Anyway**.

### Windows

Run the installer. If SmartScreen warns about an unknown publisher, choose **More info → Run
anyway**.

### Linux

Install the `.deb` (`sudo apt install ./Gustaf-*.deb`) or `.rpm` (`sudo dnf install ./Gustaf-*.rpm`),
or make the AppImage executable (`chmod +x Gustaf-*.AppImage`) and run it.

### Android

Download the `.apk` on the phone and open it. Android asks you to allow installing unknown apps for
the browser or file manager you opened it from; allow it for that app, then install. To update,
install a newer APK over the existing one.

### Updates

The desktop app checks GitHub Releases for new versions and installs signed updates.

## Connect your phone

The phone controls agents running on your computer, so the desktop app must be running. There are
three ways to reach it. A phone can keep several routes to the same computer and prefers direct
ones, so at home it uses the local network.

- **Gustaf relay** works from any network, also while either device is on a VPN. Traffic is
  end-to-end encrypted between the phone and the computer; the relay only forwards ciphertext. It
  needs a Gustaf account, which you sign in to with GitHub under **Settings → Account** on both
  devices. Then choose **Connect a phone** in the **Remote access** section of the computer's
  settings, scan the code with the phone, and allow the device on the computer.
- **Local network**: allow network access under **Settings → Sharing & access** on the computer,
  choose **Create pairing link**, and scan it from the phone.
- **Tailscale**: with Tailscale on both devices, pair over the computer's tailnet address the same
  way.

See [Remote access](./docs/user/remote-access.md) for details.

## Build from source

### Install `vp`

Gustaf uses [Vite+](https://viteplus.dev/guide/). Install its global `vp` command, which also
provides the Node version pinned in `package.json` (Node 26).

macOS and Linux:

```bash
curl -fsSL https://vite.plus | bash
```

Windows:

```powershell
irm https://vite.plus/ps1 | iex
```

### Run in development

```bash
vp i          # install dependencies
vp run dev    # start the server and the web client
```

Open the pairing URL the dev runner prints.

To run the desktop app, install the stable [Rust](https://rust-lang.org/install) toolchain (on Linux,
also run `apps/shell/scripts/install-linux-deps.sh`), then:

```bash
pnpm --filter @gustaf/shell dev     # desktop app against the dev server
pnpm --filter @gustaf/shell build   # installers in apps/shell/src-tauri/target/release/bundle
```

More in [Development](./docs/operations/development.md). The Android app is built from
[`apps/mobile`](./apps/mobile/README.md). Architecture starts at
[docs/internals/overview.md](./docs/internals/overview.md).

## Documentation

Docs live in [docs/](./docs):

- [FAQ](./docs/user/faq.md)
- [Remote access](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance](./docs/user/appearance.md)
- [Source control integrations](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)

## License

[MIT](./LICENSE)
