# Admin API

`/v1/admin/*` in the Gustaf cloud API (`apps/api/src/admin/`) backs the browser admin app
(`apps/admin`). The routes and response shapes are in
[`admin.controller.ts`](../../apps/api/src/admin/admin.controller.ts) and
[`admin.service.ts`](../../apps/api/src/admin/admin.service.ts); this page records the decisions
around them.

## Access

- A user is an admin when `user.role = "admin"`. `AdminGuard` resolves the Better Auth session
  (cookie or bearer) on every request: `401` signed out, `403` for any other role or a banned
  user. `GET /v1/me` returns `role` so clients can gate themselves; the server stays
  authoritative.
- Better Auth's admin plugin provides the `role`, `banned`, `banReason` and `banExpires` user
  columns, the `impersonatedBy` session column, and the hook that refuses new sessions for banned
  users. Its own HTTP endpoints under `/v1/auth/admin/*` are never served (`app.ts`), so
  impersonation, password setting and user creation are unreachable. Our routes write the tables
  directly so each mutation and its audit row commit in one transaction.
- Admins cannot change the role of, ban, or delete their own account (`400`), so the last admin
  cannot lock everyone out by accident.

## Bootstrapping admins

`ADMIN_GITHUB_LOGINS` is a comma-separated, case-insensitive list of GitHub logins. After every
successful GitHub sign-in (including the app handoff) the server stores the user's current GitHub
login in `user.github_login` and sets `role = "admin"` when that login is listed. It never
demotes: removing a login from the list changes nothing until someone calls
`PATCH /v1/admin/users/:id/role`. An empty list promotes nobody. A listed login that signs in again
after an explicit demotion is promoted again, so remove it from the list first.

Better Auth drops provider profile fields that are not its own, so the login cannot travel through
`mapProfileToUser`. The GitHub provider's `mapProfileToUser` remembers the login by GitHub account
id in process memory, and the after-hook of the same callback request reads it back through the
user's `account` row (`auth.ts`). Users who have not signed in since this shipped have no
`github_login` yet, and search by login does not find them.

## Browser security

The admin app runs on `ADMIN_ORIGIN` (for example `https://admin.libes6.ru`) and calls the API
with `fetch(..., { credentials: "include" })`.

- **CORS** is credentialed and allows only the exact `ADMIN_ORIGIN`, plus
  `http://localhost:5174` outside `NODE_ENV=production`. No wildcard; with neither, no CORS headers
  are sent. The same origins are added to Better Auth's trusted origins so the admin app can start
  GitHub sign-in and sign out.
- **Cookies** keep Better Auth's defaults: host-only on the API host, `HttpOnly`,
  `SameSite=Lax`, and `Secure` because `PUBLIC_BASE_URL` is https in production. Admin and API
  share the registrable domain, so the admin app's requests are same-site and the `Lax` cookie is
  sent. No cross-subdomain cookie is configured; it would only widen where the session is
  readable.
- **CSRF**: every `POST`/`PATCH`/`DELETE` under `/v1/admin` needs `x-requested-with: gustaf-admin`
  (a non-simple header, so browsers must preflight) and, when the browser sends `Origin`, that
  origin must be an allowed admin origin. A request that carries cookies but no `Origin` is
  refused. Bearer clients without cookies (curl, scripts) need only the header.
- **Rate limit**: 300 requests per minute per client IP for `/v1/admin/*`, counted in process
  memory before authentication (`ADMIN_RATE_LIMIT`). Several API instances each keep their own
  count. Over the limit the answer is `429 { "error": "rate_limited" }`.

## Mutations

- **Ban** sets `banned` and `banReason` and deletes all of the user's sessions (bearer tokens are
  session tokens). Device tokens of a banned user stop authenticating while the ban lasts and work
  again after unban. Bans do not expire; `banExpires` stays null.
- **Device revoke** sets `device.revoked_at` instead of deleting the row, so the admin list keeps
  showing it. For its owner the device disappears from `GET /v1/devices` and answers `404`.
- **Delete** removes the user with the same cascade as `DELETE /v1/me`.
- Every mutation writes one `audit_log` row (`user.ban`, `user.unban`, `user.revoke_sessions`,
  `user.role_change`, `user.delete`, `device.revoke`) in the same transaction. `actor_id` is not a
  foreign key so the trail outlives deleted accounts. `meta` holds only non-secret context such as
  the ban reason, the old and new role, or the deleted user's name and GitHub login.

## Lists

List endpoints page newest first with `?limit=` (default 25, at most 100) and an opaque `?cursor=`
and answer `{ items, nextCursor }`. The cursor carries the last row's `created_at` as Postgres text
(microseconds) and id, because a millisecond JavaScript `Date` would skip or repeat rows that share a
millisecond. The audit cursor is the identity id.

## Ops pages

`GET /v1/admin/relay`, `/system` and `/releases` ([`ops.service.ts`](../../apps/api/src/admin/ops.service.ts))
are read-only.

- Relay presence and the "since start" outcome counters live in the relay hub's memory, like
  presence itself: one process, one relay. Daily totals go to `relay_daily` as aggregate counters
  only (bytes and outcome counts per UTC day, no user, device or address), flushed once a minute;
  the endpoint flushes first so today is current.
- Coolify backups and GitHub releases are fetched server-side and cached in memory (10 minutes and
  1 hour). A failed fetch is retried after a minute and the last good answer is served meanwhile,
  so a slow or rate-limited upstream never fails the page.
