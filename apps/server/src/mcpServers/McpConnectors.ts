import {
  type McpConnectorAuthorizeInput,
  type McpConnectorAuthorizeResult,
  McpConnectorError,
  type McpConnectorsListInput,
  type McpConnectorsListResult,
  type McpConnectorSubmitCallbackInput,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

/** MCP servers a provider loads by itself, such as claude.ai connectors, and signing in to them. */
export class McpConnectors extends Context.Service<
  McpConnectors,
  {
    readonly list: (
      input: McpConnectorsListInput,
    ) => Effect.Effect<McpConnectorsListResult, McpConnectorError>;
    readonly authorize: (
      input: McpConnectorAuthorizeInput,
    ) => Effect.Effect<McpConnectorAuthorizeResult, McpConnectorError>;
    readonly submitCallback: (
      input: McpConnectorSubmitCallbackInput,
    ) => Effect.Effect<void, McpConnectorError>;
  }
>()("t3/mcpServers/McpConnectors") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const connectorsOf = Effect.fn("McpConnectors.connectorsOf")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* registry.getInstance(instanceId);
    if (instance === undefined || !instance.enabled) {
      return yield* new McpConnectorError({
        detail: instance ? "This provider is turned off." : "Provider not found.",
      });
    }
    if (instance.mcpConnectors === undefined) {
      return yield* new McpConnectorError({
        detail: "This provider does not report its own MCP servers.",
      });
    }
    return instance.mcpConnectors;
  });
  const toConnectorError = Effect.mapError(
    (error: { readonly detail: string }) => new McpConnectorError({ detail: error.detail }),
  );

  return McpConnectors.of({
    list: Effect.fn("McpConnectors.list")(function* (input) {
      const connectors = yield* connectorsOf(input.instanceId);
      return { connectors: yield* connectors.list(input.projectDir).pipe(toConnectorError) };
    }),
    authorize: Effect.fn("McpConnectors.authorize")(function* (input) {
      const connectors = yield* connectorsOf(input.instanceId);
      return yield* connectors
        .authorize({ name: input.name, cwd: input.projectDir })
        .pipe(toConnectorError);
    }),
    submitCallback: Effect.fn("McpConnectors.submitCallback")(function* (input) {
      const connectors = yield* connectorsOf(input.instanceId);
      yield* connectors
        .submitCallback({ name: input.name, callbackUrl: input.callbackUrl })
        .pipe(toConnectorError);
    }),
  });
});

export const layer = Layer.effect(McpConnectors, make);
