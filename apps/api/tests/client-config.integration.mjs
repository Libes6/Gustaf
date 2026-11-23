import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeTest from "node:test";
import { githubUser, registerDevice, signIn, withApi } from "./support/github-sign-in.mjs";

const XRW = { "x-requested-with": "gustaf-admin" };

NodeTest.test(
  "admins manage client config with audit entries; clients read it signed out or in",
  async () => {
    const adminProfile = githubUser("root");
    await withApi(
      async ({ base, api }) => {
        const admin = await signIn(base, adminProfile);
        const adminApi = (path, { method = "GET", body } = {}) =>
          api(path, {
            auth: { cookie: admin.cookie },
            method,
            body,
            headers: method === "GET" ? {} : XRW,
          });
        const userProfile = githubUser("ivan");
        const user = await signIn(base, userProfile);

        // Admin routes: 401 signed out, 403 for a user.
        for (const [method, path] of [
          ["GET", "/v1/admin/announcements"],
          ["POST", "/v1/admin/announcements"],
          ["PATCH", "/v1/admin/minimum-versions/desktop"],
          ["POST", "/v1/admin/feature-flags"],
          ["DELETE", "/v1/admin/feature-flags/x"],
        ]) {
          const body = method === "GET" ? undefined : {};
          NodeAssert.equal((await api(path, { method, body, headers: XRW })).status, 401);
          NodeAssert.equal(
            (await api(path, { method, body, headers: XRW, auth: { bearer: user.bearer } })).status,
            403,
            `${method} ${path}`,
          );
        }

        const created = await adminApi("/v1/admin/announcements", {
          method: "POST",
          body: {
            textEn: "Maintenance tonight",
            textRu: "Сегодня ночью работы",
            level: "warning",
            target: "desktop",
            active: true,
          },
        });
        NodeAssert.equal(created.status, 201);
        const id = created.body.id;
        const listed = await adminApi("/v1/admin/announcements");
        NodeAssert.ok(listed.body.items.some((item) => item.id === id));
        NodeAssert.equal(
          (await adminApi("/v1/admin/announcements", { method: "POST", body: { textEn: "" } }))
            .status,
          400,
        );

        NodeAssert.equal(
          (
            await adminApi("/v1/admin/minimum-versions/desktop", {
              method: "PATCH",
              body: { version: "1.5.0", message: "Security fix" },
            })
          ).status,
          200,
        );
        const flagKey = `beta-${NodeCrypto.randomUUID().slice(0, 8)}`;
        NodeAssert.equal(
          (
            await adminApi("/v1/admin/feature-flags", {
              method: "POST",
              body: { key: flagKey, mode: "listed", logins: [userProfile.login.toUpperCase()] },
            })
          ).status,
          201,
        );
        NodeAssert.equal(
          (
            await adminApi("/v1/admin/feature-flags", {
              method: "POST",
              body: { key: flagKey, mode: "off" },
            })
          ).status,
          409,
        );

        // Signed out: public, cacheable, and the listed flag is off.
        const anonymous = await fetch(`${base}/v1/client-config?kind=desktop&version=1.4.0`);
        NodeAssert.equal(anonymous.status, 200);
        NodeAssert.equal(anonymous.headers.get("cache-control"), "public, max-age=300");
        const config = await anonymous.json();
        const shown = config.announcements.find((item) => item.id === id);
        NodeAssert.deepEqual(shown, {
          id,
          level: "warning",
          text: { en: "Maintenance tonight", ru: "Сегодня ночью работы" },
          link: null,
        });
        NodeAssert.deepEqual(config.update, {
          required: true,
          minimumVersion: "1.5.0",
          message: "Security fix",
        });
        NodeAssert.equal(config.flags[flagKey], false);
        const mobile = await api("/v1/client-config?kind=mobile&version=1.4.0");
        NodeAssert.ok(!mobile.body.announcements.some((item) => item.id === id));
        NodeAssert.equal(mobile.body.update.required, false);
        NodeAssert.equal((await api("/v1/client-config?kind=web")).status, 400);

        // Signed in by session or by device token: the listed flag is on.
        const asUser = await api("/v1/client-config?kind=desktop&version=1.5.0", {
          auth: { bearer: user.bearer },
        });
        NodeAssert.equal(asUser.body.flags[flagKey], true);
        NodeAssert.equal(asUser.body.update.required, false);
        const phone = await registerDevice(api, { bearer: user.bearer }, "Phone", "phone");
        const asDevice = await api("/v1/client-config?kind=mobile", {
          auth: { bearer: phone.token },
        });
        NodeAssert.equal(asDevice.body.flags[flagKey], true);
        // A bad credential is ignored, not rejected.
        const stale = await api("/v1/client-config?kind=mobile", { auth: { bearer: "expired" } });
        NodeAssert.equal(stale.status, 200);
        NodeAssert.equal(stale.body.flags[flagKey], false);

        // Disabling hides the announcement at once on this process.
        const disabled = await adminApi(`/v1/admin/announcements/${id}`, {
          method: "PATCH",
          body: { ...created.body, active: false },
        });
        NodeAssert.equal(disabled.status, 200);
        NodeAssert.ok(
          !(await api("/v1/client-config?kind=desktop")).body.announcements.some(
            (item) => item.id === id,
          ),
        );
        NodeAssert.equal(
          (await adminApi(`/v1/admin/feature-flags/${flagKey}`, { method: "DELETE" })).status,
          204,
        );
        NodeAssert.equal(
          (await adminApi("/v1/admin/minimum-versions/desktop", { method: "DELETE" })).status,
          204,
        );
        NodeAssert.equal(
          (await adminApi(`/v1/admin/announcements/${id}`, { method: "DELETE" })).status,
          204,
        );

        const audit = (await adminApi("/v1/admin/audit?limit=100")).body.items;
        const actions = (target) =>
          audit
            .filter((entry) => entry.targetId === target)
            .map((entry) => entry.action)
            .toReversed();
        NodeAssert.deepEqual(actions(id), [
          "announcement.create",
          "announcement.update",
          "announcement.delete",
        ]);
        NodeAssert.deepEqual(actions(flagKey), ["feature_flag.create", "feature_flag.delete"]);
        NodeAssert.deepEqual(actions("desktop").slice(-2), [
          "minimum_version.set",
          "minimum_version.clear",
        ]);
      },
      (base) => ({ ADMIN_GITHUB_LOGINS: adminProfile.login, ADMIN_ORIGIN: base }),
    );
  },
);
