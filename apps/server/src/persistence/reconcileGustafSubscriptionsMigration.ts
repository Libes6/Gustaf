import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Older Gustaf builds recorded Subscriptions at an id upstream later took (81 in v0.18–v0.22, 111
// in early Electron builds), and the Migrator skips every id up to the highest recorded. When that
// stale row is the highest, drop only the ledger row: the table and its data stay, upstream's
// migrations run, and the idempotent Subscriptions migration is recorded again at its current id.
export const reconcileGustafSubscriptionsMigration = Effect.fn(
  "reconcileGustafSubscriptionsMigration",
)(function* (currentId: number) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return false;
      const [latest] = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 1
      `;
      if (latest === undefined) return false;
      if (latest.name !== "Subscriptions" || latest.migration_id === currentId) return false;
      if (latest.migration_id > currentId) return false;
      yield* sql`
        DELETE FROM effect_sql_migrations
        WHERE migration_id = ${latest.migration_id} AND name = 'Subscriptions'
      `;
      return true;
    }),
  );
});
