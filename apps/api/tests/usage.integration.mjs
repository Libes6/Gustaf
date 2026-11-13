import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeTest from "node:test";
import { githubUser, registerDevice, signIn, withApi } from "./support/github-sign-in.mjs";

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

NodeTest.test(
  "computers report AI usage once per batch and admins read per-user and global totals",
  async () => {
    const adminProfile = githubUser("root");
    await withApi(
      async ({ base, api }) => {
        const admin = await signIn(base, adminProfile);
        const alice = await signIn(base, githubUser("alice"));
        const bob = await signIn(base, githubUser("bob"));
        const aliceId = (await api("/v1/me", { auth: { bearer: alice.bearer } })).body.user.id;
        const laptop = await registerDevice(api, { bearer: alice.bearer }, "Laptop", "computer");
        const phone = await registerDevice(api, { bearer: alice.bearer }, "Pixel", "phone");
        const desktop = await registerDevice(api, { bearer: bob.bearer }, "Desktop", "computer");
        const report = (token, body) =>
          api("/v1/usage/reports", { auth: { bearer: token }, method: "POST", body });

        const batch = {
          batchId: NodeCrypto.randomUUID(),
          buckets: [
            {
              day: today(),
              provider: "codex",
              model: "gpt-6.1",
              turns: 3,
              measuredTurns: 2,
              inputTokens: 1000,
              outputTokens: 200,
            },
            {
              day: daysAgo(10),
              provider: "claudeAgent",
              model: null,
              turns: 2,
              measuredTurns: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
          ],
        };
        NodeAssert.equal((await report(undefined, batch)).status, 401);
        NodeAssert.equal((await report(alice.bearer, batch)).status, 401); // a session is not a device
        NodeAssert.equal((await report(phone.token, batch)).status, 403);
        NodeAssert.equal(
          (await report(laptop.token, { ...batch, buckets: [{ ...batch.buckets[0], turns: 0 }] }))
            .status,
          400,
        );

        const first = await report(laptop.token, batch);
        NodeAssert.deepEqual([first.status, first.body], [200, { duplicate: false }]);
        // The host retries a batch whose answer it lost: counted once.
        const retry = await report(laptop.token, batch);
        NodeAssert.deepEqual([retry.status, retry.body], [200, { duplicate: true }]);
        await report(laptop.token, {
          batchId: NodeCrypto.randomUUID(),
          buckets: [
            { ...batch.buckets[0], turns: 1, measuredTurns: 1, inputTokens: 50, outputTokens: 5 },
          ],
        });
        await report(desktop.token, {
          batchId: batch.batchId, // batch ids are per device
          buckets: [
            { ...batch.buckets[0], turns: 1, measuredTurns: 0, inputTokens: 0, outputTokens: 0 },
          ],
        });

        const adminApi = (path) => api(path, { auth: { cookie: admin.cookie } });
        NodeAssert.equal(
          (await api("/v1/admin/ai-usage", { auth: { bearer: alice.bearer } })).status,
          403,
        );
        NodeAssert.equal((await adminApi("/v1/admin/ai-usage?days=14")).status, 400);

        const month = await adminApi("/v1/admin/ai-usage?days=30");
        NodeAssert.equal(month.status, 200);
        const aliceRow = month.body.byUser.find((row) => row.userId === aliceId);
        NodeAssert.deepEqual(
          { ...aliceRow, email: undefined },
          {
            userId: aliceId,
            name: "alice",
            email: undefined,
            turns: 6,
            measuredTurns: 3,
            inputTokens: 1050,
            outputTokens: 205,
          },
        );
        const codex = month.body.byModel.find(
          (row) => row.provider === "codex" && row.model === "gpt-6.1",
        );
        NodeAssert.ok(codex.turns >= 5 && codex.users >= 2);
        const unnamed = month.body.byModel.find(
          (row) => row.provider === "claudeAgent" && row.model === null,
        );
        NodeAssert.ok(unnamed.turns >= 2);

        // One user, and a period that leaves out the 10-day-old bucket.
        const week = await adminApi(`/v1/admin/ai-usage?days=7&userId=${aliceId}`);
        NodeAssert.deepEqual(week.body.totals, {
          turns: 4,
          measuredTurns: 3,
          inputTokens: 1050,
          outputTokens: 205,
          users: 1,
        });
        NodeAssert.deepEqual(
          week.body.byModel.map(({ provider, model, turns }) => ({ provider, model, turns })),
          [{ provider: "codex", model: "gpt-6.1", turns: 4 }],
        );
      },
      (base) => ({ ADMIN_GITHUB_LOGINS: adminProfile.login, ADMIN_ORIGIN: base }),
    );
  },
);
