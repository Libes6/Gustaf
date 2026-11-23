import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, lte } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import { appAuthCode, appSignInRequest, session, user } from "../database/tables.schema.js";
import {
  appendQuery,
  CODE_TTL_MS,
  createSecret,
  hashSecret,
  redeem,
  REQUEST_TTL_MS,
  type StartRequest,
  type TokenRequest,
} from "./app-sign-in.js";
import { AUTH, type Auth } from "./auth.js";

const REQUEST_COOKIE = "app_sign_in";
const SAFE_ERROR = /^[a-z0-9_]{1,64}$/;

type Finish = { redirect?: string; cookies: string[] };

@Injectable()
export class AppSignInService {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    private readonly database: DatabaseService,
  ) {}

  // Remembers the app's request under a browser-bound nonce, then starts Better Auth's GitHub flow.
  async start(request: StartRequest) {
    const now = new Date();
    const nonce = createSecret();
    const db = this.database.db;
    await db.delete(appSignInRequest).where(lte(appSignInRequest.expiresAt, now));
    await db.insert(appSignInRequest).values({
      id: hashSecret(nonce),
      ...request,
      createdAt: now,
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
    });
    const context = await this.auth.$context;
    const done = `${context.baseURL}/app/done`;
    const { headers, response } = await this.auth.api.signInSocial({
      body: {
        provider: "github",
        callbackURL: done,
        errorCallbackURL: done,
        disableRedirect: true,
      },
      returnHeaders: true,
    });
    if (!response.url) throw new Error("GitHub sign-in returned no authorization URL");
    const cookie = await this.requestCookie();
    return {
      redirect: response.url,
      cookies: [
        ...headers.getSetCookie(),
        serializeCookie(cookie.name, nonce, cookie.secure, REQUEST_TTL_MS / 1000),
      ],
    };
  }

  // Runs after Better Auth's callback: binds a one-time code to the session it just created.
  async finish(headers: Headers, providerError: string | undefined): Promise<Finish> {
    const cookie = await this.requestCookie();
    const cookies = [serializeCookie(cookie.name, "", cookie.secure, 0)];
    const nonce = readCookie(headers.get("cookie"), cookie.name);
    if (!nonce) return { cookies };
    const now = new Date();
    const [request] = await this.database.db
      .delete(appSignInRequest)
      .where(eq(appSignInRequest.id, hashSecret(nonce)))
      .returning();
    if (!request) return { cookies };
    const fail = (error: string) => ({
      redirect: appendQuery(request.redirectUri, { error, state: request.state }),
      cookies,
    });
    if (request.expiresAt <= now) return fail("request_expired");
    if (providerError !== undefined) {
      return fail(SAFE_ERROR.test(providerError) ? providerError : "access_denied");
    }
    const current = await this.auth.api.getSession({ headers });
    // Only a session minted by this sign-in counts, not one the browser already had.
    if (!current || current.session.createdAt < request.createdAt) return fail("no_session");

    const code = createSecret();
    await this.database.db.delete(appAuthCode).where(lte(appAuthCode.expiresAt, now));
    await this.database.db.insert(appAuthCode).values({
      codeHash: hashSecret(code),
      userId: current.user.id,
      sessionId: current.session.id,
      codeChallenge: request.codeChallenge,
      redirectUri: request.redirectUri,
      createdAt: now,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    });
    // The session now belongs to the app; the browser drops its copy of the cookie.
    const { authCookies } = await this.auth.$context;
    cookies.push(
      serializeCookie(
        authCookies.sessionToken.name,
        "",
        authCookies.sessionToken.attributes.secure,
        0,
      ),
    );
    return {
      redirect: appendQuery(request.redirectUri, { code, state: request.state }),
      cookies,
    };
  }

  // Single use is enforced under a row lock; a replay revokes the session the code handed out.
  async exchange(request: TokenRequest) {
    const now = new Date();
    const codeHash = hashSecret(request.code);
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(appAuthCode)
        .where(eq(appAuthCode.codeHash, codeHash))
        .for("update");
      const outcome = redeem(row, request, now);
      if (outcome === "replay") await tx.delete(session).where(eq(session.id, row!.sessionId));
      if (outcome === "expired")
        await tx.delete(appAuthCode).where(eq(appAuthCode.codeHash, codeHash));
      if (outcome !== "ok") return undefined;
      await tx.update(appAuthCode).set({ usedAt: now }).where(eq(appAuthCode.codeHash, codeHash));
      const [granted] = await tx
        .select({
          token: session.token,
          expiresAt: session.expiresAt,
          user: { id: user.id, name: user.name, email: user.email, image: user.image },
        })
        .from(session)
        .innerJoin(user, eq(user.id, session.userId))
        .where(and(eq(session.id, row!.sessionId), gt(session.expiresAt, now)));
      return granted && { ...granted, expiresAt: granted.expiresAt.toISOString() };
    });
  }

  private async requestCookie() {
    const cookie = (await this.auth.$context).createAuthCookie(REQUEST_COOKIE);
    return { name: cookie.name, secure: cookie.attributes.secure === true };
  }
}

function serializeCookie(name: string, value: string, secure: boolean | undefined, maxAge: number) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function readCookie(header: string | null, name: string) {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || undefined;
    }
  }
  return undefined;
}
