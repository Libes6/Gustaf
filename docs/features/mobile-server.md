# Mobile companion server (slice 1: read-only)

A local HTTPS + WebSocket server inside the Tauri backend (`src-tauri/src/mobile_server.rs` and `src-tauri/src/mobile_server/`) that the phone app (`apps/mobile`) talks to over the LAN. **Off by default**; Settings > Mobile (`src/components/MobileSettings.tsx`) turns it on. The wire types are `@mcode/protocol` (`PROTOCOL_VERSION` 1, routes under `/v1`).

This slice is **read-only**: no endpoint changes anything except pairing (which creates a device row).

## Lifecycle

- Master switch in Settings > Mobile. The choice (`enabled`, last `port`) is stored in the `settings` table (key `mobileServer`); when it was on, the server starts again with the app. It stops when the switch is turned off and on app exit (`RunEvent::Exit`).
- Commands: `mobile_server_start(port?)`, `mobile_server_stop`, `mobile_server_status`, `mobile_pairing_start`, `mobile_pairing_cancel`, `mobile_devices`, `mobile_device_revoke`, `mobile_report_status`.
- Port: omitted = the remembered one (random free port the first time; if the remembered port is taken, another is picked), `0` = new random, `n` = exactly n (error if busy).
- The server runs on its own 2-thread tokio runtime; the Tauri commands are synchronous.

## Network and TLS

- Binds **one private IPv4 address** (RFC 1918: 10/8, 172.16/12, 192.168/16), found by asking the OS which interface routes to the LAN (a UDP `connect`, no packet sent). Never `0.0.0.0`, never a public, CGNAT (100.64/10), link-local or IPv6 address (`net.rs`, tested). Loopback exists only behind a test-only config flag that no command sets.
- Connections from non-private peers are dropped before the TLS handshake. At most 64 concurrent connections, 10 s TLS handshake timeout, 15 s header timeout, 20 s request timeout, 4 KiB pairing body, 32 sockets (4 per device).
- TLS: rustls (ring), self-signed certificate generated once with `rcgen`, stored as `mobile-server/cert.der` + `key.der` in the app data dir (key file mode 0600 on Unix), valid 10 years. Regenerated only when the files are missing or unusable; that changes the fingerprint and the phones must pair again. The SHA-256 fingerprint of the DER certificate is shown in the page and carried by the QR; the phone pins it (there is no CA).

## Pairing

- The page shows a QR with `mcode://pair?host=…&port=…&code=…&fp=<sha256 hex>&v=<protocol>` (built in `src/lib/mobilePairing.ts`, encoded locally by `qrcode-generator`, drawn as inline SVG; a node test parses it with `apps/mobile/src/lib/pairing.ts`) and the code as text.
- Code: 8 symbols from a 32-symbol alphabet without look-alikes (40 bits), valid 2 minutes, single use, a new code invalidates the previous one.
- `POST /v1/pair {code, deviceName, publicInfo?, protocol?}` returns `{protocol, deviceId, token, desktopName}`. The token is 32 random bytes (base64url), shown once; only its SHA-256 is stored in `paired_devices(id, name, token_hash, created_at, last_seen_at, revoked_at)`. `publicInfo` is validated and bounded, not stored.
- Wrong, expired, reused and never-issued codes give the same 401. Rate limit: 5 failed attempts per minute per address lock that address out for 5 minutes (429 + `Retry-After`, even for the right code). In addition a code is burned after 5 wrong submissions from any addresses, so an attacker gets at most 5 guesses per code (5 / 2^40) however many addresses they have. At most 16 active devices.

## Authentication

Every other route needs `Authorization: Bearer <token>`. The token is hashed and compared against all active hashes in constant time (no early exit). Missing, malformed, unknown and revoked tokens get one identical 401 body; auth is checked before routing, so unauthenticated clients cannot probe which paths exist. 20 failed checks per minute per address throttle that address for a minute (429). `last_seen_at` is written at most every 15 s per device.

Revoking (Settings > Mobile) sets `revoked_at`: the next request is rejected (the database is consulted on every request, so a revoke by any writer works at once) and the device's WebSockets are closed.

## Read API

