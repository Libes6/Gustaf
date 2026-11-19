import type * as Layer from "effect/Layer";
import type * as Socket from "effect/socket/Socket";
import {
  layerRelayWebSocket as layerGustafRelayWebSocket,
  relayAwareFetch as gustafRelayAwareFetch,
} from "@t3tools/client-runtime/gustaf-relay";

import { relayTunnels } from "./relayPool";

export const layerRelayWebSocket = <E, R>(
  base: Layer.Layer<Socket.WebSocketConstructor, E, R>,
): Layer.Layer<Socket.WebSocketConstructor, E, R> => layerGustafRelayWebSocket(relayTunnels, base);

export const relayAwareFetch: typeof fetch = gustafRelayAwareFetch(relayTunnels, (input, init) =>
  fetch(input, init),
);
