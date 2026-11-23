import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { createApp, resolveRequestId } from "../dist/app.js";
import { readConfig } from "../dist/config.js";

const unreachableDatabase = "postgresql://hidden:secret@127.0.0.1:1/missing";

async function withApp(databaseUrl, run) {
  const app = await createApp(readConfig({ DATABASE_URL: databaseUrl, AUTH_ENABLED: "0" }));
  app.useLogger(false);
  try {
    await app.listen(0, "127.0.0.1");
    await run(await app.getUrl());
  } finally {
    await app.close();
  }
}

NodeTest.test(
  "liveness stays available while readiness fails without exposing database credentials",
  async () => {
    await withApp(unreachableDatabase, async (url) => {
      const live = await fetch(`${url}/health/live`);
      NodeAssert.equal(live.status, 200);
      NodeAssert.deepEqual(await live.json(), { status: "ok" });
      NodeAssert.match(live.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
      NodeAssert.equal(live.headers.get("x-content-type-options"), "nosniff");
      NodeAssert.equal(live.headers.get("x-frame-options"), "DENY");
      NodeAssert.equal(live.headers.get("referrer-policy"), "no-referrer");
      NodeAssert.equal(live.headers.get("cross-origin-resource-policy"), "same-origin");
      NodeAssert.equal(live.headers.get("strict-transport-security"), null);
      NodeAssert.equal(live.headers.get("access-control-allow-origin"), null);
      NodeAssert.equal(live.headers.get("x-powered-by"), null);
      const ready = await fetch(`${url}/health/ready`);
      NodeAssert.equal(ready.status, 503);
      const body = await ready.text();
      NodeAssert.ok(!body.includes("secret"));
      NodeAssert.ok(!body.includes("postgresql"));
    });
  },
);

NodeTest.test("HSTS is sent only when the trusted proxy reports HTTPS", async () => {
  await withApp(unreachableDatabase, async (url) => {
    const https = await fetch(`${url}/health/live`, { headers: { "x-forwarded-proto": "https" } });
    NodeAssert.equal(https.headers.get("strict-transport-security"), "max-age=31536000");
  });
});

NodeTest.test("incoming request ids are echoed only when they match the safe pattern", async () => {
  await withApp(unreachableDatabase, async (url) => {
    const safe = await fetch(`${url}/health/live`, {
      headers: { "x-request-id": "trace-1.a:b_C" },
    });
    NodeAssert.equal(safe.headers.get("x-request-id"), "trace-1.a:b_C");
  });
  for (const unsafe of ["", "has space", "aé", "x".repeat(129), ["a", "b"], undefined]) {
    NodeAssert.match(resolveRequestId(unsafe), /^[0-9a-f-]{36}$/);
  }
});

NodeTest.test("config parses TRUST_PROXY and RUN_MIGRATIONS", () => {
  const base = { DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db", AUTH_ENABLED: "0" };
  const config = readConfig(base);
  NodeAssert.equal(config.trustProxy, 1);
  NodeAssert.equal(config.runMigrations, true);
  for (const [value, expected] of [
    ["2", 2],
    ["0", 0],
    ["true", true],
    ["false", false],
    ["10.0.0.0/8, 127.0.0.1", "10.0.0.0/8, 127.0.0.1"],
  ]) {
    NodeAssert.equal(readConfig({ ...base, TRUST_PROXY: value }).trustProxy, expected);
  }
  NodeAssert.throws(() => readConfig({ ...base, TRUST_PROXY: "yes please!" }), /TRUST_PROXY/);
  for (const [value, expected] of [
    ["0", false],
    ["false", false],
    ["1", true],
    ["", true],
  ]) {
    NodeAssert.equal(readConfig({ ...base, RUN_MIGRATIONS: value }).runMigrations, expected);
  }
  NodeAssert.throws(() => readConfig({ ...base, RUN_MIGRATIONS: "no" }), /RUN_MIGRATIONS/);
});
