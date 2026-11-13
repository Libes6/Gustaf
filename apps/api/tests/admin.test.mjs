import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  assertNotSelf,
  decodeCursor,
  encodeCursor,
  readPage,
  readSearch,
  toPage,
} from "../dist/admin/admin-rules.js";
import { AdminGuard } from "../dist/admin/admin.guard.js";
import { createApp } from "../dist/app.js";
import { parseGithubLogins, readConfig } from "../dist/config.js";
import { corsHeaders } from "../dist/cors.js";

const ADMIN = "https://admin.example.test";
const auth = {
  DATABASE_URL: "postgresql://hidden:secret@127.0.0.1:1/missing",
  BETTER_AUTH_SECRET: "unit-test-secret-unit-test-secret-0123",
  PUBLIC_BASE_URL: "https://api.example.test",
  GITHUB_CLIENT_ID: "unit-test-client",
  GITHUB_CLIENT_SECRET: "unit-test-secret",
};

function guardFor(session) {
  return new AdminGuard({ api: { getSession: async () => session } }, [ADMIN]);
}

function context(request) {
  const full = { ip: "203.0.113.1", ...request, headers: request.headers ?? {} };
  return { full, switchToHttp: () => ({ getRequest: () => full }) };
}

const asUser = (role, banned = false) => ({
  user: { id: "u1", role, banned },
  session: { id: "s1" },
});

NodeTest.test(
  "the admin guard answers 401 signed out, 403 for non-admins, and passes admins",
  async () => {
    await NodeAssert.rejects(
      guardFor(null).canActivate(context({ method: "GET" })),
      UnauthorizedException,
    );
    for (const session of [asUser("user"), asUser(null), asUser("admin", true)]) {
      await NodeAssert.rejects(
        guardFor(session).canActivate(context({ method: "GET" })),
        ForbiddenException,
      );
    }
    const admin = asUser("admin");
    const request = context({ method: "GET" });
    NodeAssert.equal(await guardFor(admin).canActivate(request), true);
    NodeAssert.equal(request.full.userSession, admin);
  },
);

NodeTest.test("admin mutations need the custom header and an allowed browser origin", async () => {
  const guard = guardFor(asUser("admin"));
  const xrw = { "x-requested-with": "gustaf-admin" };
  const cases = [
    [{ ...xrw, origin: ADMIN, cookie: "s=1" }, true],
    [{ ...xrw }, true], // bearer client without cookies or Origin
    [{ origin: ADMIN, cookie: "s=1" }, false],
    [{ "x-requested-with": "XMLHttpRequest", origin: ADMIN }, false],
    [{ ...xrw, origin: "https://evil.example.test", cookie: "s=1" }, false],
    [{ ...xrw, cookie: "s=1" }, false],
    [{ ...xrw, origin: "null" }, false],
  ];
  for (const [headers, allowed] of cases) {
    const attempt = guard.canActivate(context({ method: "POST", headers }));
    if (allowed) NodeAssert.equal(await attempt, true, JSON.stringify(headers));
    else await NodeAssert.rejects(attempt, ForbiddenException, JSON.stringify(headers));
  }
  // Reads stay plain GETs, so the admin app can use simple requests.
  NodeAssert.equal(await guard.canActivate(context({ method: "GET", headers: {} })), true);
});

NodeTest.test("the admin guard rate limits per IP before authenticating", async () => {
  const guard = guardFor(null);
  for (let i = 0; i < 300; i += 1) {
    await NodeAssert.rejects(guard.canActivate(context({ method: "GET" })), UnauthorizedException);
  }
  await NodeAssert.rejects(guard.canActivate(context({ method: "GET" })), (error) => {
    NodeAssert.ok(error instanceof HttpException);
    NodeAssert.equal(error.getStatus(), 429);
    return true;
  });
  await NodeAssert.rejects(
    guard.canActivate(context({ method: "GET", ip: "203.0.113.2" })),
    UnauthorizedException,
  );
});

NodeTest.test("admins cannot target their own account", () => {
  NodeAssert.throws(() => assertNotSelf("a", "a"), BadRequestException);
  NodeAssert.doesNotThrow(() => assertNotSelf("a", "b"));
});

NodeTest.test("ADMIN_GITHUB_LOGINS is a case-insensitive comma-separated list", () => {
  NodeAssert.deepEqual([...parseGithubLogins(undefined)], []);
  NodeAssert.deepEqual([...parseGithubLogins(" , ")], []);
  NodeAssert.deepEqual(
    [...parseGithubLogins(" Libes6, @Octo-Cat ,libes6")],
    ["libes6", "octo-cat"],
  );
  for (const bad of ["not a login", "-dash", "x".repeat(40), "a/b"]) {
    NodeAssert.throws(() => parseGithubLogins(bad), /ADMIN_GITHUB_LOGINS/);
  }
  NodeAssert.ok(
    readConfig({ ...auth, ADMIN_GITHUB_LOGINS: "Alice" }).auth.adminGithubLogins.has("alice"),
  );
});

