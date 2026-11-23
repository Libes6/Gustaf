import { GustafCloudUserSchema, type GustafCloudUser } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

export const DEFAULT_GUSTAF_CLOUD_API_BASE = "https://api.libes6.ru";

const REQUEST_TIMEOUT = Duration.seconds(20);

export class GustafCloudUnauthorizedError extends Schema.TaggedError<GustafCloudUnauthorizedError>()(
  "GustafCloudUnauthorizedError",
  {},
) {
  override get message(): string {
    return "Your Gustaf account session has expired.";
  }
}

export class GustafCloudRequestError extends Schema.TaggedError<GustafCloudRequestError>()(
  "GustafCloudRequestError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type GustafCloudApiError = GustafCloudUnauthorizedError | GustafCloudRequestError;

const CloudUserInputSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  image: Schema.optional(Schema.NullOr(Schema.String)),
});

const TokenGrantSchema = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.String,
  user: CloudUserInputSchema,
});

export interface GustafCloudTokenGrant {
  readonly token: string;
  readonly expiresAt: string;
  readonly user: GustafCloudUser;
}

const CloudDeviceSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  createdAt: Schema.String,
  lastSeenAt: Schema.optional(Schema.NullOr(Schema.String)),
});

export interface GustafCloudDevice {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
}

const DeviceListSchema = Schema.Struct({
  devices: Schema.Array(CloudDeviceSchema),
});

const RegisteredDeviceSchema = Schema.Struct({
  device: CloudDeviceSchema,
  token: Schema.String,
});

const decodeTokenGrant = Schema.decodeUnknownEffect(TokenGrantSchema);
const decodeDeviceList = Schema.decodeUnknownEffect(DeviceListSchema);
const decodeRegisteredDevice = Schema.decodeUnknownEffect(RegisteredDeviceSchema);

function normalizeCloudUser(user: typeof CloudUserInputSchema.Type): GustafCloudUser {
  return {
    id: user.id,
    name: user.name ?? null,
    email: user.email ?? null,
    image: user.image ?? null,
  };
}

function normalizeCloudDevice(device: typeof CloudDeviceSchema.Type): GustafCloudDevice {
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt ?? null,
  };
}

export function resolveGustafCloudApiBase(value: string | undefined): string {
  try {
    const url = new URL(value?.trim() || DEFAULT_GUSTAF_CLOUD_API_BASE);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return DEFAULT_GUSTAF_CLOUD_API_BASE;
    }
    return url.origin;
  } catch {
    return DEFAULT_GUSTAF_CLOUD_API_BASE;
  }
}

export function buildSignInUrl(input: {
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly apiBase?: string;
}): string {
  const url = new URL("/v1/auth/app/start", input.apiBase ?? DEFAULT_GUSTAF_CLOUD_API_BASE);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  return url.toString();
}

/** `macos-arm64`, `windows-x64`, `linux-x64`; the cloud rejects anything else for a computer. */
export function resolveHeartbeatPlatform(platform: string, arch: string): string | null {
  const normalizedOs =
    platform === "darwin" || platform === "macos"
      ? "macos"
      : platform === "win32" || platform === "windows"
        ? "windows"
        : platform === "linux"
          ? "linux"
          : null;
  if (normalizedOs === null) return null;
  const normalizedArch =
    arch === "arm64" || arch === "aarch64"
      ? "arm64"
      : arch === "x64" || arch === "x86_64"
        ? "x64"
        : null;
  if (normalizedArch === null) return null;
  return `${normalizedOs}-${normalizedArch}`;
}

export function resolveClientConfigPlatform(platform: string): "macos" | "windows" | "linux" {
  if (platform === "darwin" || platform === "macos") return "macos";
  if (platform === "win32" || platform === "windows") return "windows";
  return "linux";
}

export function resolveReportPlatform(platform: string, arch: string): string {
  const normalizedOs =
    platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform;
  return `${normalizedOs} ${arch}`;
}

