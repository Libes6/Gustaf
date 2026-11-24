// @effect-diagnostics nodeBuiltinImport:off - Reads the desktop's computer-use fd as a socket.
/**
 * The desktop app's computer-use executor, reached over the fd pair it gives its primary backend
 * (`desktopComputerUseFd` in, `desktopComputerUseControlFd` out). One JSON line per request, reply
 * and event (`ComputerUseExecutorRequest` in contracts). Agents never inherit these fds, so no
 * token guards the channel; the service checks every agent action before it is sent.
 */
import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  ComputerUseError,
  ComputerUseExecutorEvent as ExecutorEventLine,
  ComputerUseExecutorReply,
  ComputerUseExecutorRequest,
  type ComputerUseStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import * as NodeNet from "node:net";

import * as ServerConfig from "../config.ts";
import { writeAllToFileDescriptor } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

export type ComputerUseExecutorEvent =
  | { readonly _tag: "Status"; readonly status: ComputerUseStatus }
  /** The desktop closed the channel, which ends any session this server started. */
  | { readonly _tag: "Disconnected" };

export class ComputerUseExecutor extends Context.Service<
  ComputerUseExecutor,
  {
    readonly available: boolean;
    /**
     * Requests share one channel and run concurrently: the desktop answers `stop` and `status`
     * at once, never behind a step in flight or a dialog waiting for the person at the Mac.
     */
    readonly request: (
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

const unavailableError = () =>
  new ComputerUseError({
    code: "unsupported",
    message:
      "Computer use is not available in this environment. It needs the Gustaf app on a Mac, running this environment itself.",
  });

const unreachable = () =>
  new ComputerUseError({
    code: "failed",
    message: "Gustaf's computer-use executor is not reachable. Restart Gustaf on the Mac.",
  });

const malformedReply = () =>
  new ComputerUseError({ code: "failed", message: "Gustaf's executor sent an unexpected reply." });

const encodeRequest = Schema.encodeEffect(ComputerUseExecutorRequest);
const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownOption(ExecutorEventLine);
const decodeReply = Schema.decodeUnknownOption(ComputerUseExecutorReply);
const decodeReplyId = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Number }));

/**
 * The channel over any line transport: `input` is what the desktop writes, `write` sends one
 * line. Ends, with every waiting request failed, when `input` ends or fails.
 */
export const makeChannel = Effect.fn("ComputerUseExecutor.makeChannel")(function* <E>(
  input: Stream.Stream<Uint8Array, E>,
  write: (line: string) => Effect.Effect<void, unknown>,
) {
  const events = yield* PubSub.unbounded<ComputerUseExecutorEvent>();
  const writeLock = yield* Semaphore.make(1);
  const pending = new Map<number, Deferred.Deferred<unknown, ComputerUseError>>();
  let nextId = 1;
  let closed = false;

  // Untraced: it runs once per line, under the reader's own fiber.
  const receive = Effect.fnUntraced(function* (value: unknown) {
    const event = decodeEvent(value);
    if (Option.isSome(event)) {
      return yield* PubSub.publish(events, { _tag: "Status", status: event.value.status });
    }
    const reply = decodeReply(value);
    if (Option.isSome(reply)) {
      const { id } = reply.value;
      if (id === null) {
        // Not about any request, such as a line the desktop could not parse.
        return yield* Effect.logWarning("computer use executor refused a line", {
          code: reply.value.ok ? undefined : reply.value.error.code,
        });
      }
      const waiting = pending.get(id);
      if (waiting === undefined) return;
      return yield* reply.value.ok
        ? Deferred.succeed(waiting, reply.value.result)
        : Deferred.fail(waiting, new ComputerUseError(reply.value.error));
    }
    // A reply this server cannot read still answers its request, which must not wait forever.
    const id = decodeReplyId(value);
    const waiting = Option.isSome(id) ? pending.get(id.value.id) : undefined;
    if (waiting !== undefined) yield* Deferred.fail(waiting, malformedReply());
    yield* Effect.logWarning("computer use executor sent an unexpected line");
  });

  yield* input.pipe(
    Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
    Stream.runForEach(receive),
    Effect.catchCause((cause) => Effect.logWarning("computer use channel failed", { cause })),
    Effect.ensuring(
      Effect.gen(function* () {
        closed = true;
        for (const waiting of pending.values()) yield* Deferred.fail(waiting, unreachable());
        pending.clear();
        yield* PubSub.publish(events, { _tag: "Disconnected" });
      }),
    ),
    Effect.forkScoped,
  );

  const request = Effect.fn("ComputerUseExecutor.request")(function* (
    message: ComputerUseExecutorRequest,
  ) {
    yield* Effect.annotateCurrentSpan({ "computerUse.op": message.op });
    if (closed) return yield* unreachable();
    const id = nextId++;
    const reply = yield* Deferred.make<unknown, ComputerUseError>();
    pending.set(id, reply);
    return yield* Effect.gen(function* () {
      const encoded = yield* encodeRequest(message).pipe(
        Effect.flatMap((fields) => encodeLine({ id, ...fields })),
        Effect.mapError(
          () => new ComputerUseError({ code: "invalid-request", message: "Unencodable request." }),
        ),
      );
      yield* writeLock
        .withPermits(1)(write(`${encoded}\n`))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("computer use request not sent", { cause }).pipe(
              Effect.andThen(Effect.fail(unreachable())),
            ),
          ),
        );
      return yield* Deferred.await(reply);
    }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))));
  });

  return ComputerUseExecutor.of({
    available: true,
    request,
    subscribe: PubSub.subscribe(events),
  });
});

const unavailable = ComputerUseExecutor.of({
  available: false,
  request: Effect.fn("ComputerUseExecutor.request")(function* () {
    return yield* unavailableError();
  }),
  subscribe: Effect.flatMap(PubSub.unbounded<ComputerUseExecutorEvent>(), PubSub.subscribe),
});

/** The desktop's executor, or none: not macOS, an extra backend, the CLI, a VPS, WSL. */
export const layer = Layer.effect(
  ComputerUseExecutor,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const inputFd = config.desktopComputerUseFd;
    const controlFd = config.desktopComputerUseControlFd;
    if (inputFd === undefined || controlFd === undefined) return unavailable;
    // A socket read is cancellable; a filesystem pipe read keeps Node alive after shutdown.
    const readable = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeNet.Socket({ fd: inputFd, readable: true, writable: false })),
      (stream) => Effect.sync(() => stream.destroy()),
    );
    return yield* makeChannel(
      NodeStream.fromReadable<Uint8Array, Error>({
        evaluate: () => readable,
        closeOnDone: true,
        onError: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
      (line) => writeAllToFileDescriptor(controlFd, Buffer.from(line)),
    );
  }),
);
