import { BadRequestException } from "@nestjs/common";

export const ROLES = ["user", "admin"] as const;
export type Role = (typeof ROLES)[number];

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// Cursors are opaque to clients: base64url JSON of the last row's sort key.
export function encodeCursor(key: readonly (string | number)[]) {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

export function decodeCursor(cursor: string, length: number) {
  try {
    const key: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(key) &&
      key.length === length &&
      key.every((part) => typeof part === "string" || typeof part === "number")
    ) {
      return key as (string | number)[];
    }
  } catch {}
  throw new BadRequestException("cursor is invalid");
}

export function readPage(query: { limit?: unknown; cursor?: unknown }) {
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    limit =
      typeof query.limit === "string" && /^\d{1,3}$/.test(query.limit) ? Number(query.limit) : 0;
    if (limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequestException(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
  }
  if (query.cursor !== undefined && (typeof query.cursor !== "string" || query.cursor === "")) {
    throw new BadRequestException("cursor is invalid");
  }
  return { limit, cursor: query.cursor as string | undefined };
}

// Callers fetch `limit + 1` rows; the extra row only says whether another page exists.
export function toPage<Row, Item>(
  rows: Row[],
  limit: number,
  present: (row: Row) => Item,
  keyOf: (row: Row) => readonly (string | number)[],
) {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(present),
    nextCursor: rows.length > limit && last ? encodeCursor(keyOf(last)) : null,
  };
}

export function readSearch(value: unknown) {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 200) {
    throw new BadRequestException("query must be at most 200 characters");
  }
  const trimmed = value.trim();
  return trimmed ? `%${trimmed.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : undefined;
}

export function readRole(body: unknown): Role {
  const { role } = (body ?? {}) as Record<string, unknown>;
  if (!ROLES.includes(role as Role)) throw new BadRequestException("role must be user or admin");
  return role as Role;
}

export function readBanReason(body: unknown) {
  const { reason } = (body ?? {}) as Record<string, unknown>;
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== "string" || reason.length > 500) {
    throw new BadRequestException("reason must be a string of at most 500 characters");
  }
  return reason.trim() || null;
}

// An admin cannot lock themselves out: role changes, bans and deletion of the own account fail.
export function assertNotSelf(actorId: string, targetId: string) {
  if (actorId === targetId) {
    throw new BadRequestException("Admins cannot change, ban or delete their own account");
  }
}

interface MutationRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

export const ADMIN_REQUESTED_WITH = "gustaf-admin";

// CSRF defence for cookie sessions: mutations need the custom header (which forces a CORS
// preflight) and, when a browser sends an Origin, it must be an allowed admin origin. Requests
// without cookies (bearer clients such as curl) send no Origin and are not CSRF-able.
export function mutationRejection(request: MutationRequest, allowedOrigins: readonly string[]) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return undefined;
  if (request.headers["x-requested-with"] !== ADMIN_REQUESTED_WITH) {
    return `Admin mutations require the x-requested-with: ${ADMIN_REQUESTED_WITH} header`;
  }
  const origin = request.headers.origin;
  if (origin === undefined) {
    return request.headers.cookie === undefined ? undefined : "Origin header is required";
  }
  return typeof origin === "string" && allowedOrigins.includes(origin)
    ? undefined
    : "Origin is not allowed";
}
