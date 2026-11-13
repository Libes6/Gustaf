import { relayHostFromUrl } from "@t3tools/shared/relayTunnelClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

import { relayTunnels } from "./relayPool";

/** Sockets to a virtual relay origin go through the tunnel; every other URL keeps `base`. */
export const layerRelayWebSocket = <E, R>(
  base: Layer.Layer<Socket.WebSocketConstructor, E, R>,
): Layer.Layer<Socket.WebSocketConstructor, E, R> =>
  Layer.effect(
    Socket.WebSocketConstructor,
    Effect.map(Socket.WebSocketConstructor, (construct) =>
      Socket.WebSocketConstructor.of((url, options) =>
        relayHostFromUrl(url) === null
          ? construct(url, options)
          : (relayTunnels.createWebSocket(
              url,
              typeof options === "string" || Array.isArray(options) ? options : undefined,
            ) as unknown as Socket.WebSocketLike),
      ),
    ),
  ).pipe(Layer.provide(base));

export const relayAwareFetch: typeof fetch = relayTunnels.wrapFetch((input, init) =>
  fetch(input, init),
);
