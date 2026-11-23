import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const seedLegacySubscriptions = Effect.fn("seedLegacySubscriptions")(function* (legacyId: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: legacyId - 1 });
  yield* sql`
    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY,
      subscription_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO subscriptions (id, subscription_json, created_at, updated_at)
    VALUES ('sub-1', '{"name":"Claude Max"}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${legacyId}, 'Subscriptions')
  `;
});

const assertUpgradedFrom = Effect.fn("assertUpgradedFrom")(function* (legacyId: number) {
  const sql = yield* SqlClient.SqlClient;
  const executed = yield* runMigrations();
  assert.deepStrictEqual(
    executed,
    migrationManifest.filter(([id]) => id >= legacyId),
  );

  const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  assert.deepStrictEqual(
    recorded.map((row) => [row.migration_id, row.name] as const),
    migrationManifest,
  );

  const saved = yield* sql<{ readonly id: string; readonly subscription_json: string }>`
    SELECT id, subscription_json FROM subscriptions
  `;
  assert.deepStrictEqual(saved, [{ id: "sub-1", subscription_json: '{"name":"Claude Max"}' }]);

  yield* sql`PRAGMA query_only = ON`;
  assert.deepStrictEqual(yield* runMigrations(), []);
});

describe("reconcileGustafSubscriptionsMigration", () => {
  it("keeps Subscriptions as the last migration", () => {
    assert.strictEqual(migrationManifest.at(-1)?.[1], "Subscriptions");
  });

  it.effect("upgrades a Gustaf v0.22 database with 81_Subscriptions without losing rows", () =>
    Effect.gen(function* () {
      yield* seedLegacySubscriptions(81);
      yield* assertUpgradedFrom(81);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("runs upstream's 111 on a database an early Electron build recorded at 111", () =>
    Effect.gen(function* () {
      yield* seedLegacySubscriptions(111);
      yield* assertUpgradedFrom(111);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("does not erase an unrelated collision at migration 81", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (81, 'UnexpectedMigration')
      `;

      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "81_ProjectionMessageSearchText (recorded: UnexpectedMigration)",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves a legacy Subscriptions row alone when later migrations follow it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (81, 'Subscriptions'), (82, 'UnexpectedMigration')
      `;

      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      const recorded = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 81
      `;
      assert.deepStrictEqual(recorded, [{ name: "Subscriptions" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
