import { describe, expect, it, vi } from "vite-plus/test";

import { ApiError, buildUrl, createApiClient, errorKindForStatus, isApiError } from "./client";

const BASE = "https://api.example.test";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup(response: Response | Error = jsonResponse(200, { items: [], nextCursor: null })) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const api = createApiClient({ baseUrl: BASE, fetch });
  const call = () => {
    const [url, init] = fetch.mock.calls[0]!;
    return { url: String(url), init: init!, headers: init!.headers as Record<string, string> };
  };
  return { api, fetch, call };
}

describe("buildUrl", () => {
  it("joins paths onto the base, keeping a base path and dropping empty params", () => {
    expect(buildUrl("https://api.example.test", "/v1/me")).toBe("https://api.example.test/v1/me");
    expect(buildUrl("https://host.test/api/", "/v1/me")).toBe("https://host.test/api/v1/me");
    expect(
      buildUrl(BASE, "/v1/admin/users", { query: "a b&c", cursor: null, kind: "", limit: 25 }),
    ).toBe(`${BASE}/v1/admin/users?query=a+b%26c&limit=25`);
  });
});

describe("createApiClient", () => {
  it("sends reads with credentials and without the mutation header", async () => {
    const { api, call } = setup(jsonResponse(200, { id: "u1", role: "admin" }));
    await expect(api.me()).resolves.toMatchObject({ role: "admin" });
    const { url, init, headers } = call();
    expect(url).toBe(`${BASE}/v1/me`);
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
    expect(headers["x-requested-with"]).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("marks every mutation with x-requested-with and sends JSON bodies", async () => {
    const { api, call } = setup(new Response(null, { status: 204 }));
    await expect(api.banUser("u/1", "spam")).resolves.toBeUndefined();
    const { url, init, headers } = call();
    expect(url).toBe(`${BASE}/v1/admin/users/u%2F1/ban`);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(headers["x-requested-with"]).toBe("gustaf-admin");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ reason: "spam" });
  });

  it("maps each admin action to its route and method", async () => {
    const cases = [
      [
        (a: ReturnType<typeof createApiClient>) => a.unbanUser("u1"),
        "POST",
        "/v1/admin/users/u1/unban",
      ],
      [
        (a: ReturnType<typeof createApiClient>) => a.revokeSessions("u1"),
        "POST",
        "/v1/admin/users/u1/revoke-sessions",
      ],
      [
        (a: ReturnType<typeof createApiClient>) => a.changeRole("u1", "admin"),
        "PATCH",
        "/v1/admin/users/u1/role",
      ],
      [
        (a: ReturnType<typeof createApiClient>) => a.deleteUser("u1"),
        "DELETE",
        "/v1/admin/users/u1",
      ],
      [
        (a: ReturnType<typeof createApiClient>) => a.revokeDevice("d1"),
        "POST",
        "/v1/admin/devices/d1/revoke",
      ],
      [(a: ReturnType<typeof createApiClient>) => a.signOut(), "POST", "/v1/auth/sign-out"],
    ] as const;
    for (const [invoke, method, path] of cases) {
      const { api, call } = setup(jsonResponse(200, {}));
      await invoke(api);
      expect(call().init.method).toBe(method);
      expect(call().url).toBe(`${BASE}${path}`);
      expect(call().headers["x-requested-with"]).toBe("gustaf-admin");
    }
  });

  it("starts GitHub sign-in with the admin origin as callback", async () => {
    const { api, call } = setup(jsonResponse(200, { url: "https://github.com/login" }));
    await expect(api.signIn("https://admin.example.test/")).resolves.toEqual({
      url: "https://github.com/login",
    });
    expect(call().url).toBe(`${BASE}/v1/auth/sign-in/social`);
    expect(JSON.parse(String(call().init.body))).toEqual({
      provider: "github",
      callbackURL: "https://admin.example.test/",
    });
  });

  it("passes cursor, filters and a clamped limit, and returns nextCursor", async () => {
    const { api, call } = setup(jsonResponse(200, { items: [{ id: "d1" }], nextCursor: "c2" }));
    const page = await api.listDevices({
      query: "  mac ",
      kind: "phone",
      cursor: "c1",
      limit: 500,
    });
    expect(page.nextCursor).toBe("c2");
    const url = new URL(call().url);
    expect(url.pathname).toBe("/v1/admin/devices");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: "mac",
      kind: "phone",
      cursor: "c1",
      limit: "100",
    });
  });

  it("omits the cursor on the first page", async () => {
    const { api, call } = setup();
    await api.listAudit({ cursor: null });
    expect(call().url).toBe(`${BASE}/v1/admin/audit`);
  });

  it("maps error responses to typed errors with the API message", async () => {
    const { api } = setup(jsonResponse(403, { error: "Admins only" }));
    const error = await api.overview().catch((e: unknown) => e);
    expect(isApiError(error, "forbidden")).toBe(true);
    expect((error as ApiError).message).toBe("Admins only");
    expect((error as ApiError).status).toBe(403);
  });

  it("falls back to the status text when the error body is not JSON", async () => {
    const { api } = setup(new Response("<html>", { status: 502, statusText: "Bad Gateway" }));
    const error = await api.overview().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe("server");
    expect((error as ApiError).message).toBe("Bad Gateway");
  });

  it("reports a failed fetch as a network error", async () => {
    const { api } = setup(new TypeError("Failed to fetch"));
    const error = await api.me().catch((e: unknown) => e);
    expect(isApiError(error, "network")).toBe(true);
  });
});

describe("errorKindForStatus", () => {
  it("names each status the API documents", () => {
    expect(
      [0, 400, 401, 403, 404, 409, 429, 500, 503].map((status) => errorKindForStatus(status)),
    ).toEqual([
      "network",
      "bad-request",
      "unauthorized",
      "forbidden",
      "not-found",
      "bad-request",
      "rate-limited",
      "server",
      "server",
    ]);
  });
});
