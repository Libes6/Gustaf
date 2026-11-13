import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { githubUser, registerDevice, signIn, withApi } from "./support/github-sign-in.mjs";

const XRW = { "x-requested-with": "gustaf-admin" };

// One admin (promoted through ADMIN_GITHUB_LOGINS, matched case-insensitively) per test.
async function withAdmin(run) {
  const adminProfile = githubUser("root");
  await withApi(
    async (context) => {
      const admin = await signIn(context.base, adminProfile);
      const adminId = (await context.api("/v1/me", { auth: { bearer: admin.bearer } })).body.user
        .id;
      const as =
        (auth) =>
        (path, { method = "GET", body } = {}) =>
          context.api(path, { auth, method, body, headers: method === "GET" ? {} : XRW });
      await run({ ...context, admin, adminId, adminApi: as({ cookie: admin.cookie }), as });
    },
    (base) => ({
      ADMIN_GITHUB_LOGINS: `someone-else, ${adminProfile.login.toUpperCase()}`,
      ADMIN_ORIGIN: base,
    }),
  );
}

async function userIdOf(api, auth) {
  return (await api("/v1/me", { auth })).body.user.id;
}

async function auditFor(adminApi, targetId) {
  const audit = await adminApi("/v1/admin/audit?limit=100");
  NodeAssert.equal(audit.status, 200);
  return audit.body.items.filter((entry) => entry.targetId === targetId);
}

NodeTest.test(
  "admin routes answer 401 signed out and 403 for users; listed logins become admins",
  async () => {
    await withAdmin(async ({ base, api, admin, adminApi }) => {
      const profile = githubUser("ivan");
      const user = await signIn(base, profile);
      const me = await api("/v1/me", { auth: { bearer: user.bearer } });
      NodeAssert.equal(me.body.role, "user");
      NodeAssert.equal(me.body.user.role, "user");
      NodeAssert.equal(
        (await api("/v1/me", { auth: { cookie: admin.cookie } })).body.role,
        "admin",
      );

      NodeAssert.equal((await api("/v1/admin/overview")).status, 401);
      for (const path of ["users", "relay", "system", "releases"]) {
        NodeAssert.equal(
          (await api(`/v1/admin/${path}`, { auth: { bearer: user.bearer } })).status,
          403,
          path,
        );
      }
      NodeAssert.equal(
        (
          await api(`/v1/admin/users/${me.body.user.id}/ban`, {
            auth: { bearer: user.bearer },
            method: "POST",
            headers: XRW,
          })
        ).status,
        403,
      );

      // Cookie mutations need the custom header and the admin origin.
      const target = `/v1/admin/users/${me.body.user.id}/revoke-sessions`;
      NodeAssert.equal(
        (await api(target, { auth: { cookie: admin.cookie }, method: "POST" })).status,
        403,
      );

      const search = await adminApi(`/v1/admin/users?query=${profile.login.toUpperCase()}`);
      NodeAssert.equal(search.status, 200);
      NodeAssert.equal(search.body.nextCursor, null);
      NodeAssert.equal(search.body.items.length, 1);
      const [item] = search.body.items;
      NodeAssert.deepEqual(Object.keys(item).sort(), [
        "banReason",
        "banned",
        "createdAt",
        "deviceCount",
        "email",
        "githubLogin",
        "id",
        "image",
        "lastSeenAt",
        "name",
        "role",
        "sessionCount",
      ]);
      NodeAssert.equal(item.githubLogin, profile.login);
      NodeAssert.equal(item.role, "user");
      NodeAssert.equal(item.sessionCount, 1);
      NodeAssert.ok(item.lastSeenAt);
      NodeAssert.equal(
        (await adminApi(`/v1/admin/users?query=${profile.email}`)).body.items[0].id,
        item.id,
      );
      NodeAssert.equal(
        (await adminApi("/v1/admin/users?query=%25")).status,
        200,
        "LIKE wildcards are literal",
      );
      NodeAssert.equal((await adminApi("/v1/admin/users?limit=101")).status, 400);
      NodeAssert.equal((await adminApi("/v1/admin/users?cursor=bogus")).status, 400);
    });
  },
);

