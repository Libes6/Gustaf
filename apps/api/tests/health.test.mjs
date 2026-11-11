import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { createApp } from "../dist/app.js";

async function withApp(databaseUrl, run) {
  const app = await createApp({ databaseUrl, port: 3100, host: "127.0.0.1" });
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
    await withApp("postgresql://hidden:secret@127.0.0.1:1/missing", async (url) => {
      const live = await fetch(`${url}/health/live`);
      NodeAssert.equal(live.status, 200);
      NodeAssert.deepEqual(await live.json(), { status: "ok" });
      NodeAssert.match(live.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
      const ready = await fetch(`${url}/health/ready`);
      NodeAssert.equal(ready.status, 503);
      const body = await ready.text();
      NodeAssert.ok(!body.includes("secret"));
      NodeAssert.ok(!body.includes("postgresql"));
    });
  },
);
