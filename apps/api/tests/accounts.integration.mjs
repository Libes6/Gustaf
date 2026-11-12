import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeTest from "node:test";
import pg from "pg";
import { createApp } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import { runMigrations } from "../dist/database/migrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database");

// GitHub is stubbed at the network boundary: Better Auth runs its real OAuth callback code.
const githubProfiles = new Map();
const githubRedirects = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
    const body = new URLSearchParams(String(init.body));
    githubRedirects.push(body.get("redirect_uri"));
    return Response.json({ access_token: `at-${body.get("code")}`, token_type: "bearer" });
  }
  if (url.origin === "https://api.github.com") {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const profile = githubProfiles.get(authorization.replace(/^Bearer at-/, ""));
    if (!profile) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (url.pathname === "/user") return Response.json({ ...profile, email: null });
    if (url.pathname === "/user/emails") {
      return Response.json([{ email: profile.email, primary: true, verified: true }]);
    }
  }
  return realFetch(input, init);
};

function githubUser(login) {
  const suffix = NodeCrypto.randomUUID().slice(0, 8);
  const profile = {
    id: NodeCrypto.randomInt(1, 2 ** 31),
    login: `${login}-${suffix}`,
    name: login,
    email: `${login}-${suffix}@example.test`,
    avatar_url: null,
  };
  githubProfiles.set(profile.login, profile);
  return profile;
}

async function freePort() {
  const server = NodeNet.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function withApi(run) {
  await runMigrations(databaseUrl);
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const app = await createApp(
    readConfig({
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: "integration-test-secret-integration-test",
      PUBLIC_BASE_URL: base,
      GITHUB_CLIENT_ID: "integration-client",
      GITHUB_CLIENT_SECRET: "integration-secret",
      AUTH_TRUSTED_ORIGINS: "gustaf://",
    }),
  );
  app.useLogger(false);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await app.listen(port, "127.0.0.1");
    await run({ base, pool, api: client(base) });
  } finally {
    await pool.end();
    await app.close();
  }
}

