# Gustaf relay

A phone reaches the Gustaf server on the user's computer from any network through our cloud API
(`apps/api`, `api.libes6.ru`). The relay forwards ciphertext: the phone and the computer run an
end-to-end encrypted Noise session through it. Direct routes (LAN, Tailscale) keep working; the relay
needs nothing installed and works over any VPN, which matters because Android allows one VPN at a
time.

Not chosen: Cloudflare Tunnel (decrypts at Cloudflare, gives every computer a public hostname, and
needs a powerful Cloudflare token on our side), and a TLS-terminating relay (whoever runs or breaks
into it reads every conversation and can drive every connected computer). T3 Connect picked
Cloudflare for scale; with tens or hundreds of users, carrying the bytes ourselves is cheap.

## Pieces

- **Relay hub** ([`relay.hub.ts`](../../apps/api/src/relay/relay.hub.ts)): `/v1/relay` WebSocket.
  Both ends say `hello` with their device token (`gdt_…`); only a `computer` device may be a host. A
  client opens a channel to a host of the same user; another user's host answers exactly like an
  offline one. Presence lives in memory (one process). Frames are `[u32 channel][Noise message]`;
  the hub rewrites the channel id and copies the rest.
- **Host** ([`RelayHost.ts`](../../apps/server/src/relay/RelayHost.ts),
  [`RelayHostEngine.ts`](../../apps/server/src/relay/RelayHostEngine.ts)): the Node server, not the
  Rust shell, owns the connection, because the server is the one process every install has and the
  tunnel replays requests against it. The desktop shell keeps the device token in its encrypted
  account file and hands it to `PUT /api/relay-host/credential`; the page never sees it.
- **Client** ([`relayTunnelClient.ts`](../../packages/shared/src/relayTunnelClient.ts)): one tunnel
  per computer with `fetch` and `WebSocket` look-alikes. On mobile the runtime's HTTP client and
  WebSocket layer route `https://<host-device-id>.relay.gustaf.invalid` through it, so the
  connection supervisor, auth, routes and RPC need no relay-specific code. Features that call
  `fetch` or `new WebSocket` themselves go through the same pool. That origin is a `relay` route,
  ranked behind every direct one, so a phone at home uses the LAN.

## Crypto

`Noise_XX_25519_ChaChaPoly_BLAKE2s` ([`relayNoise.ts`](../../packages/shared/src/relayNoise.ts)) on
the `@noble` primitives, one implementation for Node and Hermes, checked against the cacophony and
snow test vectors. Only XX: pairing and reconnects use the same handshake, and each side checks the
other's static key afterwards. IK would save one round trip per reconnect and is not worth a second
pattern. The prologue binds the two device ids the relay vouched for. WebSocket delivery is ordered,
so the implicit Noise nonce is the replay and reorder protection; there is no rekey (64-bit nonces).

Static keys never leave the devices: the computer's in the server secret store, the phone's in the
keychain. The phone accepts only the host key from the QR code, so the relay cannot sit in the middle
of the first handshake.

## Pairing

1. Settings → Sharing & access → Connect a phone shows `gustaf://relay-pair?…`: relay origin, host
   device id, host static key, a one-time secret (5 minutes, burned on first use) and the name.
2. The phone handshakes through the relay and sends its name and the secret in the third message.
3. The computer lists it under "Allow …?" with a safety code; nothing reaches the local server before
   the user allows it.
4. On approval the computer stores the phone's key and sends a one-time environment pairing code
   inside the tunnel. The phone redeems it at its virtual relay origin through the normal pairing
   flow, so the session is an ordinary one.
5. Later the key alone opens the tunnel. A known phone that scans again gets a new pairing code
   without a second approval. Revoking the key closes its tunnel and refuses new ones; the phone's
   session then has no route left.

Safety codes come from both static keys, so they are stable and match on both screens: the phone
shows it while it waits for approval and on the relay route afterwards.

Pairing, approving and revoking are refused for requests that came through the tunnel (the host
sets `x-gustaf-relay` on every replayed request and drops a client's own). A lost phone with an
allowed key cannot let in another device; that needs this computer or a direct route.

## What the relay sees

User and device ids, connection times, IP addresses, byte counts (`relay_usage`, per user and UTC
month). Not prompts, files, diffs or tool output. It cannot act as either end: it holds no static key.
A stolen device token alone opens nothing: the handshake needs the phone's key and an approval.
Encryption does not help against a compromised device or a malicious app update.

## Limits

- Frames up to 64 KiB; HTTP bodies and large socket messages are cut into 60 KiB chunks. A peer
  whose socket buffers more than 8 MiB is disconnected; the host waits for its own buffer to drain
  while streaming a response.
- Per client 8 channels, per host 64, per user 20 sockets.
- `RELAY_MONTHLY_GB` (default 100) per user: over it, new channels are refused (`limit`), open ones
  finish.
- 30 connection attempts per client IP per minute, refused before any database work. The IP comes
  from `X-Forwarded-For` behind `TRUST_PROXY` hops (Traefik on Coolify).
- Revoked devices and banned users lose their sockets within one 30 s heartbeat.
- Sockets that die silently (sleep, network change) are found by `ping`/`pong` control messages:
  the host pings every 25 s and reconnects after 60 s of silence; the phone pings when idle and
  before new work on a quiet tunnel.
- Native views (image, video, PDF, sharing) load URLs themselves and cannot reach the made-up
  relay origin. `apps/mobile/src/features/relay/relayAssetFiles.ts` downloads such a URL through
  the tunnel into the cache first, so the whole file sits in memory once. WebViews that load an
  environment page by URL (HTML file previews, rendered HTML) and the device hub video stream
  are not carried.

## Open

- A host without the desktop shell (the `gustaf` command) has no way to receive the device credential.
- Independent security review (a second model and a human) and a load test with realistic sessions.
- Scale-out beyond one API process needs shared presence.
