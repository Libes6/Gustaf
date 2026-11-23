import { isApiError } from "../api/client";
import type { AdminUser, Me, Role } from "../api/types";

export type Gate =
  | { readonly state: "loading" }
  | { readonly state: "signed-out" }
  | { readonly state: "no-access"; readonly me: Me | null }
  | { readonly state: "error"; readonly error: unknown }
  | { readonly state: "admin"; readonly me: Me };

/** What the app shows for the current `/v1/me` query state. */
export function resolveGate(query: {
  readonly status: "pending" | "error" | "success";
  readonly data: Me | undefined;
  readonly error: unknown;
}): Gate {
  if (query.status === "pending") return { state: "loading" };
  if (query.status === "error") {
    if (isApiError(query.error, "unauthorized")) return { state: "signed-out" };
    if (isApiError(query.error, "forbidden")) return { state: "no-access", me: null };
    return { state: "error", error: query.error };
  }
  const me = query.data;
  if (!me) return { state: "signed-out" };
  return me.role === "admin" ? { state: "admin", me } : { state: "no-access", me };
}

export function otherRole(role: Role): Role {
  return role === "admin" ? "user" : "admin";
}

export type UserAction = "ban" | "unban" | "revoke-sessions" | "change-role" | "delete";

/** The actions offered for a user. An admin never acts on their own row: it could lock them out. */
export function availableUserActions(
  meId: string,
  user: Pick<AdminUser, "id" | "banned">,
): ReadonlyArray<{ readonly action: UserAction; readonly enabled: boolean }> {
  const enabled = user.id !== meId;
  return [
    { action: user.banned ? "unban" : "ban", enabled },
    { action: "revoke-sessions", enabled },
    { action: "change-role", enabled },
    { action: "delete", enabled },
  ];
}

/** Ban reasons are recorded in the audit log; require something meaningful. */
export function normalizeBanReason(reason: string): string | null {
  const trimmed = reason.trim();
  return trimmed.length >= 3 && trimmed.length <= 500 ? trimmed : null;
}
