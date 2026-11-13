// The Gustaf cloud API contract (apps/api): every path and field name the app relies on lives here.
import * as Schema from "effect/Schema";

const DEFAULT_ACCOUNT_API_URL = "https://api.libes6.ru";

export function resolveAccountApiUrl(value = process.env.EXPO_PUBLIC_GUSTAF_API_URL): string {
  try {
    const url = new URL(value?.trim() || DEFAULT_ACCOUNT_API_URL);
    if (url.protocol !== "https:" && url.protocol !== "http:") return DEFAULT_ACCOUNT_API_URL;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return DEFAULT_ACCOUNT_API_URL;
  }
}

/** Where the API sends the browser back: the app's own scheme, one per build variant. */
export function accountRedirectUri(scheme: string): string {
  return `${scheme}://auth`;
}

const AccountUser = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  image: Schema.NullOr(Schema.String),
});
export type AccountUser = typeof AccountUser.Type;

const AccountSession = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.String,
  user: AccountUser,
});
export type AccountSession = typeof AccountSession.Type;

const AccountDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["computer", "phone"]),
  createdAt: Schema.String,
  lastSeenAt: Schema.NullOr(Schema.String),
});
export type AccountDevice = typeof AccountDevice.Type;

const decodeSession = Schema.decodeUnknownSync(AccountSession);
const decodeMe = Schema.decodeUnknownSync(Schema.Struct({ user: AccountUser }));
const decodeDevices = Schema.decodeUnknownSync(
  Schema.Struct({ devices: Schema.Array(AccountDevice) }),
);
const decodeRegisteredDevice = Schema.decodeUnknownSync(
  Schema.Struct({ device: AccountDevice, token: Schema.String }),
);

export function buildSignInUrl(input: {
  readonly apiUrl: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
}): string {
  const url = new URL(`${input.apiUrl}/v1/auth/app/start`);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export type SignInRedirect =
  | { readonly _tag: "Code"; readonly code: string }
  | { readonly _tag: "Failed"; readonly reason: string };

/** Reads `redirect_uri?code=…&state=…` (or `?error=…`) and rejects a state this app did not send. */
export function parseSignInRedirect(redirectUrl: string, expectedState: string): SignInRedirect {
  let params: URLSearchParams;
  try {
    params = new URL(redirectUrl).searchParams;
  } catch {
    return { _tag: "Failed", reason: "invalid_redirect" };
  }
  if (params.get("state") !== expectedState) return { _tag: "Failed", reason: "state_mismatch" };
  const error = params.get("error");
  if (error) return { _tag: "Failed", reason: error };
  const code = params.get("code");
  return code ? { _tag: "Code", code } : { _tag: "Failed", reason: "missing_code" };
}

export class AccountApiError extends Schema.TaggedError<AccountApiError>()("AccountApiError", {
  status: Schema.Number,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** What the phone reports about itself: never names, paths or anything the user typed. */
export interface AccountHeartbeat {
  readonly appVersion: string;
  readonly platform: "android" | "ios";
  readonly osVersion: string | null;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface AccountApi {
  readonly exchangeCode: (input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }) => Promise<AccountSession>;
  readonly me: (token: string) => Promise<AccountUser>;
  readonly signOut: (token: string) => Promise<void>;
  readonly listDevices: (token: string) => Promise<ReadonlyArray<AccountDevice>>;
  readonly registerPhone: (
    token: string,
    name: string,
  ) => Promise<{ readonly device: AccountDevice; readonly token: string }>;
  readonly revokeDevice: (token: string, deviceId: string) => Promise<void>;
  readonly sendReport: (token: string, report: ProblemReport) => Promise<void>;
  /** Authenticated by the phone's device credential, not the session. */
  readonly heartbeat: (deviceToken: string, report: AccountHeartbeat) => Promise<void>;
}

/** "Report a problem" from the phone: the message only, the app keeps no log of its own. */
export interface ProblemReport {
  readonly message: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly deviceId: string | null;
}

export function makeAccountApi(apiUrl: string, fetchImpl: Fetch): AccountApi {
  const request = async (
    method: string,
    path: string,
    options: { readonly token?: string; readonly body?: unknown } = {},
  ): Promise<unknown> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new AccountApiError({
        status: response.status,
        detail: detail || `${method} ${path} ${response.status}`,
      });
    }
    return response.status === 204 ? null : response.json();
  };

  return {
    exchangeCode: async ({ code, codeVerifier, redirectUri }) =>
      decodeSession(
        await request("POST", "/v1/auth/app/token", {
          body: { code, code_verifier: codeVerifier, redirect_uri: redirectUri },
        }),
      ),
    me: async (token) => decodeMe(await request("GET", "/v1/me", { token })).user,
    signOut: async (token) => {
      await request("POST", "/v1/auth/sign-out", { token, body: {} });
    },
    listDevices: async (token) =>
      decodeDevices(await request("GET", "/v1/devices", { token })).devices,
    registerPhone: async (token, name) =>
      decodeRegisteredDevice(
        await request("POST", "/v1/devices", { token, body: { name, kind: "phone" } }),
      ),
    revokeDevice: async (token, deviceId) => {
      await request("DELETE", `/v1/devices/${encodeURIComponent(deviceId)}`, { token });
    },
    sendReport: async (token, report) => {
      await request("POST", "/v1/reports", { token, body: { client: "mobile", ...report } });
    },
    heartbeat: async (deviceToken, report) => {
      await request("POST", "/v1/devices/heartbeat", { token: deviceToken, body: report });
    },
  };
}