NodeTest.test("user and device lists page through every row exactly once", async () => {
  await withAdmin(async ({ base, api, adminApi }) => {
    const tag = githubUser("page").login;
    for (let index = 0; index < 5; index += 1) {
      const profile = githubUser(`${tag}-${index}`);
      const session = await signIn(base, profile);
      await registerDevice(api, { bearer: session.bearer }, `${tag} device ${index}`, "computer");
      await registerDevice(api, { bearer: session.bearer }, `${tag} phone ${index}`, "phone");
    }
    for (const [path, expected] of [
      [`/v1/admin/users?query=${tag}&limit=2`, 5],
      [`/v1/admin/devices?query=${tag}&limit=3`, 10],
      [`/v1/admin/devices?query=${tag}&kind=phone&limit=2`, 5],
    ]) {
      const seen = [];
      let cursor = null;
      do {
        const page = await adminApi(cursor ? `${path}&cursor=${cursor}` : path);
        NodeAssert.equal(page.status, 200);
        seen.push(...page.body.items);
        cursor = page.body.nextCursor;
      } while (cursor);
      NodeAssert.equal(seen.length, expected, path);
      NodeAssert.equal(new Set(seen.map((row) => row.id)).size, expected);
      const times = seen.map((row) => new Date(row.createdAt).getTime());
      NodeAssert.deepEqual(
        times,
        times.toSorted((a, b) => b - a),
        "newest first",
      );
    }
    const devices = await adminApi(`/v1/admin/devices?query=${tag}&kind=phone&limit=1`);
    NodeAssert.deepEqual(Object.keys(devices.body.items[0]).sort(), [
      "createdAt",
      "id",
      "kind",
      "lastSeenAt",
      "name",
      "revokedAt",
      "userId",
      "userName",
    ]);
    NodeAssert.equal((await adminApi("/v1/admin/devices?kind=tablet")).status, 400);
  });
});

