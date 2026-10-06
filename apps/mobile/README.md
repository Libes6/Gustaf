# @gustaf/mobile

Companion app for Gustaf: control the desktop app from a phone on the local network (see [TASKS.md](../../TASKS.md),
"Mobile companion app"). **Status: skeleton.** Everything works against an in-memory mock desktop; the desktop server,
real pairing and TLS pinning are not built yet.

- Expo SDK 57, React 19.2.3, React Native 0.86 (New Architecture), TypeScript, `expo-router`.
- Development build with `expo-dev-client` (not Expo Go): native modules such as certificate pinning and the iOS
  local-network permission need a custom client.

## Commands

```bash
cd apps/mobile
npm ci                          # first time (or npm install)
npm run check                   # typecheck + unit tests
npm run typecheck               # tsc --noEmit
npm test                        # node --test --experimental-strip-types on src/**/*.test.ts (pure TS only, no jest)
npx expo-doctor                 # needs network
npx expo run:ios                # prebuild + build + install the dev client in a simulator or device (Xcode required)
npx expo run:android            # same for Android (Android Studio / SDK required)
npx expo start --dev-client     # Metro; open the installed dev client
npx eas build --profile development --platform ios   # cloud build (profiles in eas.json: development, development-simulator, preview)
```

In the app, **Home -> Try demo mode** uses `MockServer` (two projects, a few chats; a fake streaming reply; include the
word "approve" in a message to get an approval card). Pairing with a real desktop cannot succeed yet.

## Why it is not an npm workspace

Expo pins its own `react` / `react-native`, the desktop uses its own React. In one workspace tree npm hoisting (and
Metro's upward `node_modules` lookup) could bundle two copies of React. So:

- the root `workspaces` list is `["apps/desktop", "packages/*"]`; root `npm ci` / `npm run check` never install or check
  this app;
- `apps/mobile` has its own `package-lock.json` and `node_modules`;
- `@gustaf/protocol` is consumed as `"file:../../packages/protocol"` (a symlink) and read as TypeScript source: no build
  step. `metro.config.js` adds it to `watchFolders`; `tsc` and the Node test runner follow the symlink.
  The protocol package must stay free of React / React Native imports.

CI: the `mobile` job in `.github/workflows/ci.yml` (ubuntu only, separate from the desktop matrix) runs `npm ci`,
`npm run typecheck` and `npm test` here.

## Layout

```
app/                  expo-router: (tabs)/index (connection / pair prompt), (tabs)/projects, (tabs)/settings,
                      pair (QR scanner, expo-camera CameraView), chat/[id] (messages, composer, streaming, approvals)
src/lib/pairing.ts    pure parser/validator for gustaf://pair?... and JSON payloads (tests next to it)
src/lib/streaming.ts  pure reducer: ServerEvent -> chat state (tests next to it); backoff.ts reconnect delays
src/api/client.ts     DesktopApi interface, GustafClient (REST + WebSocket, reconnect, bearer token),
                      PinnedTransport = certificate-pinning interface only
src/api/mock.ts       MockServer (in-memory desktop with fake streaming)
src/storage/secure.ts expo-secure-store: device token, paired desktops, preferences
src/state/store.ts    zustand store (prefs, desktops, active API, connection state)
src/i18n, src/theme   en/ru strings (ru typed against en keys), light/dark tokens (accent #a884ee like the desktop)
```

## Verified vs not

Verified without a device: `tsc --noEmit`, 15 unit tests (pairing parser, streaming reducer, backoff), `expo-doctor`
(21/21), `expo export --platform ios` (Metro bundles the app incl. `@gustaf/protocol`), config resolves (`expo config`).

Not verified: nothing was run in a simulator or on a device, so no screen has been looked at; the camera scan, secure
storage, tab/stack navigation and keyboard handling are untested; the Android build was never attempted; `eas.json`
profiles were not built; app icon and splash are the Expo template placeholders. No certificate pinning: `PinnedTransport`
is an interface and `unpinnedTransport` does plain TLS, so a real connection would not be protected from interception.
The REST paths in `GustafClient` are assumptions until the desktop server exists.
