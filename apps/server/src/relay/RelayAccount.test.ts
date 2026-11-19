// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Drives the real loopback listener like a browser would.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { deniedMessage, parseCallback, signInComputer } from "./RelayAccount.ts";

const API = "https://cloud.test";

/** A fake cloud that records requests, and a "browser" that follows the sign-in address. */
function harness(browser: (start: URL) => string) {
  const calls: Array<{ path: string; authorization: string | null; body: unknown }> = [];
  let challenge = "";
  const cloud: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ path: url.pathname, authorization, body });
    switch (url.pathname) {
      case "/v1/auth/app/token": {
        const verified =
          NodeCrypto.createHash("sha256").update(String(body.code_verifier)).digest("base64url") ===
          challenge;
        return verified && body.code === "CODE"
          ? Response.json({ token: "session-token", expiresAt: "2027-01-01", user: { id: "u1" } })
          : new Response(null, { status: 400 });
      }
      case "/v1/devices":
        return Response.json({ device: { id: "dev-1" }, token: "gdt_device" });
      case "/v1/auth/sign-out":
        return new Response(null, { status: 204 });
      default:
        return new Response(null, { status: 404 });
    }
  };
  const openUrl = (address: string) => {
    const start = new URL(address);
    challenge = start.searchParams.get("code_challenge") ?? "";
    const callback = new URL(start.searchParams.get("redirect_uri")!);
    void fetch(new URL("/favicon.ico", callback)).then(() =>
      fetch(`${callback}?${browser(start)}`),
    );
  };
  return { calls, cloud, openUrl };
}

describe("signInComputer", () => {
  it("registers this computer and keeps only its device credential", async () => {
    const { calls, cloud, openUrl } = harness(
      (start) => `code=CODE&state=${start.searchParams.get("state")}`,
    );
    const credential = await signInComputer({
      apiUrl: API,
      computerName: "win-vm",
      openUrl,
      fetch: cloud,
    });
    expect(credential).toEqual({ relayUrl: API, deviceId: "dev-1", token: "gdt_device" });
    expect(calls.map((call) => [call.path, call.authorization])).toEqual([
      ["/v1/auth/app/token", null],
      ["/v1/devices", "Bearer session-token"],
      ["/v1/auth/sign-out", "Bearer session-token"],
    ]);
    expect(calls[1]?.body).toEqual({ name: "win-vm", kind: "computer" });
  });

  it("fails without asking the cloud when the browser answers for another attempt or denies", async () => {
    for (const [answer, message] of [
      [() => "code=CODE&state=other", "the browser answered for another attempt"],
      [(start: URL) => `error=access_denied&state=${start.searchParams.get("state")}`, "cancelled"],
    ] as const) {
      const { calls, cloud, openUrl } = harness(answer);
      await expect(
        signInComputer({ apiUrl: API, computerName: "x", openUrl, fetch: cloud }),
      ).rejects.toThrow(message);
      expect(calls).toEqual([]);
    }
  });
});

describe("loopback callback", () => {
  it("accepts only this attempt's callback and shows plain error codes", () => {
    expect(parseCallback("/callback?code=a%2Bb&state=s1", "s1")).toEqual({
      kind: "code",
      code: "a+b",
    });
    expect(parseCallback("/callback?state=s1", "s1")).toEqual({
      kind: "denied",
      error: "invalid_response",
    });
    expect(parseCallback("/callback?code=a&state=s2", "s1")).toEqual({ kind: "state_mismatch" });
    for (const target of ["/favicon.ico", "/callbackx?code=a&state=s1", "http://evil/callback"]) {
      expect(parseCallback(target, "s1")).toEqual({ kind: "other" });
    }
    expect(deniedMessage("server_error")).toBe("Sign-in failed (server_error).");
    expect(deniedMessage("<script>")).toBe("Sign-in failed.");
  });
});