NodeTest.test(
  "ban ends the user's sessions and devices and blocks sign-in until unban",
  async () => {
    await withAdmin(async ({ base, api, adminApi, adminId }) => {
      const profile = githubUser("judy");
      const user = await signIn(base, profile);
      const auth = { bearer: user.bearer };
      const userId = await userIdOf(api, auth);
      const { token } = await registerDevice(api, auth, "Laptop", "computer");

      NodeAssert.equal(
        (await adminApi(`/v1/admin/users/${adminId}/ban`, { method: "POST", body: {} })).status,
        400,
      );
      NodeAssert.equal(
        (await adminApi("/v1/admin/users/missing/ban", { method: "POST", body: {} })).status,
        404,
      );
      const ban = await adminApi(`/v1/admin/users/${userId}/ban`, {
        method: "POST",
        body: { reason: "spam" },
      });
      NodeAssert.equal(ban.status, 204);
      NodeAssert.equal((await api("/v1/me", { auth })).status, 401);
      NodeAssert.equal((await api("/v1/me", { auth: { cookie: user.cookie } })).status, 401);
      NodeAssert.equal((await api("/v1/devices/self", { auth: { bearer: token } })).status, 401);
      const detail = await adminApi(`/v1/admin/users/${userId}`);
      NodeAssert.equal(detail.body.banned, true);
      NodeAssert.equal(detail.body.banReason, "spam");
      NodeAssert.deepEqual(detail.body.sessions, []);

      // The admin plugin refuses to create a session for a banned user.
      const start = await fetch(`${base}/v1/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ provider: "github", callbackURL: "/signed-in" }),
      });
      const { url } = await start.json();
      const cookie = start.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const callback = await fetch(
        `${base}/v1/auth/callback/github?code=${profile.login}&state=${new URL(url).searchParams.get("state")}`,
        { headers: { cookie }, redirect: "manual" },
      );
      NodeAssert.ok(
        !callback.headers.getSetCookie().some((value) => value.includes("session_token=")),
        "no session for a banned user",
      );
      NodeAssert.match(callback.headers.get("location"), /error=BANNED_USER/);

      NodeAssert.equal(
        (await adminApi(`/v1/admin/users/${userId}/unban`, { method: "POST" })).status,
        204,
      );
      const back = await signIn(base, profile);
      NodeAssert.equal((await api("/v1/me", { auth: { bearer: back.bearer } })).status, 200);
      NodeAssert.equal((await api("/v1/devices/self", { auth: { bearer: token } })).status, 200);

      const trail = await auditFor(adminApi, userId);
      NodeAssert.deepEqual(
        trail.map((entry) => [entry.action, entry.actorId, entry.targetType]),
        [
          ["user.unban", adminId, "user"],
          ["user.ban", adminId, "user"],
        ],
      );
      NodeAssert.deepEqual(trail[1].meta, { reason: "spam" });
      NodeAssert.equal(typeof trail[1].actorName, "string");
    });
  },
);

NodeTest.test(
  "revoke-sessions, device revoke and role change take effect and are audited",
  async () => {
    await withAdmin(async ({ base, api, adminApi, adminId, as }) => {
      const profile = githubUser("ken");
      const first = await signIn(base, profile);
      const second = await signIn(base, profile);
      const userId = await userIdOf(api, { bearer: first.bearer });

      NodeAssert.equal(
        (await adminApi(`/v1/admin/users/${userId}/revoke-sessions`, { method: "POST" })).status,
        204,
      );
      NodeAssert.equal((await api("/v1/me", { auth: { bearer: first.bearer } })).status, 401);
      NodeAssert.equal((await api("/v1/me", { auth: { bearer: second.bearer } })).status, 401);

      const fresh = await signIn(base, profile);
      const auth = { bearer: fresh.bearer };
      const { device, token } = await registerDevice(api, auth, "Phone", "phone");
      NodeAssert.equal(
        (await adminApi(`/v1/admin/devices/${device.id}/revoke`, { method: "POST" })).status,
        204,
      );
      NodeAssert.equal((await api("/v1/devices/self", { auth: { bearer: token } })).status, 401);
      NodeAssert.deepEqual((await api("/v1/devices", { auth })).body.devices, []);
      NodeAssert.equal(
        (await api(`/v1/devices/${device.id}/token`, { auth, method: "POST" })).status,
        404,
      );
      const listed = await adminApi(`/v1/admin/devices?query=${profile.email}`);
      const revoked = listed.body.items.find((row) => row.id === device.id);
      NodeAssert.ok(revoked.revokedAt);
      NodeAssert.equal(revoked.userId, userId);
      NodeAssert.equal(
        (await adminApi(`/v1/admin/devices/${device.id}/revoke`, { method: "POST" })).status,
        204,
        "revoking twice is a no-op",
      );
      NodeAssert.equal(
        (await adminApi("/v1/admin/devices/not-a-uuid/revoke", { method: "POST" })).status,
        404,
      );

      NodeAssert.equal(
        (
          await adminApi(`/v1/admin/users/${adminId}/role`, {
            method: "PATCH",
            body: { role: "user" },
          })
        ).status,
        400,
      );
      NodeAssert.equal(
        (
          await adminApi(`/v1/admin/users/${userId}/role`, {
            method: "PATCH",
            body: { role: "root" },
          })
        ).status,
        400,
      );
      NodeAssert.equal((await api("/v1/admin/overview", { auth })).status, 403);
      NodeAssert.equal(
        (
          await adminApi(`/v1/admin/users/${userId}/role`, {
            method: "PATCH",
            body: { role: "admin" },
          })
        ).status,
        204,
      );
      NodeAssert.equal((await api("/v1/admin/overview", { auth })).status, 200);
      NodeAssert.equal((await api("/v1/me", { auth })).body.role, "admin");
      // A promoted admin may act on others but not on themselves.
      NodeAssert.equal(
        (
          await as(auth)(`/v1/admin/users/${userId}/role`, {
            method: "PATCH",
            body: { role: "user" },
          })
        ).status,
        400,
      );
      NodeAssert.equal(
        (
          await adminApi(`/v1/admin/users/${userId}/role`, {
            method: "PATCH",
            body: { role: "user" },
          })
        ).status,
        204,
      );
      NodeAssert.equal((await api("/v1/admin/overview", { auth })).status, 403);

      NodeAssert.deepEqual(
        (await auditFor(adminApi, userId)).map((entry) => [entry.action, entry.meta]),
        [
          ["user.role_change", { from: "admin", to: "user" }],
          ["user.role_change", { from: "user", to: "admin" }],
          ["user.revoke_sessions", { count: 2 }],
        ],
      );
      NodeAssert.deepEqual(
        (await auditFor(adminApi, device.id)).map((entry) => [entry.action, entry.meta]),
        [["device.revoke", { userId, name: "Phone", kind: "phone" }]],
      );
    });
  },
);

NodeTest.test("admin delete cascades like account deletion and is audited", async () => {
  await withAdmin(async ({ base, api, adminApi, adminId, pool }) => {
    const profile = githubUser("leo");
    const user = await signIn(base, profile);
    const auth = { bearer: user.bearer };
    const userId = await userIdOf(api, auth);
    const { token } = await registerDevice(api, auth, "Desk", "computer");

    NodeAssert.equal(
      (await adminApi(`/v1/admin/users/${adminId}`, { method: "DELETE" })).status,
      400,
    );
    NodeAssert.equal(
      (await adminApi(`/v1/admin/users/${userId}`, { method: "DELETE" })).status,
      204,
    );
    NodeAssert.equal((await api("/v1/me", { auth })).status, 401);
    NodeAssert.equal((await api("/v1/devices/self", { auth: { bearer: token } })).status, 401);
    const { rows } = await pool.query(
      `select (select count(*) from "user" where id = $1)::int as users,
              (select count(*) from session where user_id = $1)::int as sessions,
              (select count(*) from account where user_id = $1)::int as accounts,
              (select count(*) from device where user_id = $1)::int as devices`,
      [userId],
    );
    NodeAssert.deepEqual(rows[0], { users: 0, sessions: 0, accounts: 0, devices: 0 });
    NodeAssert.equal((await adminApi(`/v1/admin/users/${userId}`)).status, 404);
    NodeAssert.deepEqual(
      (await auditFor(adminApi, userId)).map((entry) => [entry.action, entry.meta]),
      [["user.delete", { name: "leo", githubLogin: profile.login }]],
    );
  });
});

NodeTest.test("overview numbers match the database", async () => {
  await withAdmin(async ({ base, api, adminApi, pool }) => {
    const user = await signIn(base, githubUser("mia"));
    const mac = await registerDevice(api, { bearer: user.bearer }, "Mac", "computer");
    const month = new Date().toISOString().slice(0, 7);
    await pool.query(
      `insert into relay_usage (user_id, month, bytes)
       select user_id, $2, 5000 from device where id = $1`,
      [mac.device.id, month],
    );
    const overview = await adminApi("/v1/admin/overview");
    NodeAssert.equal(overview.status, 200);
    const { rows } = await pool.query(
      `select
      (select count(*) from "user")::int as users,
      (select count(*) from "user" where created_at > now() - interval '7 days')::int as last7d,
      (select count(*) from "user" where banned)::int as banned,
      (select count(*) from device where revoked_at is null)::int as devices,
      (select count(*) from device where revoked_at is null and kind = 'computer')::int as computers,
      (select count(*) from device where revoked_at is null and kind = 'phone')::int as phones,
      (select count(*) from session where expires_at > now())::int as sessions,
      (select count(*) from "user" where (created_at at time zone 'utc')::date = (now() at time zone 'utc')::date)::int as today,
      (select count(*) from drizzle.__drizzle_migrations)::int as migrations,
      (select coalesce(sum(bytes), 0)::bigint from relay_usage where month = $1) as relay_bytes,
      (select count(*) from relay_usage where month = $1)::int as relay_users`,
      [month],
    );
    const expected = rows[0];
    const body = overview.body;
    NodeAssert.deepEqual(body.users, {
      total: expected.users,
      last7d: expected.last7d,
      banned: expected.banned,
    });
    NodeAssert.equal(body.devices.total, expected.devices);
    NodeAssert.deepEqual(body.devices.byKind, {
      computer: expected.computers,
      phone: expected.phones,
    });
    NodeAssert.ok(body.devices.active7d <= body.devices.total);
    NodeAssert.deepEqual(body.sessions, { active: expected.sessions });
    NodeAssert.deepEqual(body.relay, {
      bytesThisMonth: Number(expected.relay_bytes),
      users: expected.relay_users,
    });
    const userId = (await pool.query("select user_id from device where id = $1", [mac.device.id]))
      .rows[0].user_id;
    const detail = await adminApi(`/v1/admin/users/${userId}`);
    NodeAssert.deepEqual(detail.body.relay, [{ month, bytes: 5000 }]);
    NodeAssert.equal(body.signupsByDay.length, 30);
    NodeAssert.match(body.signupsByDay[0].date, /^\d{4}-\d{2}-\d{2}$/);
    NodeAssert.deepEqual(body.signupsByDay.at(-1), {
      date: new Date().toISOString().slice(0, 10),
      count: expected.today,
    });
    NodeAssert.equal(
      body.signupsByDay.reduce((sum, day) => sum + day.count, 0) >= expected.last7d,
      true,
    );
    NodeAssert.deepEqual(body.db, { ok: true, migrations: expected.migrations });
    NodeAssert.equal(body.build.version, "dev");
    NodeAssert.equal(body.build.commit, "unknown");
    NodeAssert.ok(!Number.isNaN(Date.parse(body.build.startedAt)));

    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `insert into relay_daily (day, metric, value) values ($1, 'bytes', 700), ($1, 'unauthorized', 2)
       on conflict (day, metric) do update set value = relay_daily.value + excluded.value`,
      [today],
    );
    const relay = await adminApi("/v1/admin/relay");
    NodeAssert.equal(relay.status, 200);
    NodeAssert.equal(relay.body.days.length, 30);
    NodeAssert.equal(relay.body.days.at(-1).date, today);
    NodeAssert.ok(relay.body.days.at(-1).bytes >= 700);
    NodeAssert.ok(relay.body.days.at(-1).unauthorized >= 2);
    const top = relay.body.topUsers.find((row) => row.userId === userId);
    NodeAssert.equal(top.bytes, 5000);
    NodeAssert.equal(top.percent, (5000 / relay.body.monthlyLimitBytes) * 100);
    NodeAssert.equal(relay.body.live.hostsOnline, 0);

    const system = await adminApi("/v1/admin/system");
    NodeAssert.equal(system.status, 200);
    NodeAssert.ok(system.body.database.sizeBytes > 0);
    NodeAssert.ok(system.body.database.tables.some((table) => table.name === "user"));
    NodeAssert.ok(system.body.disk.totalBytes >= system.body.disk.freeBytes);
    NodeAssert.deepEqual(system.body.backups, { status: "not_configured" });
  });
});
