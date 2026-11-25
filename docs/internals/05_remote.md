# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. Direct access, Tailscale,
SSH, and T3 Connect change how the client reaches the server; they do not introduce a different
execution model.

## Identity is independent of the route

- An environment keeps its ID across restarts and endpoint changes. Repository identity can
  correlate clones across environments (preferring `upstream` for PR features, grouping forks by
  `origin`), but work never silently crosses environments.
- [Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts) publishes
  atomically and retains repair state so concurrent initializers choose the same winner; do not
  sweep that recovery state as temp cleanup.
- **Routes are untrusted hints.** Only the connecting client can prove reachability. Never fall back
  to loopback when a shareable endpoint is unavailable (loopback names the client's own machine).
  Verify a direct or learned route answers as the expected environment before sending credentials,
  and never let a token paired over HTTPS downgrade to plain HTTP.
- Pull request routing trust covers the saved route set: adding or changing a route revokes trust;
  reordering does not.

## Peer links

A [peer link](../../apps/server/src/peer/PeerLinks.ts) lets one environment's agents work in another
by signing in to the target's `/mcp` as an ordinary OAuth client (`t3code-peer-link`). The receiving
side lists and revokes it in Sharing & access like any other session, and owns its expiry/renewal.

- **Mode ceilings always narrow.** Forwarded calls carry the calling agent's modes in
  `T3-Mode-Limit`, which the receiving `/mcp` can only intersect downward with the link's approved
  access.
- **Non-full-access links are fenced by `linkOrigin`.** Threads launched by a peer link (and their
  derived forks, subagents, and spawned threads) carry an immutable `linkOrigin` stamp enforced in
  shared access rules ([`mcp/linkOrigin.ts`](../../apps/server/src/mcp/linkOrigin.ts)). Below full
  access, linked work can mutate only threads with the same origin, cannot touch projects, settings,
  scheduled tasks, or further links, and skips project setup scripts and worktree layout commands
  (in a project that declares a layout, a worktree launch or handoff for such a thread fails;
  restoring a missing folder brings back plain checkouts). Full-access links are not fenced because
  their agents already run as the receiving OS user.
- **Namespace idempotency keys.** All callers on the linking side share one session on the receiving
  side, so idempotency keys must be hashed with the caller's namespace before forwarding.
- **Clients read linked threads as standard thread streams.**
  [`PeerThreadRelay`](../../apps/server/src/peer/PeerThreadRelay.ts) proxies the same stream format
  read-only so there is no second transcript schema to maintain.

### Peer links over the Gustaf relay

A link's address can be the relay's made-up origin (`relayVirtualBaseUrl`) instead of a URL, so a
server links to another computer of the same Gustaf account with no address and no pairing code.
The server's own HTTP client routes that origin into a Noise tunnel
([`RelayPeerTransport`](../../apps/server/src/relay/RelayPeerTransport.ts)); everything above it
(probes, OAuth, `/mcp`, thread streams) is unchanged.

- **The account proves nothing about who is asking.** Any holder of an account's device token can
  open a channel to any of its hosts, so a host never lets an unknown key in on that basis. A
  request to link waits for the host's own user, every time, known key or not; the approved code is
  a typed link pairing code for exactly the access the user saw. It is held only while Linked
  environments is on, a few at a time, one per key, and dropped when the requester leaves.
- **First contact trusts the key the relay presents, and the safety code is the check.** There is no
  QR code to carry the host's key, so the requester takes it on first use and shows the code both
  keys produce; the host shows the same one. After approval the key is pinned and later tunnels
  fail on any other. Linking again re-pins, so the user compares the codes again.
- **The OAuth sign-in omits `resource` over the tunnel.** The host derives its own address from
  the request it receives, which the relay replays against loopback, so it would never equal the
  made-up origin; the endpoint treats the indicator as optional.
- **Responses stream.** Thread streams are event streams, so the server's tunnel clients hand a
  response over at its headers (`streamResponses`). Phone clients cannot build a streamed
  `Response` and keep collecting bodies.
- **The relay's machine list names the account's computers.** `GET /v1/relay/hosts` answers a
  device token with `online` ids and, since links, `computers` with names; a client older than that
  answers ids only.

### Pairing from the account's computer list

A phone or desktop app signed in to the account can ask one of its computers to pair, with no QR
code. It opens a tunnel with `accountPairing` in its hello and no link secret; the host then
behaves like a link request ([`RelayHost`](../../apps/server/src/relay/RelayHost.ts)).

- **A new key always waits for a person.** The account token only proves which account is asking,
  so a stolen one can start a request but never finish it: waiting requests are capped
  separately from link requests, one per key, dropped when the requester leaves or after a few
  minutes. The safety code is the only check on the key taken at first contact, and the prompt
  says to allow it only if the user just started the request.
- **"Trust my other devices" repeats one decision, never widens it.** Off by default and stored
  beside the device list, not in server settings, so only a session with relay write scope on a
  direct route changes it. When on, a key whose user allowed it by hand as a client skips the
  prompt for an account pairing and gets the same pairing a hand-allowed phone gets. Keys allowed
  only as linked machines, keys from before the mark existed, and new keys still ask. A relay
  that swapped keys cannot use it: it holds no pinned key's secret.
- **Links are left out on purpose.** A link hands another computer's agents standing access, the
  requester takes this host's key on trust each time, and a used link renews itself, so a skipped
  prompt would remove the only human check for little convenience.
- **Revoking ends sessions the key opened.** Pairing credentials issued for a relay device carry
  the end of its key in the session label (and a marker when trust let it in), because a session
  works on any route and closing the tunnel alone would not end it. Turning trust off ends only the
  marked sessions; revoking a device ends all of its sessions and its tunnel.

## Hosted web is a client

Gustaf ships no hosted web app. A build that serves one sets `VITE_HOSTED_APP_URL` (web) or
`T3CODE_HOSTED_APP_URL` (server); with neither, copied thread and prompt links use the `gustaf://`
scheme and no hosted pairing link is offered.

Where one is set, the hosted web app stores its connection catalog in the browser and connects
directly to each environment without proxying traffic. A
[hosted pairing URL](../../apps/web/src/hostedPairing.ts) puts the backend target in the query and
the pairing secret in the URL fragment so the secret never reaches the hosted origin, then strips it
from history.

## Desktop previews tunnel loopback

A desktop webview for a remote environment keeps `localhost` URLs and tunnels loopback connections
through `/api/preview/tunnel` on the environment's own origin:

- **Fixed SOCKS5 proxy, not PAC.** Chromium ignores PAC scripts for loopback hosts. Use a fixed
  proxy that routes only loopback through the tunnel (excluding link-local addresses) and never
  falls back directly—a failed or disabled tunnel must error rather than silently load the
  reviewer's own localhost.
- **Media tickets and local-owner check.** Desktop main holds no environment credentials, so the
  renderer supplies a media ticket per connection (also tracking route switches). Because Chromium
  cannot authenticate to SOCKS5 and a forwarded port is a plain local port, on Linux and macOS both
  listeners serve only connections the system attributes to the current OS user (`/proc/net/tcp`
  on Linux, `lsof` on macOS), and a connection whose owner cannot be read is refused. On Windows
  the listeners do not check the owner.

## Access and process ownership are separate

- Tailscale supplies an endpoint for normal pairing; auth remains the environment's responsibility.
- [SSH cleanup](../../packages/ssh/src/tunnel.ts) stops a remote server only if the launcher started
  it; a server discovered already running must survive client disconnect.
- Remote servers outlive client releases. Clients negotiate features via advertised capabilities
  rather than assuming version parity. Process replacement uses the
  [update protocol](./07_server-updates.md).
