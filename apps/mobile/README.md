# @mcode/mobile (planned)

Placeholder. This workspace holds no code yet and installs no Expo or React Native dependencies.

It is reserved for the M Code companion app described in [TASKS.md](../../TASKS.md) ("Mobile companion app"): control the
desktop app from a phone on the local network. The desktop shows a QR code, the phone scans it, pairs, and then sees the
whole workspace (projects, chats, running requests) and can send messages, approve or deny actions and stop requests.

Planned shape:

- React Native with Expo, using a development build (`expo-dev-client` / EAS), not Expo Go, so native modules such as
  TLS pinning and the iOS local-network permission are available.
- File-based routing with expo-router: `app/`, `app.json`, `eas.json` live in this directory once the app is created.
- The wire contract comes from [`@mcode/protocol`](../../packages/protocol) (pure TypeScript, shared with the desktop).
  Shared packages must not import React, Tauri or React Native: Expo pins its own React version, which can differ from
  the desktop's.
- i18n (en/ru) like the desktop, possibly through a shared `packages/i18n`.

Nothing here is wired into `npm run check`. When the app is created, add its scripts to this `package.json` and its
dependencies to the root lockfile with `npm install` at the repository root.
