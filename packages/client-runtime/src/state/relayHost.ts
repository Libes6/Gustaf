import type {
  RelayHostDecisionInput,
  RelayHostRevokeInput,
  RelayHostTrustInput,
} from "@t3tools/contracts";
import type { HttpClient } from "effect/http";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { executeConnectedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand } from "./runtime.ts";

const RELAY_HOST_REQUEST_TIMEOUT_MS = 8_000;

/** This computer's end of the Gustaf relay: status, the pairing QR code, approvals, trust, revocation. */
export function createRelayHostAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    status: createEnvironmentCommand(runtime, {
      label: "environment-data:server:relay-host-status",
      execute: (_input: null) =>
        executeConnectedEnvironmentHttpRequest({
          group: "relayHost",
          method: "GET",
          url: (urls) => urls.status(),
          timeoutMs: RELAY_HOST_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.status({ headers }),
        }),
    }),
    createOffer: createEnvironmentCommand(runtime, {
      label: "environment-data:server:relay-host-create-offer",
      execute: (_input: null) =>
        executeConnectedEnvironmentHttpRequest({
          group: "relayHost",
          method: "POST",
          url: (urls) => urls.createOffer(),
          timeoutMs: RELAY_HOST_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.createOffer({ headers }),
        }),
    }),
    decide: createEnvironmentCommand(runtime, {
      label: "environment-data:server:relay-host-decide",
      execute: (input: RelayHostDecisionInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "relayHost",
          method: "POST",
          url: (urls) => urls.decide(),
          timeoutMs: RELAY_HOST_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.decide({ headers, payload: input }),
        }),
    }),
    setTrust: createEnvironmentCommand(runtime, {
      label: "environment-data:server:relay-host-set-trust",
      execute: (input: RelayHostTrustInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "relayHost",
          method: "PUT",
          url: (urls) => urls.setTrust(),
          timeoutMs: RELAY_HOST_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.setTrust({ headers, payload: input }),
        }),
    }),
    revokeDevice: createEnvironmentCommand(runtime, {
      label: "environment-data:server:relay-host-revoke-device",
      execute: (input: RelayHostRevokeInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "relayHost",
          method: "POST",
          url: (urls) => urls.revokeDevice(),
          timeoutMs: RELAY_HOST_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.revokeDevice({ headers, payload: input }),
        }),
    }),
  };
}
