import { relayHostFromUrl, type RelayTunnelPool } from "@t3tools/shared/relayTunnelClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

/** Sockets to a virtual relay origin go through the tunnel; every other URL keeps `base`. */
export const layerRelayWebSocket = <E, R>(
  tunnels: RelayTunnelPool,
  base: Layer.Layer<Socket.WebSocketConstructor, E, R>,
): Layer.Layer<Socket.WebSocketConstructor, E, R> =>
  Layer.effect(
    Socket.WebSocketConstructor,
    Effect.map(Socket.WebSocketConstructor, (construct) =>
      Socket.WebSocketConstructor.of((url, options) =>
        relayHostFromUrl(url) === null
          ? construct(url, options)
          : (tunnels.createWebSocket(
              url,
              typeof options === "string" || Array.isArray(options) ? options : undefined,
            ) as unknown as Socket.WebSocketLike),
      ),
    ),
  ).pipe(Layer.provide(base));

/** The platform `fetch`, except that virtual relay URLs go through the tunnel. */
export const relayAwareFetch = (tunnels: RelayTunnelPool, base: typeof fetch): typeof fetch =>
  tunnels.wrapFetch(base);
