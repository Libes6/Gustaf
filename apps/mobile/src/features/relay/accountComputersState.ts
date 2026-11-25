import {
  type RelayComputer,
  type RelayComputersResult,
  pickableRelayComputers,
} from "@t3tools/client-runtime/gustaf-relay";

import type { AccountState } from "../account/accountStore";

export type AccountComputersLoad =
  | { readonly status: "loading" }
  | { readonly status: "done"; readonly result: RelayComputersResult };

/** What "My computers" shows: the first step the user still has to take, or the list. */
export type AccountComputersView =
  | { readonly kind: "signedOut" }
  | { readonly kind: "unregistered" }
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "empty" }
  | { readonly kind: "list"; readonly computers: ReadonlyArray<RelayComputer> };

/** Whether the phone can ask the relay anything: signed in, with this phone registered. */
export const canListAccountComputers = (account: Pick<AccountState, "status" | "phoneDeviceId">) =>
  account.status === "signedIn" && account.phoneDeviceId !== null;

export function accountComputersView(input: {
  readonly account: Pick<AccountState, "status" | "phoneDeviceId">;
  readonly load: AccountComputersLoad;
  /** Relay device ids of the computers this phone already reaches through the relay. */
  readonly connected: ReadonlySet<string>;
}): AccountComputersView {
  const { account, load } = input;
  if (account.status === "loading") return { kind: "loading" };
  if (account.status === "signedOut") return { kind: "signedOut" };
  if (account.phoneDeviceId === null) return { kind: "unregistered" };
  if (load.status === "loading") return { kind: "loading" };
  // The relay turned this phone's own credential down: it has to sign in or register again.
  if (load.result.problem === "signed_out") return { kind: "unregistered" };
  if (load.result.problem === "unavailable") return { kind: "unavailable" };
  const computers = pickableRelayComputers(load.result.computers, input.connected);
  return computers.length === 0 ? { kind: "empty" } : { kind: "list", computers };
}
