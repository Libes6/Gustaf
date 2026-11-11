import * as NodeAssert from "node:assert/strict";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createApp } from "../dist/app.js";
import { DatabaseService } from "../dist/database/database.service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database");

NodeTest.test(
  "migration runner is repeatable and HTTP readiness uses real PostgreSQL",
  async () => {
    const database = new DatabaseService(databaseUrl);
    try {
      const migrationsFolder = NodeURL.fileURLToPath(new URL("../drizzle/", import.meta.url));
      await migrate(database.db, { migrationsFolder });
      await migrate(database.db, { migrationsFolder });
      const result = await database.pool.query(
        "select count(*)::int as count from drizzle.__drizzle_migrations",
      );
      NodeAssert.equal(result.rows[0].count, 0);
    } finally {
      await database.onModuleDestroy();
    }
    const app = await createApp({ databaseUrl, port: 3100, host: "127.0.0.1" });
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
