# FAQ

## What is Gustaf?

Gustaf runs the coding agents you already have — Claude Code, Codex, Cursor, Grok Build,
OpenCode, Google Antigravity, Pi, Muse Code, and others — from a desktop app and an Android
remote. It is not a model and it does not replace those agents. [Provider setup](./install.md#providers)

## Can I use Gustaf with my Claude Code or Codex subscription?

Yes. You sign in to the provider on the computer that runs Gustaf. You pay that provider the way
you already do. Gustaf itself has no subscription.

## How much does Gustaf cost?

Nothing to us. It is free and open source (MIT). You still pay your model provider.

## How do I use Gustaf from another device?

Agents run on the computer where Gustaf is installed. A phone or another computer connects over
the local network, Tailscale, or the Gustaf relay. [Remote access](./remote-access.md)

## How do I use Gustaf on my phone?

Install the Android APK from [GitHub Releases](https://github.com/Libes6/Gustaf/releases), then
connect it to your computer. The phone is a remote. The computer does the work and needs to stay
on. [Install](./install.md#mobile-app) · [Remote access](./remote-access.md)

## Why does the relay fail?

Sign in with GitHub on both devices and register each one under **Settings → Account**. On the
computer, open **Settings → Remote access** and choose **Connect a phone**. On the phone, scan
that code from **Add route**. Allow the phone on the computer and compare the safety code. The
code works once, for five minutes. [Relay troubleshooting](./remote-access.md#relay-troubleshooting)

## Does my code go to Gustaf's servers?

Prompts and files go from your computer to your provider. The Gustaf relay carries the phone's
connection end to end encrypted: it can see which of your devices are connected and how much they
send, not the contents. Product usage events (provider, model, token totals) can be sent
separately. They do not include prompts or file contents. Set `T3CODE_TELEMETRY_ENABLED=false` to
turn those events off. [Product usage data](./telemetry.md)

## Can I add more than one account for a provider?

A separate account is a separate provider instance. [Codex](./providers-codex.md#use-multiple-accounts)
· [Claude](./providers-claude.md#separate-accounts-or-configurations)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and give it its own keys and endpoint.
[OpenRouter](./providers-claude.md#openrouter) · [Provider instances](./install.md#providers)

## Does Gustaf include a local model?

No. It runs the agent CLI you install on the computer.

## Is there voice input?

On Android, dictation uses on-device speech by default; you can opt in to a paired environment
instead. The desktop app requires you to choose an environment first. The transcript goes into
your draft for review. See [Voice input](./voice-input.md).

## Which systems does the desktop app support?

macOS Apple Silicon, Windows x64, and Linux x64. Windows can also run agents inside WSL.
[Install](./install.md)

## Why is my provider not showing up?

The provider CLI is not installed, or it is not on the `PATH` of the computer that runs the
server. Sign in on that computer first, such as `codex login` or `claude auth login`. If it is
still missing, set **Binary path** in provider settings. [Provider setup](./install.md#providers)

## Worktrees are using a lot of disk. How do I clean them up?

Open **Settings → Worktrees → Cleanup** and turn on automatic worktree cleanup, or run it now
from there. [Storage cleanup](./project-settings.md#storage-cleanup)
