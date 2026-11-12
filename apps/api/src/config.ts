export type AppConfig = ReturnType<typeof readConfig>;

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
  const port = Number(env.PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return {
    databaseUrl,
    port,
    host: env.HOST ?? "127.0.0.1",
    trustProxy: readTrustProxy(env.TRUST_PROXY),
    runMigrations: readFlag("RUN_MIGRATIONS", env.RUN_MIGRATIONS, true),
  };
}

// Express `trust proxy`: a hop count, true/false, or a comma-separated list of addresses/subnets.
function readTrustProxy(value: string | undefined): number | boolean | string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return 1;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (/^[0-9A-Za-z.:/,\s-]+$/.test(trimmed)) return trimmed;
  throw new Error("TRUST_PROXY must be a hop count, true, false, or a list of addresses");
}

function readFlag(name: string, value: string | undefined, fallback: boolean) {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return fallback;
  if (trimmed === "1" || trimmed === "true") return true;
  if (trimmed === "0" || trimmed === "false") return false;
  throw new Error(`${name} must be 0 or 1`);
}
