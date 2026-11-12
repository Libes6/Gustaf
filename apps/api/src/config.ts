export type AppConfig = ReturnType<typeof readConfig>;
export type AuthConfig = NonNullable<AppConfig["auth"]>;

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
    auth: readFlag("AUTH_ENABLED", env.AUTH_ENABLED, true) ? readAuthConfig(env) : null,
  };
}

const AUTH_REQUIRED = [
  "BETTER_AUTH_SECRET",
  "PUBLIC_BASE_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const;

function readAuthConfig(env: NodeJS.ProcessEnv) {
  const missing = AUTH_REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Auth is enabled but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set (set AUTH_ENABLED=0 to run without accounts)`,
    );
  }
  const secret = env.BETTER_AUTH_SECRET!.trim();
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  const publicBaseUrl = readPublicBaseUrl(env.PUBLIC_BASE_URL!.trim());
  const trustedOrigins = (env.AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of trustedOrigins) {
    // An origin (https://admin.example.com) or an app deep-link scheme (gustaf://).
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s,]*$/i.test(origin)) {
      throw new Error(`AUTH_TRUSTED_ORIGINS entry "${origin}" must be an origin or a scheme://`);
    }
  }
  return {
    secret,
    publicBaseUrl,
    githubClientId: env.GITHUB_CLIENT_ID!.trim(),
    githubClientSecret: env.GITHUB_CLIENT_SECRET!.trim(),
    trustedOrigins,
  };
}

function readPublicBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be an absolute URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("PUBLIC_BASE_URL must use https (http is allowed only for localhost)");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_BASE_URL must be an origin without a path");
  }
  return url.origin;
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
