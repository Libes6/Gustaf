/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

import { describe, expect, it, vi } from "vite-plus/test";

const secureStore = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: (key: string) => Promise.resolve(secureStore.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  },
  deleteItemAsync: (key: string) => {
    secureStore.delete(key);
    return Promise.resolve();
  },
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  getRandomBytes: (byteCount: number) => new Uint8Array(NodeCrypto.randomBytes(byteCount)),
  digest: (algorithm: string, data: Uint8Array) =>
    Promise.resolve(new Uint8Array(NodeCrypto.createHash(algorithm).update(data).digest()).buffer),
}));

import { AccountApiError, type AccountApi, type AccountDevice } from "./accountApi";
import { type AuthSessionResult, createAccountStore } from "./accountStore";
import { pkceChallenge } from "./pkce";

const USER = { id: "u1", name: "Ada", email: "ada@example.com", image: null };
const COMPUTER: AccountDevice = {
  id: "d1",
  name: "Workstation",
  kind: "computer",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: null,
};
const SESSION_KEY = "gustaf.account.session";
const PHONE_KEY = "gustaf.account.phone-device";

function setup(
  options: {
    readonly redirect?: (state: string) => AuthSessionResult;
    readonly api?: Partial<AccountApi>;
  } = {},
) {
  secureStore.clear();
  const opened: string[] = [];
  const api = {
    exchangeCode: vi.fn<AccountApi["exchangeCode"]>(() =>
      Promise.resolve({ token: "bearer-1", expiresAt: "2999-01-01T00:00:00.000Z", user: USER }),
    ),
    me: vi.fn<AccountApi["me"]>(() => Promise.resolve(USER)),
    signOut: vi.fn<AccountApi["signOut"]>(() => Promise.resolve()),
    listDevices: vi.fn<AccountApi["listDevices"]>(() => Promise.resolve([COMPUTER])),
    registerPhone: vi.fn<AccountApi["registerPhone"]>((_token, name) =>
      Promise.resolve({
        device: { ...COMPUTER, id: "p1", name, kind: "phone" as const },
        token: "gdt_secret",
      }),
    ),
    revokeDevice: vi.fn<AccountApi["revokeDevice"]>(() => Promise.resolve()),
    sendReport: vi.fn<AccountApi["sendReport"]>(() => Promise.resolve()),
  };
  const store = createAccountStore({
    api: { ...api, ...options.api },
    apiUrl: "https://api.libes6.ru",
    redirectUri: "gustaf://auth",
    phoneName: () => "Pixel",
    openAuthSession: (url) => {
      opened.push(url);
      const state = new URL(url).searchParams.get("state") ?? "";
      return Promise.resolve(
        options.redirect?.(state) ?? {
          type: "success",
          url: `gustaf://auth?code=code-1&state=${state}`,
        },
      );
    },
  });
  return { store, api, opened };
}

function signedIn(api: Partial<AccountApi> = {}) {
  const context = setup({ api });
  secureStore.set(
    SESSION_KEY,
    JSON.stringify({ token: "bearer-1", expiresAt: "2999-01-01T00:00:00.000Z", user: USER }),
  );
  return context;
}

describe("account sign-in", () => {
  it("exchanges the code with the verifier behind the challenge and stores the session", async () => {
    const { store, api, opened } = setup();

    await store.signIn();

    const challenge = new URL(opened[0]!).searchParams.get("code_challenge");
    const exchange = api.exchangeCode.mock.calls[0]![0];
    expect(exchange.code).toBe("code-1");
    expect(exchange.redirectUri).toBe("gustaf://auth");
    expect(await pkceChallenge(exchange.codeVerifier)).toBe(challenge);
    expect(JSON.parse(secureStore.get(SESSION_KEY)!)).toMatchObject({ token: "bearer-1" });
    expect(store.getState()).toMatchObject({ status: "signedIn", user: USER, devices: [COMPUTER] });
  });

  it("rejects a redirect carrying another state without exchanging or storing", async () => {
    const { store, api } = setup({
      redirect: () => ({ type: "success", url: "gustaf://auth?code=stolen&state=forged" }),
    });

    await store.signIn();

    expect(api.exchangeCode).not.toHaveBeenCalled();
    expect(secureStore.has(SESSION_KEY)).toBe(false);
    expect(store.getState()).toMatchObject({ busy: null, error: "state_mismatch" });
  });

  it("leaves the account untouched when the browser is dismissed", async () => {
    const { store, api } = setup({ redirect: () => ({ type: "dismiss" }) });

    await store.signIn();

    expect(api.exchangeCode).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ busy: null, error: null });
  });
});

describe("account session", () => {
  it("restores a stored session and drops an expired one", async () => {
    const { store } = signedIn();
    await store.ensureLoaded();
    expect(store.getState()).toMatchObject({ status: "signedIn", devices: [COMPUTER] });

    const expired = setup();
    secureStore.set(
      SESSION_KEY,
      JSON.stringify({ token: "old", expiresAt: "2000-01-01T00:00:00.000Z", user: USER }),
    );
    await expired.store.ensureLoaded();
    expect(expired.store.getState().status).toBe("signedOut");
    expect(secureStore.has(SESSION_KEY)).toBe(false);
  });

  it("signs out on the server and wipes the session and the device token", async () => {
    const { store, api } = signedIn();
    await store.ensureLoaded();
    await store.registerPhone();

    await store.signOut();

    expect(api.signOut).toHaveBeenCalledWith("bearer-1");
    expect(secureStore.size).toBe(0);
    expect(store.getState()).toMatchObject({ status: "signedOut", user: null, devices: null });
  });

  it("still wipes locally when the server cannot be reached", async () => {
    const { store } = signedIn({
      signOut: () => Promise.reject(new TypeError("Network request failed")),
    });
    await store.ensureLoaded();

    await store.signOut();

    expect(secureStore.size).toBe(0);
    expect(store.getState().status).toBe("signedOut");
  });

  it("forgets a session the server rejects", async () => {
    const { store } = signedIn({
      listDevices: () =>
        Promise.reject(new AccountApiError({ status: 401, detail: "Unauthorized" })),
    });

    await store.ensureLoaded();

    expect(secureStore.has(SESSION_KEY)).toBe(false);
    expect(store.getState()).toMatchObject({ status: "signedOut", error: "session_expired" });
  });
});

describe("account devices", () => {
  it("registers this phone once and keeps its token out of the state", async () => {
    const { store, api } = signedIn();
    await store.ensureLoaded();

    await store.registerPhone();
    await store.registerPhone();

    expect(api.registerPhone).toHaveBeenCalledTimes(1);
    expect(api.registerPhone).toHaveBeenCalledWith("bearer-1", "Pixel");
    expect(JSON.parse(secureStore.get(PHONE_KEY)!)).toEqual({
      userId: "u1",
      deviceId: "p1",
      token: "gdt_secret",
    });
    expect(store.getState().phoneDeviceId).toBe("p1");
    expect(JSON.stringify(store.getState())).not.toContain("gdt_secret");
  });

  it("drops this phone's credential when its device is revoked", async () => {
    const { store, api } = signedIn();
    await store.ensureLoaded();
    await store.registerPhone();

    await store.revokeDevice("p1");

    expect(api.revokeDevice).toHaveBeenCalledWith("bearer-1", "p1");
    expect(secureStore.has(PHONE_KEY)).toBe(false);
    expect(store.getState()).toMatchObject({ phoneDeviceId: null, devices: [COMPUTER] });
  });
});
