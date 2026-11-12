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
    build: {
      version: env.GUSTAF_VERSION?.trim() || "dev",
      commit: env.GUSTAF_COMMIT?.trim() || "unknown",
    },
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
  const adminOrigins = readAdminOrigins(env);
  const relayMonthlyGb = Number(env.RELAY_MONTHLY_GB?.trim() || 100);
  if (!Number.isFinite(relayMonthlyGb) || relayMonthlyGb <= 0) {
    throw new Error("RELAY_MONTHLY_GB must be a positive number");
  }
  return {
    secret,
    publicBaseUrl,
    githubClientId: env.GITHUB_CLIENT_ID!.trim(),
    githubClientSecret: env.GITHUB_CLIENT_SECRET!.trim(),
    // The admin app signs in through Better Auth from its own origin.
    trustedOrigins: [...new Set([...trustedOrigins, ...adminOrigins])],
    adminGithubLogins: parseGithubLogins(env.ADMIN_GITHUB_LOGINS),
    adminOrigins,
    relayMonthlyBytes: Math.round(relayMonthlyGb * 1024 ** 3),
  };
}

export const ADMIN_DEV_ORIGIN = "http://localhost:5174";

// Exact browser origins allowed to call the API with credentials (CORS) and to mutate /v1/admin.
function readAdminOrigins(env: NodeJS.ProcessEnv) {
  const origins: string[] = [];
  const value = env.ADMIN_ORIGIN?.trim();
  if (value) {
    let url: URL | undefined;
    try {
      url = new URL(value);
    } catch {}
    const loopback = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      !url ||
      url.origin !== value.replace(/\/$/, "") ||
      !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
    ) {
      throw new Error(
        "ADMIN_ORIGIN must be an https origin without a path, e.g. https://admin.example.com",
      );
    }
    origins.push(url.origin);
  }
  if (env.NODE_ENV !== "production") origins.push(ADMIN_DEV_ORIGIN);
  return [...new Set(origins)];
}

// GitHub logins are case-insensitive; an empty list promotes nobody.
export function parseGithubLogins(value: string | undefined) {
  const logins = new Set<string>();
  for (const entry of (value ?? "").split(",")) {
    const login = entry.trim().replace(/^@/, "").toLowerCase();
    if (!login) continue;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(login)) {
      throw new Error(`ADMIN_GITHUB_LOGINS entry "${entry.trim()}" is not a GitHub login`);
    }
    logins.add(login);
  }
  return logins;
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
