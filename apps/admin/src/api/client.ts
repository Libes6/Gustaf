import type {
  AdminDevice,
  AdminUser,
  AdminUserDetail,
  AuditEntry,
  DeviceKind,
  Me,
  Overview,
  Page,
  RelayHealth,
  ReleaseStats,
  Role,
  SystemStatus,
} from "./types";

// Every HTTP detail of the cloud API lives in this module, so a route rename is a one-place change.

export const MAX_PAGE_SIZE = 100;
export const MUTATION_HEADER = { name: "x-requested-with", value: "gustaf-admin" } as const;

export type ApiErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "bad-request"
  | "rate-limited"
  | "server"
  | "network";

export class ApiError extends Error {
  readonly status: number;
  readonly kind: ApiErrorKind;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = errorKindForStatus(status);
  }
}

export function errorKindForStatus(status: number): ApiErrorKind {
  switch (status) {
    case 0:
      return "network";
    case 400:
      return "bad-request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 429:
      return "rate-limited";
    default:
      return status >= 400 && status < 500 ? "bad-request" : "server";
  }
}

export function isApiError(error: unknown, kind?: ApiErrorKind): error is ApiError {
  return error instanceof ApiError && (kind === undefined || error.kind === kind);
}

export interface PageParams {
  readonly cursor?: string | null | undefined;
  readonly limit?: number | undefined;
}

type QueryValue = string | number | null | undefined;

export function buildUrl(
  baseUrl: string,
  path: string,
  params: Readonly<Record<string, QueryValue>> = {},
): string {
  const url = new URL(path.replace(/^\/+/, ""), baseUrl.replace(/\/*$/, "/"));
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function pageParams({ cursor, limit }: PageParams): Record<string, QueryValue> {
  return {
    limit:
      limit === undefined ? undefined : Math.min(Math.max(1, Math.trunc(limit)), MAX_PAGE_SIZE),
    cursor,
  };
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Proxies answer with HTML; the status text is the best we have.
  }
  return response.statusText || `HTTP ${response.status}`;
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

export function createApiClient({ baseUrl, fetch: fetchImpl }: ApiClientOptions) {
  const doFetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  async function request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { params?: Record<string, QueryValue>; body?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (method !== "GET") headers[MUTATION_HEADER.name] = MUTATION_HEADER.value;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await doFetch(buildUrl(baseUrl, path, options.params), {
        method,
        headers,
        credentials: "include",
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (cause) {
      throw new ApiError(0, cause instanceof Error ? cause.message : "Network error");
    }

    if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const user = (id: string) => `/v1/admin/users/${encodeURIComponent(id)}`;

  return {
    me: () => request<Me>("GET", "/v1/me"),
    signIn: (callbackURL: string) =>
      request<{ url: string }>("POST", "/v1/auth/sign-in/social", {
        body: { provider: "github", callbackURL },
      }),
    signOut: () => request<unknown>("POST", "/v1/auth/sign-out", { body: {} }),

    overview: () => request<Overview>("GET", "/v1/admin/overview"),

    listUsers: (params: PageParams & { query?: string | undefined }) =>
      request<Page<AdminUser>>("GET", "/v1/admin/users", {
        params: { query: params.query?.trim(), ...pageParams(params) },
      }),
    getUser: (id: string) => request<AdminUserDetail>("GET", user(id)),
    banUser: (id: string, reason: string) =>
      request<unknown>("POST", `${user(id)}/ban`, { body: { reason } }),
    unbanUser: (id: string) => request<unknown>("POST", `${user(id)}/unban`),
    revokeSessions: (id: string) => request<unknown>("POST", `${user(id)}/revoke-sessions`),
    changeRole: (id: string, role: Role) =>
      request<unknown>("PATCH", `${user(id)}/role`, { body: { role } }),
    deleteUser: (id: string) => request<unknown>("DELETE", user(id)),

    listDevices: (
      params: PageParams & { query?: string | undefined; kind?: DeviceKind | undefined },
    ) =>
      request<Page<AdminDevice>>("GET", "/v1/admin/devices", {
        params: { query: params.query?.trim(), kind: params.kind, ...pageParams(params) },
      }),
    revokeDevice: (id: string) =>
      request<unknown>("POST", `/v1/admin/devices/${encodeURIComponent(id)}/revoke`),

    listAudit: (params: PageParams) =>
      request<Page<AuditEntry>>("GET", "/v1/admin/audit", { params: pageParams(params) }),

    relay: () => request<RelayHealth>("GET", "/v1/admin/relay"),
    system: () => request<SystemStatus>("GET", "/v1/admin/system"),
    releases: () => request<ReleaseStats>("GET", "/v1/admin/releases"),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
