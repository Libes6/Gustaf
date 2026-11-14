// @effect-diagnostics nodeBuiltinImport:off -- A Unix socket client for the shell's executor.
/**
 * The Gustaf shell's computer-use executor, reached over the socket the shell started this server
 * with (apps/shell/src-tauri/src/computer_use/channel.rs). One JSON line per request and reply.
 */
import {
  ComputerUseError,
  ComputerUseExecutorEvent as ExecutorEventLine,
  ComputerUseExecutorReply,
  type ComputerUseExecutorRequest,
  type ComputerUseStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as NodeNet from "node:net";

import { type ComputerUseEndpoint, takeComputerUseEndpoint } from "./executorEndpoint.ts";

export type ComputerUseExecutorEvent =
  | { readonly _tag: "Status"; readonly status: ComputerUseStatus }
  /** The session connection closed, which ends any session it started. */
  | { readonly _tag: "Disconnected" };

export class ComputerUseExecutor extends Context.Service<
  ComputerUseExecutor,
  {
    readonly available: boolean;
    /**
     * Session requests (`start`, owner `stop`, `screenshot`, `act`, ...) share one long-lived
     * connection: the shell ends a session when the connection that started it closes.
     */
    readonly session: (
      request: ComputerUseExecutorRequest,
    ) => Effect.Effect<unknown, ComputerUseError>;
    /**
     * Everything else gets its own connection, so a dialog waiting for the person at the Mac or a
     * step in flight never delays it. The user's Stop goes this way.
     */
    readonly oneShot: (
      request: ComputerUseExecutorRequest,
    ) => Effect.Effect<unknown, ComputerUseError>;
    /** Subscribe before forking the reader, so no event is lost meanwhile. */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<ComputerUseExecutorEvent>,
      never,
      Scope.Scope
    >;
  }
>()("t3/computerUse/ComputerUseExecutor") {}

const unreachable = () =>
  new ComputerUseError({
    code: "failed",
    message: "Gustaf's computer-use executor is not reachable. Restart Gustaf on the Mac.",
  });

const decodeReply = Schema.decodeUnknownOption(ComputerUseExecutorReply);
const decodeEvent = Schema.decodeUnknownOption(ExecutorEventLine);
const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

interface Connection {
  readonly socket: NodeNet.Socket;
  readonly pending: Map<number, (reply: ComputerUseExecutorReply | undefined) => void>;
}

export const makeSocket = Effect.fn("ComputerUseExecutor.makeSocket")(function* (
  endpoint: ComputerUseEndpoint,
) {
  const events = yield* PubSub.unbounded<ComputerUseExecutorEvent>();
  const opening = yield* Semaphore.make(1);
  let nextId = 1;
  let sessionConnection: Connection | undefined;

  const open = (onEvent: ((status: ComputerUseStatus) => void) | undefined, onClose: () => void) =>
    Effect.callback<Connection, ComputerUseError>((resume) => {
      const socket = NodeNet.createConnection(endpoint.socketPath);
      const connection: Connection = { socket, pending: new Map() };
      let buffered = "";
      let connected = false;
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        connected = true;
        resume(Effect.succeed(connection));
      });
      socket.on("data", (chunk: string) => {
        buffered += chunk;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          const event = decodeEvent(value);
          if (event._tag === "Some") {
            onEvent?.(event.value.status);
            continue;
          }
          const reply = decodeReply(value);
          if (reply._tag === "Some" && typeof reply.value.id === "number") {
            connection.pending.get(reply.value.id)?.(reply.value);
          }
        }
      });
      // A failure always closes the socket too; the close handler settles what is waiting.
      socket.on("error", () => {});
      socket.once("close", () => {
        for (const settle of connection.pending.values()) settle(undefined);
        connection.pending.clear();
        if (!connected) resume(Effect.fail(unreachable()));
        else onClose();
      });
      return Effect.sync(() => socket.destroy());
    });

  const send = (connection: Connection, request: ComputerUseExecutorRequest) =>
    Effect.suspend(() => {
      const id = nextId++;
      return encodeLine({ id, token: endpoint.token, ...request }).pipe(
        Effect.mapError(
          () => new ComputerUseError({ code: "invalid-request", message: "Unencodable request." }),
        ),
        Effect.flatMap((line) =>
          Effect.callback<unknown, ComputerUseError>((resume) => {
            connection.pending.set(id, (reply) => {
              connection.pending.delete(id);
              if (reply === undefined) resume(Effect.fail(unreachable()));
              else if (reply.ok) resume(Effect.succeed(reply.result));
              else resume(Effect.fail(new ComputerUseError(reply.error)));
            });
            connection.socket.write(`${line}\n`);
            return Effect.sync(() => connection.pending.delete(id));
          }),
        ),
      );
    });

  const sessionConnectionOpen = opening.withPermits(1)(
    Effect.suspend(() => {
      if (sessionConnection !== undefined && !sessionConnection.socket.destroyed) {
        return Effect.succeed(sessionConnection);
      }
      return open(
        (status) => PubSub.publishUnsafe(events, { _tag: "Status", status }),
        () => {
          sessionConnection = undefined;
          PubSub.publishUnsafe(events, { _tag: "Disconnected" });
        },
      ).pipe(Effect.tap((connection) => Effect.sync(() => (sessionConnection = connection))));
    }),
  );

  yield* Effect.addFinalizer(() => Effect.sync(() => sessionConnection?.socket.destroy()));

  return ComputerUseExecutor.of({
    available: true,
    session: Effect.fn("ComputerUseExecutor.session")(function* (request) {
      const connection = yield* sessionConnectionOpen;
      return yield* send(connection, request);
    }),
    oneShot: Effect.fn("ComputerUseExecutor.oneShot")(function* (request) {
      return yield* Effect.acquireUseRelease(
        open(undefined, () => {}),
        (connection) => send(connection, request),
        (connection) => Effect.sync(() => connection.socket.destroy()),
      );
    }),
    subscribe: PubSub.subscribe(events),
  });
});

const unavailable = ComputerUseExecutor.of({
  available: false,
  session: Effect.fn("ComputerUseExecutor.session")(function* () {
    return yield* unavailableError();
  }),
  oneShot: Effect.fn("ComputerUseExecutor.oneShot")(function* () {
    return yield* unavailableError();
  }),
  subscribe: Effect.flatMap(PubSub.unbounded<ComputerUseExecutorEvent>(), PubSub.subscribe),
});

export function unavailableError() {
  return new ComputerUseError({
    code: "unsupported",
    message:
      "Computer use is not available in this environment. It needs the Gustaf app on a Mac, running this environment itself.",
  });
}

/** The executor the shell started this server with, or none, as on a VPS or another OS. */
export const layer = Layer.effect(
  ComputerUseExecutor,
  Effect.suspend(() => {
    const endpoint = takeComputerUseEndpoint();
    return endpoint === undefined ? Effect.succeed(unavailable) : makeSocket(endpoint);
  }),
);
