import {
  type RelayComputersLoad,
  type RelayComputersView,
  relayComputersView,
} from "@t3tools/client-runtime/gustaf-relay";

import type { AccountState } from "../account/accountStore";

export type AccountComputersLoad = RelayComputersLoad;

/** What "My computers" shows: the first step the user still has to take, or the list. */
export type AccountComputersView =
  | { readonly kind: "signedOut" }
  | { readonly kind: "unregistered" }
  | Exclude<RelayComputersView, { readonly kind: "signedOut" }>;

/** Whether the phone can ask the relay anything: signed in, with this phone registered. */
export const canListAccountComputers = (account: Pick<AccountState, "status" | "phoneDeviceId">) =>
  account.status === "signedIn" && account.phoneDeviceId !== null;

export function accountComputersView(input: {
  readonly account: Pick<AccountState, "status" | "phoneDeviceId">;
  readonly load: AccountComputersLoad;
  /** Relay device ids of the computers this phone already reaches through the relay. */
  readonly connected: ReadonlySet<string>;
}): AccountComputersView {
  const { account } = input;
  if (account.status === "loading") return { kind: "loading" };
  if (account.status === "signedOut") return { kind: "signedOut" };
  if (account.phoneDeviceId === null) return { kind: "unregistered" };
  const view = relayComputersView(input.load, input.connected);
  // The relay turned this phone's own credential down: it has to register again.
  return view.kind === "signedOut" ? { kind: "unregistered" } : view;
}
