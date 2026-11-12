# App sign-in handoff

The Gustaf cloud API (`apps/api`) signs users in with GitHub through Better Auth. Browsers keep the
session in a cookie. The desktop shell and the mobile app open the system browser instead and need
a bearer token back, so `/v1/auth/app/*` runs an OAuth-style authorization code flow with PKCE
([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)) on top of the normal GitHub sign-in. The code
lives in [`apps/api/src/auth/app-sign-in*.ts`](../../apps/api/src/auth/).

## Endpoints

1. `GET /v1/auth/app/start?redirect_uri=&code_challenge=&code_challenge_method=S256&state=`
   The app opens this in the system browser. The server validates the parameters, stores the
   request for 10 minutes under the hash of a random nonce, sets that nonce as an HttpOnly cookie,
   and answers `302` to GitHub through Better Auth's `signInSocial`. Invalid input gets `400`
   `{ "error": "invalid_redirect_uri" | "invalid_code_challenge_method" | "invalid_code_challenge" | "invalid_state" }`.
   `code_challenge` is the 43-character base64url SHA-256 of the verifier; `state` is 1-512
   printable ASCII characters and comes back unchanged.
2. `GET /v1/auth/app/done`
   Better Auth's callback (`/v1/auth/callback/github`) redirects here on success and on failure.
   The server consumes the stored request, reads the session the callback just created, stores a
   one-time code bound to that user, session, `code_challenge` and `redirect_uri` (hashed, 2
   minutes), clears the browser's session cookie, and answers `302` to
   `redirect_uri?code=<code>&state=<state>`. Failures after the request is known go to
   `redirect_uri?error=<code>&state=<state>` (`access_denied` or another GitHub/Better Auth code,
   `request_expired`, `no_session`). Without a valid request cookie it answers a plain `400` page,
   since there is no trusted place to redirect to.
3. `POST /v1/auth/app/token` with JSON `{ "code", "code_verifier", "redirect_uri" }`
   Returns `{ "token", "expiresAt", "user": { "id", "name", "email", "image" } }`. `token` is a
   Better Auth session token for `Authorization: Bearer`; it works on every session-guarded route
   and ends with `POST /v1/auth/sign-out` or `DELETE /v1/sessions/:id`. Errors are `400`
   `{ "error": "invalid_request" }` for a malformed body, `400 { "error": "invalid_grant" }` for an
   unknown, expired, used or mismatched code, and `429 { "error": "rate_limited" }`.

## Allowed `redirect_uri`

Exact strings only: `gustaf://auth`, `gustaf-dev://auth`, `gustaf-preview://auth`, and
`http://127.0.0.1:<port>/callback` or `http://localhost:<port>/callback` with a port in
1024-65535 (the desktop shell listens once on a random port). No other hosts, paths, query strings,
fragments, credentials, or `https` loopback. The list is code, not configuration
(`isAllowedRedirectUri`), and is independent of `AUTH_TRUSTED_ORIGINS`.

## Threat notes

- **PKCE.** Custom schemes can be claimed by another app on the same device, and a loopback port
  can be raced by another local process, so the code in the redirect is not secret. Only the app
  that started the flow holds the verifier, and the token endpoint compares `S256(verifier)` with
  the stored challenge in constant time. Only `S256` is accepted.
- **One-time hashed codes.** Codes are 256 random bits, stored as SHA-256, valid for 2 minutes,
  and marked used under a row lock in the same transaction that reads them. A database leak
  exposes no usable code. A second redemption is treated as theft (RFC 6749 section 4.1.2): it
  fails and revokes the session the first redemption handed out.
- **Browser binding.** `/done` finds the request through the nonce cookie set by `/start`, not a
  URL parameter, and accepts only a session created after that request. A crafted `/done` link
  therefore cannot mint a code for a victim's existing browser session.
- **One holder per session.** The session minted in the browser becomes the app's session, so
  `/done` expires the browser's session cookie.
- **Brute force.** Failed token exchanges are counted per client IP (10 per 10 minutes) in process
  memory. Several API instances each keep their own count; the codes are unguessable anyway, so
  the limit only blunts noise.
- **Logs.** The request logger records method and status only, so codes and tokens in query
  strings and bodies are never written.
- **Cleanup.** Expired requests and codes are deleted on the next write to their table; there is
  no background job.
