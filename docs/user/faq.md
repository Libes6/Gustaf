# FAQ

## Is Gustaf a harness?

No. A harness is what turns an LLM into an agent: it gives the model tools, a way to call them, runs them, and hands the results back. Claude Code is kind of a harness. It is an interface (the TUI, the Code tab in the desktop app) plus a harness underneath (the Anthropic Agent SDK). Codex is the same split: the app plus the Codex App Server. Gustaf uses those harnesses. It is not a harness, and it does not work without one.

Chef = LLM. Kitchen = harness. Gustaf = the restaurant that lets you bring whatever kitchen you want.

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Kiro, Pi, Muse Code, or fx. [Provider setup](./install.md#providers)

## Why use Gustaf instead of Claude Code or the Codex app?

Gustaf is for people who already use several coding agents and want one interface for all of them. What you get:

- Bring your own sub. Claude, Codex, and whatever else you already have installed.
- Remote ready. Run `t3 up` on any box and drive it from your other devices.
- A desktop, web, and mobile app on the same threads.
- Open source code (MIT). If Gustaf goes the wrong direction, fork it under your own branding.

Every harness feels nearly identical in here, so you can stop worrying about harnesses and focus on building :) [Install](./install.md)

## Can I use Gustaf with my Claude Code subscription?

Yes.

## How much does Gustaf cost?

Nothing. Gustaf does not resell tokens, and there is nothing to pay for to use it. You bring your own sub. The source code is free and open source (MIT). You still pay your provider like you already do. [Install](./install.md)

## Can I fork or redistribute Gustaf?

Yes, for the source code. The [MIT License](../../LICENSE) applies only to the source code, not to any trademarks or branding. Gustaf is an unofficial fork of the open-source [Gustaf Code](https://github.com/pingdotgg/t3code) and is not affiliated with T3 Tools, Inc. If you publish your own fork or custom build, use your own name and branding and make it unmistakably clear that your project is unofficial. See [TRADEMARK.md](../../TRADEMARK.md).

## Why is my Claude 5-hour limit draining so fast?

It shouldn't anymore. Gustaf drives Claude through Anthropic's Agent SDK, and Anthropic's 5h meter used to charge Agent SDK usage about 1.7x more than using Claude Code directly. Weekly limits were never affected. That is fixed, and Claude in Gustaf drains your 5h limit at the same rate as Claude Code. Still seeing it? [Update Gustaf](./updating.md) on the machine that runs your agents. [Upstream tracking issue](https://github.com/pingdotgg/t3code/issues/24649)

## How do I use Gustaf remotely?

Your agents run wherever Gustaf runs: your desktop, a server, a VPS. You connect to it from your other devices. Run `t3 up` on that machine to set it up. LAN pairing, Tailscale, and SSH all work. [Remote access](./remote-access.md)

## How do I use Gustaf on my phone?

Install the mobile app from the [latest release](https://github.com/Libes6/Gustaf/releases/latest), then connect it to your computer with a pairing link. The phone is a remote. Your computer does the work and needs to stay on. [Mobile setup](./install.md#mobile-app) · [Remote access](./remote-access.md)

## Does Gustaf include T3 Connect?

No. T3 Connect is the sign-in and relay service of the upstream T3 Code project, and Gustaf builds do not ship it. Use a pairing link, Tailscale, or SSH instead. [Remote access](./remote-access.md)

## Will I get banned for using my subscription?

Gustaf does not resell or proxy your subscription. It runs the provider's own CLI or SDK on your machine, signed in with your account, and most integrations use official ACP bindings. Each provider sets its own terms, so check theirs if you are unsure.

## Can I add a bunch of accounts for one provider?

Gustaf is not the right place to manage a pile of accounts. A separate work account is fine. Setup for two: [Codex](./providers-codex.md#use-multiple-accounts) · [Claude](./providers-claude.md#separate-accounts-or-configurations). For a bigger pool, manage them outside Gustaf with a self-hosted proxy like [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). After you set up a hub, Gustaf can show its pooled limits under Usage. [Connect a hub](./usage.md#connect-a-cliproxyapi-hub)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and give it its own keys and endpoint. Claude has a full OpenRouter recipe. Your subscription setup stays untouched. [OpenRouter](./providers-claude.md#openrouter) · [Provider instances](./install.md#providers)

## Does Gustaf support local models?

No. Gustaf is built for the provider agents listed under [Provider setup](./install.md#providers), and does not support local models.

## Does my code go to Gustaf servers?

No. Your code and prompts go from your machine to your provider (Anthropic, OpenAI, etc.), not to Gustaf. Gustaf sends no product analytics. [Product usage data](./telemetry.md)

## Worktrees are eating my disk. How do I clean them up?

Open **Settings → Worktrees → Cleanup** and turn on automatic worktree cleanup. You can also run it now from there. Worktrees add up fast. One user cleared 500 GB. [Storage cleanup](./project-settings.md#storage-cleanup)

## Is there voice input?

Yes. On iPhone and Android, dictation uses on-device speech by default, with the option to use a paired environment. On macOS 26 or later, desktop users can choose Apple Speech directly under **On this Mac** or choose an environment. Web and other desktop users can enable dictation by choosing an environment. The transcript goes into your draft for review. See [Voice input](./voice-input.md).

## Does it work on Windows, Mac, and Linux?

Yes, all three. Desktop app, CLI, the works. One catch: there is no `t3` binary for Intel Macs, so use the desktop app there. Windows folks can also run agents inside WSL. [Install](./install.md)

## Why is my provider not showing up?

Almost always, the CLI is not installed or not on the `PATH` of the machine that runs the server. (Not your phone. The computer.) Log in on that machine first, like `codex login` or `claude auth login`. Still missing? Point **Binary path** at it in provider settings. Version managers love to cause this one. [Provider setup](./install.md#providers)