| Route | Result |
| --- | --- |
| `GET /v1/info` | `{protocol, app, appVersion, desktopName}` |
| `GET /v1/projects` | `ProjectSummary[]` (id, name, pinned; no filesystem paths), at most 500 |
| `GET /v1/chats?project=&archived=&limit=` | `ChatSummary[]` (default 200, max 500; archived chats only with `archived=1`; chats without a project are not listed) with `running` and `status` (`idle/running/waiting/done/failed`) |
| `GET /v1/chats/:id/messages?limit=&before=` | `ChatMessage[]`, oldest first; the newest page unless `before` (a message id) is given; default 50, max 100 |
| `GET /v1/events` (WebSocket) | `ServerEvent` frames: `hello`, `message.created`, `chat.updated`, `run.finished` |

Limits and sanitising (`data.rs`): text per message is cut at 20,000 characters, at most 50 tool cards per message with one-line summaries of 160 characters, titles 200. Images are never sent (`[image omitted]`). **Tool output is not sent at all** (the protocol has only the summary). Titles, text and summaries pass through `redact_secrets` (`redact.rs`), a port of `redactSecrets` in `src/lib/exportChats.ts` (keep them in step); it is best effort. Harness wrappers (`<file>` blocks, system notifications, compaction summaries) are hidden like in the chat view. Errors are generic; database messages go only to stderr.

## How the data is read

The server opens `app.db` itself with two SQLite connections (WAL mode, so the webview's writes and the server's reads do not block each other): a **read-only** one (`SQLITE_OPEN_READ_ONLY` + `query_only`) for projects, chats and messages, so a bug here cannot alter conversations, and a read-write one used only for `paired_devices`. Rejected alternative: going through the webview for every request (the app would have to be in the foreground and responsive, and every request would run in the UI process).

## Events and run status

- New messages and changed chats come from polling the database every 750 ms, only while at least one socket is connected (baseline taken at the first subscriber, nothing is announced for existing data). Polling needs no hook in the code paths that write.
- Run status (`running`, `waiting` for approval, `failed`, `done` = finished unseen) exists only in the webview. `MobileStatusBridge` (`src/components/MobileBridge.tsx`, mounted in `App.tsx`) derives it with the sidebar's `deriveStatus` and reports it with `mobile_report_status` on every change; the server keeps the latest report. With no webview, every chat reads `idle`. `run.finished` is sent when a running chat stops; `idle` after running is reported as `done` (a stopped run cannot be told apart).
- A socket that cannot keep up is closed (code 1013) and must reconnect and refetch. Pings every 20 s, idle sockets (75 s) are dropped; a socket's device is re-checked every ping.

## Threat model

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| LAN attacker connects | Private-address bind, peer filter, every route needs a token, TLS | Anyone on the LAN can reach the port (TLS handshakes, 401s). Do not enable on public networks |
| LAN attacker sniffs or modifies traffic / impersonates the desktop | TLS 1.2/1.3; the phone pins the certificate fingerprint from the QR | The QR must be scanned in person; the pin check is the phone's job (`PinnedTransport` in `apps/mobile` is future work, today the mobile client is unpinned) |
| Brute-forcing the pairing code | 40-bit code, 2 min, single use, 5 guesses per code, per-IP lockout | An attacker who sees the QR or code on screen wins; keep it hidden |
| Stolen device token | 256-bit random, only the hash stored, revoke at once from Settings | A token stolen from a phone works until revoked (read-only access to chat text) |
| Database leak | Hashes only | The TLS private key is a plain 0600 file in the app data dir |
| Secrets in chats | Redaction, no tool output, no images, no paths | Redaction is pattern based; a secret in plain prose can pass |
| Resource exhaustion | Connection, socket, body, time and result limits | A determined LAN host can still occupy connection slots |

## Not covered / next

- **Write endpoints**: send message, stop a run, resolve an approval (`POST /v1/chats/:id/messages`, `/stop`, `POST /v1/approvals/:id`), message streaming deltas and tool updates, approval events. This is the next task.
- Relay or tunnel for use outside the LAN, mDNS discovery, IPv6, several interfaces at once.
- The mobile client still uses unprefixed paths (`/pair`, `/projects`, `/events`) and no certificate pinning; it must move to `/v1` and the pinned transport.
- Not exercised on a real phone or a real LAN, only on loopback.

## Dependencies added (`src-tauri/Cargo.toml`, `apps/desktop/package.json`)

`tokio-tungstenite` (+ `tungstenite`, `data-encoding`) for the WebSocket framing, `rcgen` (+ `yasna`) for the certificate, and direct entries for crates already in the tree: `tokio`, `tokio-rustls` (ring), `hyper` (server, http1), `hyper-util`, `http-body-util`, `futures-util`, `sha2`, `subtle`, `getrandom`. npm: `qrcode-generator` (MIT, no dependencies) for the QR.
