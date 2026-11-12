import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { admin, bearer } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import type { AuthConfig } from "../config.js";
import type { DatabaseService } from "../database/database.service.js";
import * as tables from "../database/tables.schema.js";

export const AUTH_BASE_PATH = "/v1/auth";
export const AUTH = Symbol("Auth");
export type Auth = ReturnType<typeof createAuth>;

// Better Auth drops provider profile fields it does not own, so the GitHub login seen during the
// OAuth callback is kept here by GitHub account id until the callback's after-hook stores it.
class SeenGithubLogins {
  private readonly logins = new Map<string, string>();

  remember(githubId: unknown, login: unknown) {
    if (typeof login !== "string" || (typeof githubId !== "number" && typeof githubId !== "string"))
      return;
    if (this.logins.size >= 1000) this.logins.clear();
    this.logins.set(String(githubId), login);
  }

  take(githubId: string) {
    const login = this.logins.get(githubId);
    this.logins.delete(githubId);
    return login;
  }
}

export function createAuth(config: AuthConfig, database: DatabaseService) {
  const seen = new SeenGithubLogins();

  // Stores the login and promotes listed logins to admin; never demotes.
  const recordGithubLogin = async (userId: string) => {
    const [linked] = await database.db
      .select({ githubId: tables.account.accountId })
      .from(tables.account)
      .where(and(eq(tables.account.userId, userId), eq(tables.account.providerId, "github")));
    const login = linked && seen.take(linked.githubId);
    if (!login) return;
    const promote = config.adminGithubLogins.has(login.toLowerCase());
    await database.db
      .update(tables.user)
      .set({ githubLogin: login, ...(promote ? { role: "admin" } : {}) })
      .where(eq(tables.user.id, userId));
  };

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
      github: {
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
        mapProfileToUser: (profile) => {
          seen.remember(profile.id, profile.login);
          return {};
        },
      },
    },
    account: { encryptOAuthTokens: true },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const created = ctx.context.newSession;
        if (created) await recordGithubLogin(created.user.id);
      }),
    },
    // Browsers use the session cookie; the desktop and mobile apps send `Authorization: Bearer`
    // with the token from the `set-auth-token` response header. The admin plugin supplies the
    // role and ban fields and refuses new sessions for banned users; its own HTTP endpoints are
    // not exposed (app.ts), the admin API under /v1/admin is ours.
    plugins: [bearer(), admin()],
    telemetry: { enabled: false },
  });
}
