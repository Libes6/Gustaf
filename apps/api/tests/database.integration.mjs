import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";
import { createApp } from "../dist/app.js";
import { readConfig } from "../dist/config.js";
import { DatabaseService } from "../dist/database/database.service.js";
import { runMigrations } from "../dist/database/migrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database");

NodeTest.test(
  "migration runner is repeatable and HTTP readiness uses real PostgreSQL",
  async () => {
    await runMigrations(databaseUrl);
    await runMigrations(databaseUrl);
    const database = new DatabaseService(databaseUrl);
    try {
      const result = await database.pool.query(
        "select count(*)::int as count from drizzle.__drizzle_migrations",
      );
      const journal = JSON.parse(
        NodeFS.readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
      );
      NodeAssert.equal(result.rows[0].count, journal.entries.length);
    } finally {
      await database.onModuleDestroy();
    }
    const app = await createApp(readConfig({ DATABASE_URL: databaseUrl, AUTH_ENABLED: "0" }));
    app.useLogger(false);
    try {
      await app.listen(0, "127.0.0.1");
      const response = await fetch(`${await app.getUrl()}/health/ready`);
      NodeAssert.equal(response.status, 200);
      NodeAssert.deepEqual(await response.json(), { status: "ok" });
    } finally {
      await app.close();
    }
  },
);
