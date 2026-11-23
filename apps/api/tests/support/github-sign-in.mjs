import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import pg from "pg";
import { createApp } from "../../dist/app.js";
import { readConfig } from "../../dist/config.js";
import { runMigrations } from "../../dist/database/migrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL database");

// Shared by the integration tests. GitHub is stubbed at the network boundary: Better Auth runs
// its real OAuth callback code.
const githubProfiles = new Map();
export const githubRedirects = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
    const body = new URLSearchParams(String(init.body));
    githubRedirects.push(body.get("redirect_uri"));
    return Response.json({ access_token: `at-${body.get("code")}`, token_type: "bearer" });
  }
  if (url.origin === "https://api.github.com") {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const profile = githubProfiles.get(authorization.replace(/^Bearer at-/, ""));
    if (!profile) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (url.pathname === "/user") return Response.json({ ...profile, email: null });
    if (url.pathname === "/user/emails") {
      return Response.json([{ email: profile.email, primary: true, verified: true }]);
    }
  }
  return realFetch(input, init);
};

export function githubUser(login) {
  const suffix = NodeCrypto.randomUUID().slice(0, 8);
  const profile = {
    id: NodeCrypto.randomInt(1, 2 ** 31),
    login: `${login}-${suffix}`,
    name: login,
    email: `${login}-${suffix}@example.test`,
    avatar_url: null,
  };
  githubProfiles.set(profile.login, profile);
  return profile;
}

async function freePort() {
  const server = NodeNet.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function withApi(run, env = {}) {
  await runMigrations(databaseUrl);
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const app = await createApp(
    readConfig({
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: "integration-test-secret-integration-test",
      PUBLIC_BASE_URL: base,
      GITHUB_CLIENT_ID: "integration-client",
      GITHUB_CLIENT_SECRET: "integration-secret",
      AUTH_TRUSTED_ORIGINS: "gustaf://",
      ...(typeof env === "function" ? env(base) : env),
    }),
  );
  app.useLogger(false);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await app.listen(port, "127.0.0.1");
    await run({ base, pool, api: client(base) });
  } finally {
    await pool.end();
    await app.close();
  }
}

function client(base) {
  return async (path, { auth, method = "GET", body, headers: extra } = {}) => {
    const headers = { origin: base, ...extra };
    if (auth?.cookie) headers.cookie = auth.cookie;
    if (auth?.bearer) headers.authorization = `Bearer ${auth.bearer}`;
    const init = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
}

export async function signIn(base, profile, callbackURL = "/signed-in") {
  const start = await fetch(`${base}/v1/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ provider: "github", callbackURL }),
  });
  NodeAssert.equal(start.status, 200);
  const { url } = await start.json();
  const authorize = new URL(url);
  NodeAssert.equal(
    authorize.origin + authorize.pathname,
    "https://github.com/login/oauth/authorize",
  );
  const cookie = start.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const callback = await fetch(
    `${base}/v1/auth/callback/github?code=${profile.login}&state=${authorize.searchParams.get("state")}`,
    { headers: { cookie }, redirect: "manual" },
  );
  NodeAssert.equal(callback.status, 302);
  NodeAssert.equal(callback.headers.get("location"), callbackURL);
  const sessionCookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith("better-auth.session_token="));
  NodeAssert.ok(sessionCookie, "callback sets the session cookie");
  const bearer = callback.headers.get("set-auth-token");
  NodeAssert.ok(bearer, "callback exposes the bearer token");
  return { cookie: sessionCookie.split(";")[0], bearer };
}

export async function registerDevice(api, auth, name, kind) {
  const response = await api("/v1/devices", { auth, method: "POST", body: { name, kind } });
  NodeAssert.equal(response.status, 201);
  return response.body;
}
