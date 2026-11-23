import { describe, expect, it, vi } from "vite-plus/test";

import {
  AccountApiError,
  buildSignInUrl,
  makeAccountApi,
  parseSignInRedirect,
  resolveAccountApiUrl,
} from "./accountApi";

describe("resolveAccountApiUrl", () => {
  it.each([
    [undefined, "https://api.libes6.ru"],
    ["  ", "https://api.libes6.ru"],
    ["https://api.example.com/", "https://api.example.com"],
    ["http://192.168.1.5:3000/base/", "http://192.168.1.5:3000/base"],
    ["ftp://api.example.com", "https://api.libes6.ru"],
    ["not a url", "https://api.libes6.ru"],
  ])("resolves %s to %s", (value, expected) => {
    expect(resolveAccountApiUrl(value)).toBe(expected);
  });
});

describe("sign-in redirect", () => {
  it("builds the start URL the server expects", () => {
    const url = new URL(
      buildSignInUrl({
        apiUrl: "https://api.libes6.ru",
        redirectUri: "gustaf-dev://auth",
        codeChallenge: "challenge",
        state: "state-1",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://api.libes6.ru/v1/auth/app/start");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      redirect_uri: "gustaf-dev://auth",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      state: "state-1",
    });
  });

  it.each([
    ["gustaf://auth?code=abc&state=s1", { _tag: "Code", code: "abc" }],
    ["gustaf://auth?error=access_denied&state=s1", { _tag: "Failed", reason: "access_denied" }],
    ["gustaf://auth?code=abc&state=other", { _tag: "Failed", reason: "state_mismatch" }],
    ["gustaf://auth?code=abc", { _tag: "Failed", reason: "state_mismatch" }],
    ["gustaf://auth?error=access_denied&state=other", { _tag: "Failed", reason: "state_mismatch" }],
    ["gustaf://auth?state=s1", { _tag: "Failed", reason: "missing_code" }],
    ["not a url", { _tag: "Failed", reason: "invalid_redirect" }],
  ])("parses %s", (url, expected) => {
    expect(parseSignInRedirect(url, "s1")).toEqual(expected);
  });
});

describe("makeAccountApi", () => {
  it("exchanges the code with the verifier and decodes the session", async () => {
    const fetch = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({
          token: "bearer-1",
          expiresAt: "2030-01-01T00:00:00.000Z",
          user: { id: "u1", name: "Ada", email: "ada@example.com", image: null },
        }),
      ),
    );
    const api = makeAccountApi("https://api.libes6.ru", fetch);

    const session = await api.exchangeCode({
      code: "code-1",
      codeVerifier: "verifier-1",
      redirectUri: "gustaf://auth",
    });

    expect(session.token).toBe("bearer-1");
    const [input, init] = fetch.mock.calls[0]!;
    expect(input).toBe("https://api.libes6.ru/v1/auth/app/token");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      code: "code-1",
      code_verifier: "verifier-1",
      redirect_uri: "gustaf://auth",
    });
  });

  it("sends the bearer token and reports the status of a failed request", async () => {
    const fetch = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve(new Response("Unauthorized", { status: 401 })),
    );
    const api = makeAccountApi("https://api.libes6.ru", fetch);

    const error = await api.listDevices("bearer-1").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AccountApiError);
    expect((error as AccountApiError).status).toBe(401);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("Authorization")).toBe(
      "Bearer bearer-1",
    );
  });
});