const executeRequest = Effect.fn("gustaf.cloudApi.executeRequest")(function* (input: {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly apiBase?: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly token?: string | null;
  readonly body?: unknown;
}) {
  const client = yield* HttpClient.HttpClient;
  const url = new URL(input.path, input.apiBase ?? DEFAULT_GUSTAF_CLOUD_API_BASE);
  if (input.query) {
    for (const [key, value] of Object.entries(input.query)) {
      url.searchParams.set(key, value);
    }
  }
  let request =
    input.method === "GET"
      ? HttpClientRequest.get(url.toString())
      : input.method === "POST"
        ? HttpClientRequest.post(url.toString())
        : HttpClientRequest.delete(url.toString());
  request = HttpClientRequest.setHeader(request, "accept", "application/json");
  if (input.token) {
    request = HttpClientRequest.bearerToken(request, input.token);
  }
  if (input.body !== undefined) {
    request = HttpClientRequest.bodyJsonUnsafe(request, input.body);
  }

  const response = yield* client.execute(request).pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.mapError(
      () => new GustafCloudRequestError({ detail: "Cannot reach the Gustaf cloud." }),
    ),
  );

  if (response.status === 401) {
    return yield* new GustafCloudUnauthorizedError();
  }
  if (response.status === 429) {
    return yield* new GustafCloudRequestError({
      detail: "Too many requests to the Gustaf cloud. Try again later.",
    });
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* new GustafCloudRequestError({
      detail: `The Gustaf cloud answered with HTTP ${response.status}.`,
    });
  }
  return response;
});

const readJsonBody = Effect.fn("gustaf.cloudApi.readJsonBody")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  return yield* response.json.pipe(
    Effect.mapError(
      () =>
        new GustafCloudRequestError({
          detail: "The Gustaf cloud sent an unexpected answer.",
        }),
    ),
  );
});

export const exchangeCode = Effect.fn("gustaf.cloudApi.exchangeCode")(function* (input: {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly apiBase?: string;
}): Effect.fn.Return<GustafCloudTokenGrant, GustafCloudApiError, HttpClient.HttpClient> {
  const response = yield* executeRequest({
    method: "POST",
    path: "/v1/auth/app/token",
    ...(input.apiBase !== undefined ? { apiBase: input.apiBase } : {}),
    body: {
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    },
  });
  const raw = yield* readJsonBody(response);
  const grant = yield* decodeTokenGrant(raw).pipe(
    Effect.mapError(
      () =>
        new GustafCloudRequestError({
          detail: "The Gustaf cloud sent an unexpected answer.",
        }),
    ),
  );
  if (grant.token.length === 0) {
    return yield* new GustafCloudRequestError({
      detail: "The Gustaf cloud did not return a session.",
    });
  }
  return {
    token: grant.token,
    expiresAt: grant.expiresAt,
    user: normalizeCloudUser(grant.user),
  };
});

export const signOut = Effect.fn("gustaf.cloudApi.signOut")(function* (input: {
  readonly token: string;
  readonly apiBase?: string;
}): Effect.fn.Return<void, GustafCloudApiError, HttpClient.HttpClient> {
  yield* executeRequest({
    method: "POST",
    path: "/v1/auth/sign-out",
    ...(input.apiBase !== undefined ? { apiBase: input.apiBase } : {}),
    token: input.token,
    body: {},
  });
});

export const listDevices = Effect.fn("gustaf.cloudApi.listDevices")(function* (input: {
  readonly token: string;
  readonly apiBase?: string;
}): Effect.fn.Return<readonly GustafCloudDevice[], GustafCloudApiError, HttpClient.HttpClient> {
  const response = yield* executeRequest({
    method: "GET",
    path: "/v1/devices",
    ...(input.apiBase !== undefined ? { apiBase: input.apiBase } : {}),
    token: input.token,
  });
  const raw = yield* readJsonBody(response);
  const list = yield* decodeDeviceList(raw).pipe(
    Effect.mapError(
      () =>
        new GustafCloudRequestError({
          detail: "The Gustaf cloud sent an unexpected answer.",
        }),
    ),
  );
  return list.devices.map(normalizeCloudDevice);
});

