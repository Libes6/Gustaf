import * as Schema from "effect/Schema";

import {
  AccountApiError,
  type AccountApi,
  type AccountDevice,
  type AccountUser,
  buildSignInUrl,
  type ProblemReport,
  parseSignInRedirect,
} from "./accountApi";
import * as Storage from "./accountStorage";
import { createSignInSecrets } from "./pkce";

export type AccountBusy = "signIn" | "signOut" | "registerPhone" | "devices" | null;

export interface AccountState {
  readonly status: "loading" | "signedOut" | "signedIn";
  readonly user: AccountUser | null;
  readonly devices: ReadonlyArray<AccountDevice> | null;
  /** The device this phone registered, so the list can mark it and hide "Register this phone". */
  readonly phoneDeviceId: string | null;
  readonly busy: AccountBusy;
  readonly revokingDeviceId: string | null;
  readonly error: string | null;
}

const isAccountApiError = Schema.is(AccountApiError);

const INITIAL_STATE: AccountState = {
  status: "loading",
  user: null,
  devices: null,
  phoneDeviceId: null,
  busy: null,
  revokingDeviceId: null,
  error: null,
};

export type AuthSessionResult =
  | { readonly type: "success"; readonly url: string }
  | { readonly type: "cancel" | "dismiss" | "locked" | "opened" };

export interface AccountStoreDeps {
  readonly api: AccountApi;
  readonly apiUrl: string;
  readonly redirectUri: string;
  readonly openAuthSession: (url: string, redirectUri: string) => Promise<AuthSessionResult>;
  readonly phoneName: () => string;
  readonly whenStorageReady?: () => Promise<void>;
}

export type AccountStore = ReturnType<typeof createAccountStore>;

export function createAccountStore(deps: AccountStoreDeps) {
  let state = INITIAL_STATE;
  let token: string | null = null;
  let loading: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<AccountState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const forgetLocally = async (error: string | null = null) => {
    token = null;
    await Storage.clearAccount();
    set({ ...INITIAL_STATE, status: "signedOut", error });
  };

  // A rejected bearer means the server ended the session; anything else is shown and kept.
  const fail = async (cause: unknown) => {
    if (isAccountApiError(cause) && cause.status === 401) {
      await forgetLocally("session_expired");
      return;
    }
    set({ busy: null, revokingDeviceId: null, error: errorMessage(cause) });
  };

  const refreshDevices = async () => {
    if (!token) return;
    set({ busy: "devices", error: null });
    try {
      const [user, devices] = await Promise.all([deps.api.me(token), deps.api.listDevices(token)]);
      const phone = await Storage.loadPhoneDevice();
      // A phone revoked from another client loses its credential here too.
      const phoneDeviceId =
        phone && devices.some((device) => device.id === phone.deviceId) ? phone.deviceId : null;
      if (phone && !phoneDeviceId) await Storage.clearPhoneDevice();
      set({ user, devices, phoneDeviceId, busy: null });
    } catch (cause) {
      await fail(cause);
    }
  };

  const load = async () => {
    await deps.whenStorageReady?.();
    const session = await Storage.loadSession();
    if (!session || Date.parse(session.expiresAt) <= Date.now()) {
      await forgetLocally();
      return;
    }
    token = session.token;
    const phone = await Storage.loadPhoneDevice();
    set({
      status: "signedIn",
      user: session.user,
      phoneDeviceId: phone?.userId === session.user.id ? phone.deviceId : null,
    });
    await refreshDevices();
  };

  const ensureLoaded = () => {
    loading ??= load().catch((cause: unknown) => {
      set({ status: "signedOut", error: errorMessage(cause) });
    });
    return loading;
  };

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      void ensureLoaded();
      return () => {
        listeners.delete(listener);
      };
    },
    ensureLoaded,
    refreshDevices,

    async signIn() {
      if (state.busy) return;
      set({ busy: "signIn", error: null });
      try {
        const secrets = await createSignInSecrets();
        const result = await deps.openAuthSession(
          buildSignInUrl({
            apiUrl: deps.apiUrl,
            redirectUri: deps.redirectUri,
            codeChallenge: secrets.codeChallenge,
            state: secrets.state,
          }),
          deps.redirectUri,
        );
        if (result.type !== "success") {
          set({ busy: null });
          return;
        }
        const redirect = parseSignInRedirect(result.url, secrets.state);
        if (redirect._tag === "Failed") {
          set({ busy: null, error: redirect.reason });
          return;
        }
        const session = await deps.api.exchangeCode({
          code: redirect.code,
          codeVerifier: secrets.codeVerifier,
          redirectUri: deps.redirectUri,
        });
        await Storage.clearPhoneDevice();
        await Storage.saveSession(session);
        token = session.token;
        set({
          status: "signedIn",
          user: session.user,
          devices: null,
          phoneDeviceId: null,
          busy: null,
        });
        await refreshDevices();
      } catch (cause) {
        await fail(cause);
      }
    },

    async signOut() {
      if (state.busy === "signOut") return;
      set({ busy: "signOut", error: null });
      // The local credential goes even when the server cannot be reached.
      if (token) await deps.api.signOut(token).catch(() => undefined);
      await forgetLocally();
    },

    async registerPhone() {
      if (!token || state.busy || state.phoneDeviceId || !state.user) return;
      const userId = state.user.id;
      set({ busy: "registerPhone", error: null });
      try {
        const registered = await deps.api.registerPhone(token, deps.phoneName());
        await Storage.savePhoneDevice({
          userId,
          deviceId: registered.device.id,
          token: registered.token,
        });
        set({
          busy: null,
          phoneDeviceId: registered.device.id,
          devices: [...(state.devices ?? []), registered.device],
        });
      } catch (cause) {
        await fail(cause);
      }
    },

    /** Resolves when the cloud stored the report; rejects with the reason otherwise. */
    async reportProblem(report: Omit<ProblemReport, "deviceId">) {
      if (!token) throw new Error("session_expired");
      try {
        await deps.api.sendReport(token, { ...report, deviceId: state.phoneDeviceId });
      } catch (cause) {
        if (isAccountApiError(cause) && cause.status === 401)
          await forgetLocally("session_expired");
        throw cause;
      }
    },

    async revokeDevice(deviceId: string) {
      if (!token || state.revokingDeviceId) return;
      set({ revokingDeviceId: deviceId, error: null });
      try {
        await deps.api.revokeDevice(token, deviceId);
        if (deviceId === state.phoneDeviceId) await Storage.clearPhoneDevice();
        set({
          revokingDeviceId: null,
          devices: (state.devices ?? []).filter((device) => device.id !== deviceId),
          phoneDeviceId: deviceId === state.phoneDeviceId ? null : state.phoneDeviceId,
        });
      } catch (cause) {
        await fail(cause);
      }
    },
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
