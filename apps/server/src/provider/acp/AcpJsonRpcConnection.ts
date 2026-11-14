import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";

export const ACP_KEEP_ALIVE_INTERVAL_MS = 15_000;
export const ACP_PING_METHOD = "$/ping";

export interface AcpKeepAliveTarget {
  readonly request: (method: string, payload: unknown) => Effect.Effect<unknown, unknown>;
}

export interface AcpKeepAliveOptions {
  readonly runtime: AcpKeepAliveTarget;
  readonly intervalMs?: number;
  readonly pingMethod?: string;
}

export const startAcpKeepAlive = (
  options: AcpKeepAliveOptions,
): Effect.Effect<Fiber.Fiber<void, never>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const intervalMs = options.intervalMs ?? ACP_KEEP_ALIVE_INTERVAL_MS;
    const method = options.pingMethod ?? ACP_PING_METHOD;

    const pingEffect = options.runtime.request(method, {}).pipe(
      Effect.catch((error) =>
        Effect.logDebug("ACP keep-alive ping suppressed").pipe(
          Effect.annotateLogs({ method, error: String(error) }),
        ),
      ),
      Effect.asVoid,
    );

    const loop = Effect.repeat(
      pingEffect,
      Schedule.spaced(Duration.millis(intervalMs)),
    ).pipe(Effect.asVoid);

    return yield* Effect.forkScoped(loop);
  });

export const withAcpKeepAlive = <A, E, R>(
  runtime: AcpKeepAliveTarget,
  effect: Effect.Effect<A, E, R>,
  options?: { readonly intervalMs?: number; readonly pingMethod?: string },
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* startAcpKeepAlive({ runtime, ...options });
      return yield* effect;
    }),
  );