function client(base) {
  return async (path, { auth, method = "GET", body } = {}) => {
    const headers = { origin: base };
    if (auth?.cookie) headers.cookie = auth.cookie;
    if (auth?.bearer) headers.authorization = `Bearer ${auth.bearer}`;
    const init = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
}

async function signIn(base, profile, callbackURL = "/signed-in") {
  const start = await fetch(`${base}/v1/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ provider: "github", callbackURL }),
  });
  NodeAssert.equal(start.status, 200);
  const { url } = await start.json();
  const authorize = new URL(url);
  NodeAssert.equal(
    authorize.origin + authorize.pathname,
    "https://github.com/login/oauth/authorize",
  );
  const cookie = start.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const callback = await fetch(
    `${base}/v1/auth/callback/github?code=${profile.login}&state=${authorize.searchParams.get("state")}`,
    { headers: { cookie }, redirect: "manual" },
  );
  NodeAssert.equal(callback.status, 302);
  NodeAssert.equal(callback.headers.get("location"), callbackURL);
  const sessionCookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith("better-auth.session_token="));
  NodeAssert.ok(sessionCookie, "callback sets the session cookie");
  const bearer = callback.headers.get("set-auth-token");
  NodeAssert.ok(bearer, "callback exposes the bearer token");
  return { cookie: sessionCookie.split(";")[0], bearer };
}

async function registerDevice(api, auth, name, kind) {
  const response = await api("/v1/devices", { auth, method: "POST", body: { name, kind } });
  NodeAssert.equal(response.status, 201);
  return response.body;
}

NodeTest.test(
  "GitHub callback signs in by cookie and bearer, and sign-out ends the session",
  async () => {
    await withApi(async ({ base, api, pool }) => {
      const alice = githubUser("alice");
      const first = await signIn(base, alice);
      NodeAssert.equal(githubRedirects.at(-1), `${base}/v1/auth/callback/github`);
      const stored = await pool.query(
        "select account_id, access_token from account where provider_id = 'github' and account_id = $1",
        [String(alice.id)],
      );
      NodeAssert.equal(stored.rows.length, 1);
      NodeAssert.notEqual(stored.rows[0].access_token, `at-${alice.login}`);
      const byCookie = await api("/v1/me", { auth: { cookie: first.cookie } });
      NodeAssert.equal(byCookie.status, 200);
      NodeAssert.equal(byCookie.body.user.email, alice.email);
      const byBearer = await api("/v1/me", { auth: { bearer: first.bearer } });
      NodeAssert.equal(byBearer.body.user.id, byCookie.body.user.id);

      const again = await signIn(base, alice, "gustaf://auth/done");
      const second = await api("/v1/me", { auth: { bearer: again.bearer } });
      NodeAssert.equal(second.body.user.id, byCookie.body.user.id);

      const signOut = await api("/v1/auth/sign-out", {
        auth: { bearer: first.bearer },
        method: "POST",
      });
      NodeAssert.equal(signOut.status, 200);
      NodeAssert.equal((await api("/v1/me", { auth: { bearer: first.bearer } })).status, 401);
      NodeAssert.equal((await api("/v1/me", { auth: { cookie: first.cookie } })).status, 401);
      NodeAssert.equal((await api("/v1/me", { auth: { bearer: again.bearer } })).status, 200);
    });
  },
);

NodeTest.test("two users cannot see or revoke each other's devices or sessions", async () => {
  await withApi(async ({ base, api }) => {
    const alice = await signIn(base, githubUser("alice"));
    const bob = await signIn(base, githubUser("bob"));
    const laptop = await registerDevice(api, { bearer: alice.bearer }, "Laptop", "computer");
    await registerDevice(api, { bearer: alice.bearer }, "Pixel", "phone");
    await registerDevice(api, { bearer: bob.bearer }, "Desktop", "computer");

    const aliceDevices = await api("/v1/devices", { auth: { bearer: alice.bearer } });
    NodeAssert.deepEqual(
      aliceDevices.body.devices.map((device) => [device.name, device.kind]),
      [
        ["Laptop", "computer"],
        ["Pixel", "phone"],
      ],
    );
    NodeAssert.ok(aliceDevices.body.devices.every((device) => !("tokenHash" in device)));
    const bobDevices = await api("/v1/devices", { auth: { bearer: bob.bearer } });
    NodeAssert.deepEqual(
      bobDevices.body.devices.map((device) => device.name),
      ["Desktop"],
    );

    const bobAuth = { bearer: bob.bearer };
    const foreign = laptop.device.id;
    NodeAssert.equal(
      (await api(`/v1/devices/${foreign}`, { auth: bobAuth, method: "DELETE" })).status,
      404,
    );
    NodeAssert.equal(
      (await api(`/v1/devices/${foreign}/token`, { auth: bobAuth, method: "POST" })).status,
      404,
    );
    NodeAssert.equal(
      (await api(`/v1/devices/not-a-uuid`, { auth: bobAuth, method: "DELETE" })).status,
      404,
    );
    NodeAssert.equal(
      (await api(`/v1/devices/${NodeCrypto.randomUUID()}`, { auth: bobAuth, method: "DELETE" }))
        .status,
      404,
    );
    NodeAssert.equal(
      (await api("/v1/devices/self", { auth: { bearer: laptop.token } })).status,
      200,
    );

    const aliceSession = (await api("/v1/me", { auth: { bearer: alice.bearer } })).body.session;
    const bobSessions = await api("/v1/sessions", { auth: bobAuth });
    NodeAssert.ok(bobSessions.body.sessions.every((session) => session.id !== aliceSession.id));
    NodeAssert.equal(
      (await api(`/v1/sessions/${aliceSession.id}`, { auth: bobAuth, method: "DELETE" })).status,
      404,
    );
    NodeAssert.equal((await api("/v1/me", { auth: { bearer: alice.bearer } })).status, 200);
  });
});

NodeTest.test(
  "device tokens are separate credentials that stop working on rotation and revocation",
  async () => {
    await withApi(async ({ base, api }) => {
      const owner = await signIn(base, githubUser("carol"));
      const auth = { bearer: owner.bearer };
      const { device, token } = await registerDevice(api, auth, "Workstation", "computer");
      NodeAssert.equal(device.lastSeenAt, null);
      NodeAssert.equal((await api("/v1/me", { auth: { bearer: token } })).status, 401);
      NodeAssert.equal((await api("/v1/devices/self", { auth })).status, 401);

      const self = await api("/v1/devices/self", { auth: { bearer: token } });
      NodeAssert.equal(self.status, 200);
      NodeAssert.equal(self.body.device.id, device.id);
      const listed = await api("/v1/devices", { auth });
      NodeAssert.ok(listed.body.devices[0].lastSeenAt);

      const rotated = await api(`/v1/devices/${device.id}/token`, { auth, method: "POST" });
      NodeAssert.equal(rotated.status, 200);
      NodeAssert.notEqual(rotated.body.token, token);
      NodeAssert.equal((await api("/v1/devices/self", { auth: { bearer: token } })).status, 401);
      NodeAssert.equal(
        (await api("/v1/devices/self", { auth: { bearer: rotated.body.token } })).status,
        200,
      );

      NodeAssert.equal(
        (await api(`/v1/devices/${device.id}`, { auth, method: "DELETE" })).status,
        204,
      );
      NodeAssert.equal(
        (await api("/v1/devices/self", { auth: { bearer: rotated.body.token } })).status,
        401,
      );
      NodeAssert.deepEqual((await api("/v1/devices", { auth })).body.devices, []);
      NodeAssert.equal(
        (await api(`/v1/devices/${device.id}`, { auth, method: "DELETE" })).status,
        404,
      );
    });
  },
);

NodeTest.test("a revoked session stops working at once", async () => {
  await withApi(async ({ base, api }) => {
    const profile = githubUser("dave");
    const phone = await signIn(base, profile);
    const laptop = await signIn(base, profile);
    const sessions = await api("/v1/sessions", { auth: { bearer: laptop.bearer } });
    NodeAssert.equal(sessions.body.sessions.length, 2);
    NodeAssert.equal(sessions.body.sessions.filter((session) => session.current).length, 1);
    NodeAssert.ok(sessions.body.sessions.every((session) => !("token" in session)));
    const other = sessions.body.sessions.find((session) => !session.current);

    const revoke = await api(`/v1/sessions/${other.id}`, {
      auth: { bearer: laptop.bearer },
      method: "DELETE",
    });
    NodeAssert.equal(revoke.status, 204);
    NodeAssert.equal((await api("/v1/me", { auth: { bearer: phone.bearer } })).status, 401);
    NodeAssert.equal((await api("/v1/me", { auth: { cookie: phone.cookie } })).status, 401);
    NodeAssert.equal((await api("/v1/me", { auth: { bearer: laptop.bearer } })).status, 200);
  });
});

NodeTest.test(
  "account deletion removes the user, sessions, OAuth accounts and devices",
  async () => {
    await withApi(async ({ base, api, pool }) => {
      const profile = githubUser("erin");
      const first = await signIn(base, profile);
      const second = await signIn(base, profile);
      const auth = { bearer: first.bearer };
      const { token } = await registerDevice(api, auth, "Phone", "phone");
      const userId = (await api("/v1/me", { auth })).body.user.id;
      const bystander = await signIn(base, githubUser("frank"));
      const bystanderDevice = await registerDevice(
        api,
        { bearer: bystander.bearer },
        "PC",
        "computer",
      );

      NodeAssert.equal((await api("/v1/me", { auth, method: "DELETE" })).status, 204);
      NodeAssert.equal((await api("/v1/me", { auth })).status, 401);
      NodeAssert.equal((await api("/v1/me", { auth: { bearer: second.bearer } })).status, 401);
      NodeAssert.equal((await api("/v1/devices/self", { auth: { bearer: token } })).status, 401);
      const { rows } = await pool.query(
        `select (select count(*) from "user" where id = $1)::int as users,
              (select count(*) from session where user_id = $1)::int as sessions,
              (select count(*) from account where user_id = $1)::int as accounts,
              (select count(*) from device where user_id = $1)::int as devices`,
        [userId],
      );
      NodeAssert.deepEqual(rows[0], { users: 0, sessions: 0, accounts: 0, devices: 0 });
      NodeAssert.equal(
        (await api("/v1/devices/self", { auth: { bearer: bystanderDevice.token } })).status,
        200,
      );

      const returning = await signIn(base, profile);
      const me = await api("/v1/me", { auth: { bearer: returning.bearer } });
      NodeAssert.equal(me.status, 200);
      NodeAssert.notEqual(me.body.user.id, userId);
    });
  },
);
