import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import type { AuthConfig } from "../config.js";
import type { DatabaseService } from "../database/database.service.js";
import * as tables from "../database/tables.schema.js";

export const AUTH_BASE_PATH = "/v1/auth";
export const AUTH = Symbol("Auth");
export type Auth = ReturnType<typeof createAuth>;

export function createAuth(config: AuthConfig, database: DatabaseService) {
  return betterAuth({
    appName: "Gustaf",
    baseURL: config.publicBaseUrl,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    database: drizzleAdapter(database.db, {
      provider: "pg",
      schema: {
        user: tables.user,
        session: tables.session,
        account: tables.account,
        verification: tables.verification,
      },
    }),
    socialProviders: {
      github: { clientId: config.githubClientId, clientSecret: config.githubClientSecret },
    },
    account: { encryptOAuthTokens: true },
    // Browsers use the session cookie; the desktop and mobile apps send `Authorization: Bearer`
    // with the token from the `set-auth-token` response header.
    plugins: [bearer()],
    telemetry: { enabled: false },
  });
}
