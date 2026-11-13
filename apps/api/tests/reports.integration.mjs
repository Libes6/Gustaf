import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { githubUser, registerDevice, signIn, withApi } from "./support/github-sign-in.mjs";

const XRW = { "x-requested-with": "gustaf-admin" };

const report = (overrides = {}) => ({
  client: "desktop",
  appVersion: "1.2.3",
  platform: "macos aarch64",
  message: "The diff panel stays empty",
  ...overrides,
});

async function withAdmin(run) {
  const adminProfile = githubUser("reports-admin");
  await withApi(
    async (context) => {
      const admin = await signIn(context.base, adminProfile);
      const adminId = (await context.api("/v1/me", { auth: { bearer: admin.bearer } })).body.user
        .id;
      const adminApi = (path, { method = "GET", body } = {}) =>
        context.api(path, {
          auth: { cookie: admin.cookie },
          method,
          body,
          headers: method === "GET" ? {} : XRW,
        });
      await run({ ...context, adminId, adminApi });
    },
    (base) => ({ ADMIN_GITHUB_LOGINS: adminProfile.login, ADMIN_ORIGIN: base }),
  );
}

NodeTest.test("reports need a user session and valid, bounded input", async () => {
  await withAdmin(async ({ base, api }) => {
    const user = await signIn(base, githubUser("reporter"));
    const auth = { bearer: user.bearer };
    const post = (body, as = auth) => api("/v1/reports", { auth: as, method: "POST", body });

    NodeAssert.equal((await api("/v1/reports", { method: "POST", body: report() })).status, 401);
    const { device, token } = await registerDevice(api, auth, "Laptop", "computer");
    NodeAssert.equal(
      (await post(report(), { bearer: token })).status,
      401,
      "device tokens are not sessions",
    );

    for (const body of [
      report({ client: "web" }),
      report({ message: "   " }),
      report({ message: "x".repeat(5001) }),
      report({ appVersion: undefined }),
      report({ platform: 42 }),
      report({ logs: "x".repeat(200_001) }),
      report({ deviceId: "../me" }),
    ]) {
      NodeAssert.equal((await post(body)).status, 400, JSON.stringify(body).slice(0, 80));
    }

    // A log tail near the cap fits in the JSON body limit.
    const created = await post(report({ logs: "l".repeat(200_000), deviceId: device.id }));
    NodeAssert.equal(created.status, 201);
    NodeAssert.ok(created.body.report.id);

    const other = await signIn(base, githubUser("other-reporter"));
    const foreign = await post(report({ deviceId: device.id }), { bearer: other.bearer });
    NodeAssert.equal(foreign.status, 201, "a foreign device id is dropped, not trusted");
  });
});

NodeTest.test("reports are rate limited per user", async () => {
  await withAdmin(async ({ base, api }) => {
    const user = await signIn(base, githubUser("chatty"));
    const auth = { bearer: user.bearer };
    for (let index = 0; index < 10; index += 1) {
      NodeAssert.equal(
        (await api("/v1/reports", { auth, method: "POST", body: report() })).status,
        201,
      );
    }
    NodeAssert.equal(
      (await api("/v1/reports", { auth, method: "POST", body: report() })).status,
      429,
    );
    const someoneElse = await signIn(base, githubUser("quiet"));
    NodeAssert.equal(
      (
        await api("/v1/reports", {
          auth: { bearer: someoneElse.bearer },
          method: "POST",
          body: report(),
        })
      ).status,
      201,
    );
  });
});

NodeTest.test("admins list, open and triage reports, and each change is audited", async () => {
  await withAdmin(async ({ base, api, adminId, adminApi }) => {
    const user = await signIn(base, githubUser("triaged"));
    const auth = { bearer: user.bearer };
    NodeAssert.equal(
      (await api("/v1/admin/reports", { auth })).status,
      403,
      "users cannot read the inbox",
    );
    const { device } = await registerDevice(api, auth, "Pixel", "phone");
    const posted = await api("/v1/reports", {
      auth,
      method: "POST",
      body: report({ client: "mobile", logs: "line 1\nline 2", deviceId: device.id }),
    });
    const id = posted.body.report.id;

    const before = (await adminApi("/v1/admin/reports/counts")).body;
    const list = await adminApi("/v1/admin/reports?status=new&limit=100");
    NodeAssert.equal(list.status, 200);
    const item = list.body.items.find((entry) => entry.id === id);
    NodeAssert.equal(item.hasLogs, true);
    NodeAssert.equal(item.client, "mobile");
    NodeAssert.equal(item.preview, "The diff panel stays empty");
    NodeAssert.equal(item.logs, undefined, "lists never carry logs");
    NodeAssert.equal((await adminApi("/v1/admin/reports?status=open")).status, 400);

    const detail = await adminApi(`/v1/admin/reports/${id}`);
    NodeAssert.equal(detail.body.logs, "line 1\nline 2");
    NodeAssert.equal(detail.body.deviceName, "Pixel");
    NodeAssert.equal((await adminApi("/v1/admin/reports/not-a-uuid")).status, 404);

    const patch = (body) => adminApi(`/v1/admin/reports/${id}`, { method: "PATCH", body });
    NodeAssert.equal((await patch({})).status, 400);
    NodeAssert.equal((await patch({ status: "done" })).status, 400);
    NodeAssert.equal((await patch({ status: "closed", note: "Fixed in 1.2.4" })).status, 204);
    NodeAssert.equal((await patch({ status: "closed" })).status, 204, "no-op is not audited");

    const closed = (await adminApi(`/v1/admin/reports/${id}`)).body;
    NodeAssert.equal(closed.status, "closed");
    NodeAssert.equal(closed.adminNote, "Fixed in 1.2.4");
    const after = (await adminApi("/v1/admin/reports/counts")).body;
    NodeAssert.equal(after.new, before.new - 1);
    NodeAssert.equal(after.closed, before.closed + 1);

    const audit = (await adminApi("/v1/admin/audit?limit=100")).body.items.filter(
      (entry) => entry.targetId === id,
    );
    NodeAssert.equal(audit.length, 1);
    NodeAssert.equal(audit[0].action, "report.update");
    NodeAssert.equal(audit[0].actorId, adminId);
    NodeAssert.deepEqual(audit[0].meta, { from: "new", to: "closed", noteChanged: true });
  });
});