NodeTest.test("ADMIN_ORIGIN is one exact origin; localhost:5174 only outside production", () => {
  const prod = { ...auth, NODE_ENV: "production" };
  NodeAssert.deepEqual(readConfig(prod).auth.adminOrigins, []);
  NodeAssert.deepEqual(readConfig({ ...prod, ADMIN_ORIGIN: `${ADMIN}/` }).auth.adminOrigins, [
    ADMIN,
  ]);
  NodeAssert.deepEqual(readConfig({ ...auth, ADMIN_ORIGIN: ADMIN }).auth.adminOrigins, [
    ADMIN,
    "http://localhost:5174",
  ]);
  NodeAssert.ok(readConfig({ ...prod, ADMIN_ORIGIN: ADMIN }).auth.trustedOrigins.includes(ADMIN));
  for (const bad of ["*", "admin.example.test", "http://admin.example.test", `${ADMIN}/app`]) {
    NodeAssert.throws(() => readConfig({ ...prod, ADMIN_ORIGIN: bad }), /ADMIN_ORIGIN/);
  }
});

NodeTest.test("cursor pagination helpers", () => {
  const key = ["2026-11-13 10:00:00.123456+00", "user-1"];
  NodeAssert.deepEqual(decodeCursor(encodeCursor(key), 2), key);
  for (const bad of ["%%%", encodeCursor(["only-one"]), encodeCursor([{}, "x"]), "e30"]) {
    NodeAssert.throws(() => decodeCursor(bad, 2), BadRequestException);
  }
  NodeAssert.deepEqual(readPage({}), { limit: 25, cursor: undefined });
  NodeAssert.deepEqual(readPage({ limit: "100", cursor: "abc" }), { limit: 100, cursor: "abc" });
  for (const limit of ["0", "101", "-1", "1.5", "ten", ["5"]]) {
    NodeAssert.throws(() => readPage({ limit }), BadRequestException);
  }
  NodeAssert.throws(() => readPage({ cursor: "" }), BadRequestException);

  const rows = [1, 2, 3].map((n) => ({ id: n }));
  const full = toPage(
    rows,
    2,
    (row) => row.id,
    (row) => [row.id],
  );
  NodeAssert.deepEqual(full.items, [1, 2]);
  NodeAssert.deepEqual(decodeCursor(full.nextCursor, 1), [2]);
  NodeAssert.deepEqual(
    toPage(
      rows.slice(0, 2),
      2,
      (row) => row.id,
      (row) => [row.id],
    ),
    {
      items: [1, 2],
      nextCursor: null,
    },
  );

  NodeAssert.equal(readSearch(undefined), undefined);
  NodeAssert.equal(readSearch("  "), undefined);
  NodeAssert.equal(readSearch("50%_a\\b"), "%50\\%\\_a\\\\b%");
  NodeAssert.throws(() => readSearch("x".repeat(201)), BadRequestException);
});

NodeTest.test("CORS allows credentials only for the exact admin origins", () => {
  const origins = [ADMIN];
  NodeAssert.equal(corsHeaders({ method: "GET", headers: {} }, origins), undefined);
  NodeAssert.equal(
    corsHeaders({ method: "GET", headers: { origin: "https://evil.example.test" } }, origins),
    undefined,
  );
  NodeAssert.equal(corsHeaders({ method: "GET", headers: { origin: ADMIN } }, []), undefined);
  NodeAssert.deepEqual(corsHeaders({ method: "GET", headers: { origin: ADMIN } }, origins), {
    "access-control-allow-origin": ADMIN,
    "access-control-allow-credentials": "true",
  });
  const preflight = corsHeaders(
    { method: "OPTIONS", headers: { origin: ADMIN, "access-control-request-method": "PATCH" } },
    origins,
  );
  NodeAssert.equal(preflight["access-control-allow-methods"], "GET, POST, PATCH, DELETE");
  NodeAssert.equal(preflight["access-control-allow-headers"], "content-type, x-requested-with");
});

NodeTest.test(
  "the app wires CORS, the admin guard, and hides the plugin's own endpoints",
  async () => {
    for (const [env, corsEnabled] of [
      [{ ...auth, NODE_ENV: "production" }, false],
      [{ ...auth, NODE_ENV: "production", ADMIN_ORIGIN: ADMIN }, true],
    ]) {
      const app = await createApp(readConfig(env));
      app.useLogger(false);
      try {
        await app.listen(0, "127.0.0.1");
        const url = await app.getUrl();
        const preflight = await fetch(`${url}/v1/admin/users/x/role`, {
          method: "OPTIONS",
          headers: { origin: ADMIN, "access-control-request-method": "PATCH" },
        });
        NodeAssert.equal(
          preflight.headers.get("access-control-allow-origin"),
          corsEnabled ? ADMIN : null,
        );
        if (corsEnabled) NodeAssert.equal(preflight.status, 204);
        const anonymous = await fetch(`${url}/v1/admin/overview`, { headers: { origin: ADMIN } });
        NodeAssert.equal(anonymous.status, 401);
        for (const path of ["relay", "system", "releases"]) {
          NodeAssert.equal((await fetch(`${url}/v1/admin/${path}`)).status, 401, path);
        }
        NodeAssert.equal(
          anonymous.headers.get("access-control-allow-credentials"),
          corsEnabled ? "true" : null,
        );
        const plugin = await fetch(`${url}/v1/auth/admin/impersonate-user`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: "x" }),
        });
        NodeAssert.equal(plugin.status, 404);
      } finally {
        await app.close();
      }
    }
  },
);
