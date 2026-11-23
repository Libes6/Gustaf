import type { ShellAccountDevice, ShellAccountState, ShellAccountUser } from "../../shellAccount";

export type AccountView =
  | { readonly kind: "loading" }
  | { readonly kind: "signedOut"; readonly expired: boolean }
  | {
      readonly kind: "signedIn";
      readonly user: ShellAccountUser;
      /** Name, else email; null when the account has neither. */
      readonly displayName: string | null;
      /** Email under the name, when the name is the headline. */
      readonly secondary: string | null;
      readonly initials: string;
    };

const blankToNull = (value: string | null) => (value?.trim() ? value.trim() : null);

/** A session past its expiry cannot call the cloud, so it reads as signed out. */
export function accountView(state: ShellAccountState | null, nowMs: number): AccountView {
  if (state === null) return { kind: "loading" };
  if (!state.signedIn || state.user === null) return { kind: "signedOut", expired: false };
  const expiresAt = state.expiresAt === null ? Number.NaN : Date.parse(state.expiresAt);
  if (!Number.isNaN(expiresAt) && expiresAt <= nowMs) return { kind: "signedOut", expired: true };
  const name = blankToNull(state.user.name);
  const email = blankToNull(state.user.email);
  const displayName = name ?? email;
  return {
    kind: "signedIn",
    user: state.user,
    displayName,
    secondary: name !== null ? email : null,
    initials: (displayName ?? "?")
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join(""),
  };
}

/** This computer first, then the order the cloud registered them in. */
export function orderDevices(devices: readonly ShellAccountDevice[]): ShellAccountDevice[] {
  return devices.toSorted((left, right) => Number(right.current) - Number(left.current));
}

export function isThisComputerRegistered(devices: readonly ShellAccountDevice[]): boolean {
  return devices.some((device) => device.current);
}
