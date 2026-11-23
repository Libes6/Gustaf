import * as Schema from "effect/Schema";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import { AccountApiError, type AccountDevice } from "./accountApi";
import type { AccountState } from "./accountStore";

const lastSeenFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function accountErrorMessage(
  error: string | null,
  resolve: MessageResolver = m,
): string | null {
  switch (error) {
    case null:
      return null;
    case "session_expired":
      return resolve(msg("Your session has ended. Sign in again."));
    case "state_mismatch":
    case "invalid_redirect":
    case "missing_code":
      return resolve(msg("Sign-in could not be verified. Try again."));
    case "access_denied":
      return resolve(msg("GitHub sign-in was cancelled."));
    default:
      return resolve(msg("Request failed: {error}", { error }));
  }
}

const isAccountApiError = Schema.is(AccountApiError);

export function reportErrorMessage(cause: unknown, resolve: MessageResolver = m): string {
  if (isAccountApiError(cause) && cause.status === 429) {
    return resolve(msg("Too many reports. Try again later."));
  }
  const reason = cause instanceof Error ? cause.message : String(cause);
  return accountErrorMessage(reason, resolve) ?? reason;
}

export interface AccountDeviceRow {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly icon: "desktopcomputer" | "iphone";
  readonly isThisPhone: boolean;
}

/** This phone first, then the rest in the server's order (oldest first). */
export function accountDeviceRows(
  devices: ReadonlyArray<AccountDevice>,
  phoneDeviceId: string | null,
  resolve: MessageResolver = m,
): AccountDeviceRow[] {
  const rows = devices.map((device) => {
    const isThisPhone = device.id === phoneDeviceId;
    return {
      id: device.id,
      name: device.name,
      detail: deviceDetailLabel(isThisPhone, device.kind, device.lastSeenAt, resolve),
      icon: device.kind === "phone" ? ("iphone" as const) : ("desktopcomputer" as const),
      isThisPhone,
    };
  });
  return [...rows.filter((row) => row.isThisPhone), ...rows.filter((row) => !row.isThisPhone)];
}

function deviceDetailLabel(
  isThisPhone: boolean,
  kind: AccountDevice["kind"],
  lastSeenAt: string | null,
  resolve: MessageResolver,
): string {
  const time = lastSeenAt === null ? Number.NaN : Date.parse(lastSeenAt);
  if (Number.isNaN(time)) {
    if (isThisPhone) return resolve(msg("This phone · Never seen"));
    return kind === "phone"
      ? resolve(msg("Phone · Never seen"))
      : resolve(msg("Computer · Never seen"));
  }
  const date = lastSeenFormatter.format(new Date(time));
  if (isThisPhone) return resolve(msg("This phone · Last seen {date}", { date }));
  return kind === "phone"
    ? resolve(msg("Phone · Last seen {date}", { date }))
    : resolve(msg("Computer · Last seen {date}", { date }));
}

export function canRegisterPhone(state: AccountState): boolean {
  return state.status === "signedIn" && state.devices !== null && state.phoneDeviceId === null;
}

/** The Settings row's value: who is signed in, or what tapping it does. */
export function accountRowValue(state: AccountState, resolve: MessageResolver = m): string {
  if (state.status === "loading") return resolve(msg("Checking"));
  if (state.status === "signedOut") return resolve(msg("Sign in"));
  return state.user?.email || state.user?.name || resolve(msg("Signed in"));
}
