import { t } from "../../i18n";
import type { AccountDevice } from "./accountApi";
import type { AccountState } from "./accountStore";

const lastSeenFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function accountErrorMessage(error: string | null): string | null {
  switch (error) {
    case null:
      return null;
    case "session_expired":
      return t("Your session has ended. Sign in again.");
    case "state_mismatch":
    case "invalid_redirect":
    case "missing_code":
      return t("Sign-in could not be verified. Try again.");
    case "access_denied":
      return t("GitHub sign-in was cancelled.");
    default:
      return `${t("Request failed")}: ${error}`;
  }
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
): AccountDeviceRow[] {
  const rows = devices.map((device) => {
    const isThisPhone = device.id === phoneDeviceId;
    const kind = isThisPhone
      ? t("This phone")
      : device.kind === "phone"
        ? t("Phone")
        : t("Computer");
    return {
      id: device.id,
      name: device.name,
      detail: `${kind} · ${lastSeenLabel(device.lastSeenAt)}`,
      icon: device.kind === "phone" ? ("iphone" as const) : ("desktopcomputer" as const),
      isThisPhone,
    };
  });
  return [...rows.filter((row) => row.isThisPhone), ...rows.filter((row) => !row.isThisPhone)];
}

function lastSeenLabel(lastSeenAt: string | null): string {
  const time = lastSeenAt === null ? Number.NaN : Date.parse(lastSeenAt);
  return Number.isNaN(time)
    ? t("Never seen")
    : `${t("Last seen")} ${lastSeenFormatter.format(new Date(time))}`;
}

export function canRegisterPhone(state: AccountState): boolean {
  return state.status === "signedIn" && state.devices !== null && state.phoneDeviceId === null;
}

/** The Settings row's value: who is signed in, or what tapping it does. */
export function accountRowValue(state: AccountState): string {
  if (state.status === "loading") return t("Checking");
  if (state.status === "signedOut") return t("Sign in");
  return state.user?.email || state.user?.name || t("Signed in");
}
