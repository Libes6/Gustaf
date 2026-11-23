import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

import { layerRelayWebSocket, relayAwareFetch } from "@t3tools/client-runtime/gustaf-relay";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as PrimaryEnvironmentHttpClient from "../environments/primary/httpClient";
import * as PrimaryEnvironmentHttpLayer from "../environments/primary/httpLayer";

import * as Dpop from "../cloud/dpop";
import * as ManagedRelayLayer from "../cloud/managedRelayLayer";
import {
  relayTelemetryEnabled,
  resolveCloudPublicConfig,
  resolveRelayTracingConfig,
} from "../cloud/publicConfig";
import * as ClientTracer from "../observability/clientTracer";
import { desktopRelay } from "../relay/desktopRelay";

function configuredRelayUrl(): string {
  return resolveCloudPublicConfig().relayUrl ?? "http://relay.invalid";
}

// In the desktop app, environments paired over the Gustaf relay live at a virtual origin the
// tunnel intercepts. File previews and media read their URLs with plain `fetch`, so the global one
// is wrapped too; it passes every other URL straight through.
if (desktopRelay) {
  globalThis.fetch = relayAwareFetch(desktopRelay.tunnels, globalThis.fetch.bind(globalThis));
}
const layerHttpClient = layerRemoteHttpClient((input, init) => globalThis.fetch(input, init));
const layerWebSocket = desktopRelay
  ? layerRelayWebSocket(desktopRelay.tunnels, Socket.layerWebSocketConstructorGlobal)
  : Socket.layerWebSocketConstructorGlobal;
const layerRelayTracing = RelayTracing.layer(
  resolveRelayTracingConfig(),
  {
    serviceName: "t3code-web",
    serviceVersion: import.meta.env.APP_VERSION,
    runtime: "browser",
    serviceInstanceId: ClientTracer.serviceInstanceId,
    client: typeof window !== "undefined" && window.desktopBridge ? "desktop" : "web",
  },
  { isEnabled: () => relayTelemetryEnabled() === true },
).pipe(Layer.provide(layerHttpClient));

type RuntimeLayerSource =
  | typeof layerHttpClient
  | typeof Dpop.layer
  | typeof layerWebSocket
  | typeof layerRelayTracing
  | typeof ClientTracer.layer
  | ReturnType<typeof ManagedRelayLayer.layer>;

const primaryHttpRuntime = ManagedRuntime.make(
  PrimaryEnvironmentHttpClient.layer.pipe(Layer.provide(PrimaryEnvironmentHttpLayer.layer)),
);

export type PrimaryHttpEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient.PrimaryEnvironmentHttpClient>,
) => Promise<A>;

const livePrimaryHttpRunner: PrimaryHttpEffectRunner = (effect) =>
  primaryHttpRuntime.runPromise(effect);

let primaryHttpRunner = livePrimaryHttpRunner;

export const runPrimaryHttp = <A, E>(
  effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient.PrimaryEnvironmentHttpClient>,
) => primaryHttpRunner(effect);

export function __setPrimaryHttpRunnerForTests(runner?: PrimaryHttpEffectRunner): void {
  primaryHttpRunner = runner ?? livePrimaryHttpRunner;
}

const layerRuntime = Layer.mergeAll(
  layerHttpClient,
  Dpop.layer,
  layerWebSocket,
  ClientTracer.layer,
  layerRelayTracing,
  ManagedRelayLayer.layer(configuredRelayUrl()).pipe(
    Layer.provide(Layer.mergeAll(layerHttpClient, Dpop.layer)),
  ),
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(layerRuntime);

export const layer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);
