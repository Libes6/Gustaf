import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  EnvironmentHttpApi,
  type EnvironmentInternalError,
  type EnvironmentRequestInvalidError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as RelayHost from "./RelayHost.ts";

const mapRelayHostError = (
  error: RelayHost.RelayHostError,
): Effect.Effect<never, EnvironmentRequestInvalidError | EnvironmentInternalError> => {
  switch (error.reason) {
    case "not_online":
      return failEnvironmentInvalidRequest("relay_not_online");
    case "not_found":
      return failEnvironmentInvalidRequest("relay_item_not_found");
    case "invalid_relay_url":
      return failEnvironmentInvalidRequest("relay_invalid_url");
    case "storage":
      return failEnvironmentInternal("relay_host_failed", error);
  }
};

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "relayHost",
  Effect.fnUntraced(function* (handlers) {
    const relayHost = yield* RelayHost.RelayHost;
    return handlers
      .handle(
        "status",
        Effect.fn("environment.relayHost.status")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthRelayReadScope);
          return yield* relayHost.status();
        }),
      )
      .handle(
        "setCredential",
        Effect.fn("environment.relayHost.setCredential")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          return yield* relayHost.setCredential(args.payload).pipe(Effect.catch(mapRelayHostError));
        }),
      )
      .handle(
        "clearCredential",
        Effect.fn("environment.relayHost.clearCredential")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          return yield* relayHost
            .clearCredential()
            .pipe(Effect.catch((error) => failEnvironmentInternal("relay_host_failed", error)));
        }),
      )
      .handle(
        "createOffer",
        Effect.fn("environment.relayHost.createOffer")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          return yield* relayHost.createOffer().pipe(Effect.catch(mapRelayHostError));
        }),
      )
      .handle(
        "decide",
        Effect.fn("environment.relayHost.decide")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          return yield* relayHost.decide(args.payload).pipe(Effect.catch(mapRelayHostError));
        }),
      )
      .handle(
        "revokeDevice",
        Effect.fn("environment.relayHost.revokeDevice")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          return yield* relayHost.revokeDevice(args.payload).pipe(Effect.catch(mapRelayHostError));
        }),
      );
  }),
);