export const registerComputer = Effect.fn("gustaf.cloudApi.registerComputer")(function* (input: {
  readonly token: string;
  readonly name: string;
  readonly apiBase?: string;
}): Effect.fn.Return<
  { readonly device: GustafCloudDevice; readonly token: string },
  GustafCloudApiError,
  HttpClient.HttpClient
> {
  const response = yield* executeRequest({
    method: "POST",
    path: "/v1/devices",
    ...(input.apiBase !== undefined ? { apiBase: input.apiBase } : {}),
    token: input.token,
    body: { name: input.name, kind: "computer" },
  });
  const raw = yield* readJsonBody(response);
  const registered = yield* decodeRegisteredDevice(raw).pipe(
    Effect.mapError(
      () =>
        new GustafCloudRequestError({
          detail: "The Gustaf cloud sent an unexpected answer.",
        }),
    ),
  );
  return {
    device: normalizeCloudDevice(registered.device),
    token: registered.token,
  };
});

export const sendHeartbeat = Effect.fn("gustaf.cloudApi.sendHeartbeat")(function* (input: {
  readonly deviceToken: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly apiBase?: string;
}): Effect.fn.Return<void, GustafCloudApiError, HttpClient.HttpClient> {
  const cloudPlatform = resolveHeartbeatPlatform(input.platform, input.arch);
  if (cloudPlatform === null) {
    return yield* new GustafCloudRequestError({ detail: "This platform is not reported." });
  }
  yield* executeRequest({
    method: "POST",
    path: "/v1/devices/heartbeat",
    ...(input.apiBase !== undefined ? { apiBase: input.apiBase } : {}),
    token: input.deviceToken,
    body: { appVersion: input.appVersion, platform: cloudPlatform },
  });
});

export const revokeDevice = Effect.fn("gustaf.cloudApi.revokeDevice")(function* (input: {
  readonly token: string;
  readonly deviceId: string;
  readonly apiBase?: string;
}): Effect.fn.Return<void, GustafCloudApiError, HttpClient.HttpClient> {
  yield* executeRequest({
    method: "DELETE",
    path: `/v1/devices/${input.deviceId}`,
    ...(input.apiBase !== undefined ? { apiBase: input.apiBase } : {}),
    token: input.token,
  });
});

export const fetchClientConfig = Effect.fn("gustaf.cloudApi.fetchClientConfig")(function* (input: {
  readonly version: string;
  readonly platform: string;
  readonly token?: string | null;
  readonly apiBase?: string;
}): Effect.fn.Return<unknown, GustafCloudApiError, HttpClient.HttpClient> {
  const response = yield* executeRequest({
    method: "GET",
    path: "/v1/client-config",
    ...(input.apiBase !== undefined ? { apiBase: input.apiBase } : {}),
    query: {
      kind: "desktop",
      version: input.version,
      platform: resolveClientConfigPlatform(input.platform),
    },
    ...(input.token ? { token: input.token } : {}),
  });
  return yield* readJsonBody(response);
});

export const sendReport = Effect.fn("gustaf.cloudApi.sendReport")(function* (input: {
  readonly token: string;
  readonly message: string;
  readonly logs: string | null;
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly deviceId: string | null;
  readonly apiBase?: string;
}): Effect.fn.Return<void, GustafCloudApiError, HttpClient.HttpClient> {
  yield* executeRequest({
    method: "POST",
    path: "/v1/reports",
    ...(input.apiBase !== undefined ? { apiBase: input.apiBase } : {}),
    token: input.token,
    body: {
      client: "desktop",
      message: input.message,
      logs: input.logs,
      appVersion: input.appVersion,
      platform: resolveReportPlatform(input.platform, input.arch),
      deviceId: input.deviceId,
    },
  });
});

export { GustafCloudUserSchema };
