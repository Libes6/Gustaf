import * as NodeURL from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const migrationsFolder = NodeURL.fileURLToPath(new URL("../../drizzle/", import.meta.url));

// Own pool: the app pool's 2 s query timeout would abort long-running migrations.
export async function runMigrations(databaseUrl: string) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
