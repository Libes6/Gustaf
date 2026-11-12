# Relay: reach your computer from any network

Status: proposed, 2026-11-13. Owner: Gustaf.

## Why

A phone must reach the Gustaf server on the user's computer when both are on different networks. The decision inputs from the owner: it has to be safe, it has to cost little, and the people who use Gustaf run a VPN all the time. Android allows one VPN at a time, so a VPN-based answer (Tailscale or Headscale) is not the default. LAN and Tailscale routes keep working as routes; this document adds the one that needs nothing installed.

## Decision

Run our own relay in the cloud API (`apps/api`, `api.libes6.ru`) and make it **end-to-end encrypted** between the two devices. The relay forwards ciphertext and routing metadata only. Clients prefer a direct route (LAN, Tailscale) when one answers and fall back to the relay.

Not chosen: Cloudflare Tunnel (puts every user's agent-controlling server on a public hostname and makes us hold a powerful Cloudflare token), and a plain TLS-terminating relay (the relay operator, and anyone who compromises it, would read every conversation and could drive every connected computer).

## Roles

- **Host**: the Gustaf server on the computer (`apps/server`). Opens one outbound WebSocket to the relay. No inbound ports, works behind NAT.
- **Client**: the phone app, or another desktop. Opens one WebSocket to the relay for a chosen host.
- **Relay**: `apps/api`. Authenticates both ends, pairs them by device id, copies frames. Keeps presence in memory.

## Identity

- User accounts and device credentials already exist (GitHub sign-in, `POST /v1/devices`, hashed device tokens, revocation).
- The relay accepts a **host** connection with a device token and a **client** connection with a user session or device token; a client may open only hosts owned by the same user (404 otherwise).
- Each device also owns an **identity key pair** (X25519 for key exchange, Ed25519 for signing if needed) generated on the device and stored in the OS credential store (Keychain, Secure Store). Private keys never leave the device and never reach the relay.

## Pairing (once per client and host)

1. The host shows a QR code: relay URL, host device id, the host's public key fingerprint, and a one-time secret that expires in minutes.
2. The client scans it, connects to the relay, and runs a Noise handshake with the host through the relay, proving knowledge of the one-time secret.
3. The host asks its user to **approve the new device** by name. On approval it stores the client's public key; the QR secret is burned.
4. Later connections use the stored public keys (Noise IK), so reconnecting needs no QR.
5. Revoking a device removes its key on the host and revokes its credential in the cloud; an open session is closed.

The fingerprint in the QR is the out-of-band check that stops the relay from sitting in the middle of the first handshake.

## Wire shape

- **Control plane** (JSON over the WebSocket, readable by the relay): `hello` (token, role, device id), presence, `connect` / `accept` / `reject`, errors, keepalive.
- **Data plane** (binary frames, opaque to the relay): `[session id][counter][ciphertext]`. Inside the encrypted channel two message kinds carry the existing Gustaf transport without changing the server's API: `http` (request and response for `/api/*`, bodies chunked) and `ws` (open, message, close for the single `/ws` RPC socket that the client opens after a `/api/auth/websocket-ticket` ticket). The host replays them against `127.0.0.1`.
- Frame size cap, per-user concurrent session cap, and a per-user bandwidth budget (counted by the relay in bytes, never in content).

## Crypto

No custom cryptography. Use a maintained Noise implementation (Noise_XX for pairing, Noise_IK afterwards, X25519, ChaCha20-Poly1305, BLAKE2s) or libsodium primitives with a reviewed construction; check what runs in Node, Rust (the shell) and React Native before choosing. Forward secrecy per session, strictly increasing counters for replay protection, rekey on long sessions.

## What the relay can see

User and device ids, connection times, IP addresses, byte counts. It cannot read prompts, files, diffs or tool output, and it cannot act as a client or a host because it holds no device private key. A stolen device token alone does not open a session: the Noise handshake also needs the device's private key and, for a new device, the host's approval.

## Limits and cost

- Typical traffic is text: roughly 1 to 5 KB/s while a thread is active, about 1 to 3 GB a month for a heavy user (estimate, measure in phase 1).
- Node handles thousands of idle WebSockets on one core; keep presence in memory and write `last_seen` at most every few minutes.
- Not carried by the relay in v1: the device hub video stream.
- Cost: the existing server; check that the plan has a few hundred GB a month of traffic. Scale-out (several relay instances) needs shared state and is out of scope until needed.

## Availability and abuse

If the relay is down, direct routes keep working and clients show "relay unavailable". Hosts reconnect with backoff and jitter. The admin panel (`apps/admin`) can ban a user or revoke a device, which closes their relay sessions.

## Threats

| Threat | Mitigation |
|---|---|
| Relay or its database compromised | end-to-end encryption, no keys in the cloud |
| Man in the middle at first pairing | host fingerprint in the QR, one-time secret, host-side approval |
| Stolen device token | needs the device private key and an approved key on the host |
| Shoulder-surfed QR | expires in minutes, single use, approval needed on the host |
| Replay or reorder | counters inside the AEAD, session ids, rekey |
| Flooding the relay | auth before any data, frame and rate caps, per-user budgets |

## Phases

1. Relay service in `apps/api`: control plane, presence, metering, limits, admin hooks, tests with scripted host and client.
2. Host connector in `apps/server`: outbound connection, Noise responder, replay of `http` and `ws` against localhost, device approval flow.
3. Client transport in `packages/client-runtime` and the mobile app: relay route type, Noise initiator, QR scan, route preference (direct first).
4. Desktop UI: relay on or off, devices list, QR, approve or revoke.
5. Independent security review of the protocol and code (a second model and a human read), then a load test with realistic sessions.

## Open questions

- Noise library per runtime (Node, Rust, React Native) and its audit status.
- Large uploads and downloads (file previews, images): chunk size and backpressure.
- Whether the shell (Rust) or the Node server should own the host connector.
- Per-user monthly byte budget and what happens when it is exhausted.
