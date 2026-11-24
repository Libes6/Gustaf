/**
 * Computer use on the Mac this environment runs on: which thread may drive it, and every agent
 * action, checked here before it reaches the desktop app's executor.
 */
import {
  type ComputerUseAction,
  type ComputerUseCaptureGeometry,
  type ComputerUseContext,
  type ComputerUseDisplay,
  ComputerUseCaptureGeometry as CaptureGeometrySchema,
  ComputerUseContext as ContextSchema,
  ComputerUseDisplay as DisplaySchema,
  ComputerUseError,
  type ComputerUsePermission,
  ComputerUseStatus,
  COMPUTER_USE_UNSUPPORTED_STATUS,
  computerUseSupportsDriver,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ComputerUseExecutor from "./ComputerUseExecutor.ts";

/** The agent calling a tool: its thread and the provider instance running it. */
export interface ComputerUseCaller {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface ComputerUseScreenshot {
  readonly geometry: ComputerUseCaptureGeometry;
  readonly png: string;
  readonly displays: ReadonlyArray<ComputerUseDisplay>;
  readonly context: ComputerUseContext;
}

export const MAX_WAIT_SECONDS = 10;

export class ComputerUseService extends Context.Service<
  ComputerUseService,
  {
    /** Whether the desktop gave this server its executor; fixed for the server's life. */
    readonly available: boolean;
    /** Asks the desktop again, so a permission granted in System Settings shows up. */
    readonly status: Effect.Effect<ComputerUseStatus>;
    readonly statusChanges: Stream.Stream<ComputerUseStatus>;
    readonly setEnabled: (enabled: boolean) => Effect.Effect<ComputerUseStatus, ComputerUseError>;
    readonly openPermissionSettings: (
      permission: ComputerUsePermission,
    ) => Effect.Effect<void, ComputerUseError>;
    /** Starts the executor session for this thread; only one thread on the Mac holds it. */
    readonly allowThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ComputerUseStatus, ComputerUseError>;
    /** The user's Stop: ends whichever session runs, at once, from any client. */
    readonly stop: Effect.Effect<ComputerUseStatus, ComputerUseError>;
    readonly screenshot: (
      caller: ComputerUseCaller,
      input: { readonly displayId?: number | undefined },
    ) => Effect.Effect<ComputerUseScreenshot, ComputerUseError>;
    readonly act: (
      caller: ComputerUseCaller,
      action: ComputerUseAction,
    ) => Effect.Effect<void, ComputerUseError>;
    readonly wait: (
      caller: ComputerUseCaller,
      seconds: number,
    ) => Effect.Effect<void, ComputerUseError>;
    /** The agent gives control back; the user must allow the thread again. */
    readonly release: (caller: ComputerUseCaller) => Effect.Effect<void, ComputerUseError>;
  }
>()("t3/computerUse/ComputerUseService") {}

interface Grant {
  readonly threadId: ThreadId;
  readonly sessionToken: string;
}

const decodeStatus = Schema.decodeUnknownEffect(ComputerUseStatus);
const decodeGeometry = Schema.decodeUnknownEffect(CaptureGeometrySchema);
const decodeDisplays = Schema.decodeUnknownEffect(Schema.Array(DisplaySchema));
const decodeContext = Schema.decodeUnknownEffect(ContextSchema);
const decodeSessionToken = Schema.decodeUnknownEffect(
  Schema.Struct({ sessionToken: Schema.String }),
);
const decodePng = Schema.decodeUnknownEffect(Schema.Struct({ data: Schema.String }));

const malformed = () =>
  new ComputerUseError({ code: "failed", message: "Gustaf's executor sent an unexpected reply." });

/** Run statuses that mean the user stopped the thread's work. */
const STOPPED_RUN: ReadonlySet<string> = new Set(["interrupted", "cancelled"]);

/** Executor errors that mean the session is gone, so the thread's permission is too. */
const SESSION_ENDED: ReadonlySet<string> = new Set([
  "no-session",
  "cancelled",
  "permission-required",
]);

export const make = Effect.gen(function* () {
  const executor = yield* ComputerUseExecutor.ComputerUseExecutor;
  const environmentId: EnvironmentId = yield* (yield* ServerEnvironment.ServerEnvironment)
    .getEnvironmentId;
  const engine = yield* Orchestrator.OrchestratorV2;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const statusRef = yield* SubscriptionRef.make<ComputerUseStatus>(COMPUTER_USE_UNSUPPORTED_STATUS);
  // Grant changes run one at a time, so a stop for one thread never ends another's new session.
  const grants = yield* Semaphore.make(1);
  let grant: Grant | undefined;

  const publish = (status: ComputerUseStatus) => SubscriptionRef.set(statusRef, status);
  const dropGrant = (held: Grant) =>
    Effect.sync(() => {
      if (grant === held) grant = undefined;
    });

  const status = executor.available
    ? executor.request({ op: "status" }).pipe(
        Effect.flatMap((value) => decodeStatus(value).pipe(Effect.mapError(malformed))),
        Effect.tap(publish),
        Effect.catch((error) =>
          Effect.logWarning("computer use status unavailable", { code: error.code }).pipe(
            Effect.andThen(SubscriptionRef.get(statusRef)),
          ),
        ),
      )
    : Effect.succeed(COMPUTER_USE_UNSUPPORTED_STATUS);

  const owns = (value: ComputerUseStatus, held: Grant) =>
    value.owner?.environmentId === environmentId && value.owner.threadId === held.threadId;

  /** The desktop ended the session on its own: the menu bar, the emergency shortcut, a permission. */
  const reconcile = (event: ComputerUseExecutor.ComputerUseExecutorEvent) =>
    grants.withPermits(1)(
      Effect.gen(function* () {
        if (event._tag === "Disconnected") {
          const held = grant;
          grant = undefined;
          return yield* publish({
            ...COMPUTER_USE_UNSUPPORTED_STATUS,
            ...(held === undefined ? {} : { lastEndReason: "connection-lost" as const }),
          });
        }
        const held = grant;
        if (held === undefined || owns(event.status, held)) return yield* publish(event.status);
        // A pushed status can be older than a session started after it; ask once more.
        const fresh = yield* status;
        if (!owns(fresh, held)) yield* dropGrant(held);
      }),
    );

  const ended = (error: ComputerUseError, held: Grant) =>
    SESSION_ENDED.has(error.code)
      ? grants
          .withPermits(1)(dropGrant(held))
          .pipe(Effect.andThen(status), Effect.andThen(Effect.fail(error)))
      : Effect.fail(error);

  const requireGrant = Effect.fn("ComputerUseService.requireGrant")(function* (
    caller: ComputerUseCaller,
  ) {
    if (!executor.available) return yield* ComputerUseExecutor.unavailableError();
    const instance = yield* providers.getInstance(caller.providerInstanceId);
    if (instance === undefined || !computerUseSupportsDriver(instance.driverKind)) {
      return yield* new ComputerUseError({
        code: "provider-unsupported",
        message: `Computer use is not supported for this provider (${instance?.driverKind ?? "unknown"}): it does not show tool screenshots to the model, and driving a screen without seeing it is unsafe. Tell the user to switch this thread to Claude, Codex, OpenCode or Pi.`,
      });
    }
    // Behind any stop in progress: once Stop starts, no later action reaches the Mac.
    const held = yield* grants.withPermits(1)(Effect.sync(() => grant));
    if (held === undefined || held.threadId !== caller.threadId) {
      return yield* new ComputerUseError({
        code: "not-allowed",
        message:
          "The user has not allowed computer use in this thread, or stopped it. Ask them to turn on Control Mac for this thread, then try again. Do not try to reach the screen another way.",
      });
    }
    return held;
  });

  const inSession = <A>(
    caller: ComputerUseCaller,
    run: (held: Grant) => Effect.Effect<A, ComputerUseError>,
  ) =>
    requireGrant(caller).pipe(
      Effect.flatMap((held) => run(held).pipe(Effect.catch((error) => ended(error, held)))),
    );

  /** Ends the session if `threadId` holds it, such as when the thread stops or is archived. */
  const endThread = Effect.fn("ComputerUseService.endThread")(function* (threadId: ThreadId) {
    yield* grants.withPermits(1)(
      Effect.gen(function* () {
        const held = grant;
        if (held?.threadId !== threadId) return;
        // Tokenless, so the desktop cuts a step in flight short instead of queueing behind it.
        yield* executor
          .request({ op: "stop" })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("computer use stop failed", { code: error.code }),
            ),
          );
        yield* dropGrant(held);
      }),
    );
    yield* status;
  });

  if (executor.available) {
    yield* Stream.fromSubscription(yield* executor.subscribe).pipe(
      Stream.runForEach(reconcile),
      forkParked,
    );
    yield* engine.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          grant?.threadId === event.threadId &&
          (event.type === "thread.archived" ||
            event.type === "thread.deleted" ||
            (event.type === "run.updated" && STOPPED_RUN.has(event.payload.status))),
      ),
      Stream.runForEach((event) => endThread(event.threadId)),
      Effect.catch((error) =>
        Effect.logWarning("computer use stopped following threads", { error: error._tag }),
      ),
      forkParked,
    );
    yield* status.pipe(forkParked);
  }

  return ComputerUseService.of({
    available: executor.available,
    status,
    // A new viewer asks the desktop first: permissions change in System Settings without an event.
    statusChanges: Stream.unwrap(Effect.as(status, SubscriptionRef.changes(statusRef))),
    setEnabled: Effect.fn("ComputerUseService.setEnabled")(function* (enabled) {
      const value = yield* executor.request({ op: "set-enabled", enabled });
      if (!enabled) yield* grants.withPermits(1)(Effect.sync(() => (grant = undefined)));
      const next = yield* decodeStatus(value).pipe(Effect.mapError(malformed));
      yield* publish(next);
      return next;
    }),
    openPermissionSettings: Effect.fn("ComputerUseService.openPermissionSettings")(
      function* (permission) {
        yield* executor.request({ op: "open-permission-settings", permission });
      },
    ),
    allowThread: Effect.fn("ComputerUseService.allowThread")(function* (threadId) {
      yield* Effect.annotateCurrentSpan({ "thread.id": threadId });
      if (!executor.available) return yield* ComputerUseExecutor.unavailableError();
      const titles = yield* engine
        .getThreadTitles([threadId])
        .pipe(
          Effect.mapError(
            () => new ComputerUseError({ code: "failed", message: "Could not read the thread." }),
          ),
        );
      const title = titles[threadId];
      if (title === undefined) {
        return yield* new ComputerUseError({ code: "invalid-request", message: "No such thread." });
      }
      yield* grants.withPermits(1)(
        Effect.gen(function* () {
          const value = yield* executor.request({
            op: "start",
            owner: { environmentId, threadId, label: title.trim() || "Gustaf" },
          });
          const { sessionToken } = yield* decodeSessionToken(value).pipe(
            Effect.mapError(malformed),
          );
          grant = { threadId, sessionToken };
        }),
      );
      return yield* status;
    }),
    stop: grants
      .withPermits(1)(
        executor
          .request({ op: "stop" })
          .pipe(Effect.tap(() => Effect.sync(() => (grant = undefined)))),
      )
      .pipe(Effect.andThen(status), Effect.withSpan("ComputerUseService.stop")),
    screenshot: Effect.fn("ComputerUseService.screenshot")(function* (caller, input) {
      return yield* inSession(caller, (held) =>
        Effect.gen(function* () {
          const shot = yield* executor.request({
            op: "screenshot",
            sessionToken: held.sessionToken,
            ...(input.displayId === undefined ? {} : { displayId: input.displayId }),
          });
          const geometry = yield* decodeGeometry(shot).pipe(Effect.mapError(malformed));
          const { data } = yield* decodePng(shot).pipe(Effect.mapError(malformed));
          const displays = yield* executor
            .request({ op: "displays", sessionToken: held.sessionToken })
            .pipe(
              Effect.flatMap((value) => decodeDisplays(value).pipe(Effect.mapError(malformed))),
            );
          const context = yield* executor
            .request({ op: "context", sessionToken: held.sessionToken })
            .pipe(Effect.flatMap((value) => decodeContext(value).pipe(Effect.mapError(malformed))));
          return { geometry, png: data, displays, context };
        }),
      );
    }),
    act: Effect.fn("ComputerUseService.act")(function* (caller, action) {
      yield* Effect.annotateCurrentSpan({ "computerUse.action": action.type });
      yield* inSession(caller, (held) =>
        executor.request({ op: "act", sessionToken: held.sessionToken, action }),
      );
    }),
    wait: Effect.fn("ComputerUseService.wait")(function* (caller, seconds) {
      yield* requireGrant(caller);
      yield* Effect.sleep(Duration.seconds(Math.min(Math.max(seconds, 0), MAX_WAIT_SECONDS)));
      // Stopped meanwhile: say so now rather than on the next action.
      yield* requireGrant(caller);
    }),
    release: Effect.fn("ComputerUseService.release")(function* (caller) {
      const held = yield* requireGrant(caller);
      yield* grants.withPermits(1)(
        executor
          .request({ op: "stop", sessionToken: held.sessionToken })
          .pipe(Effect.ensuring(dropGrant(held))),
      );
      yield* status;
    }),
  });
});

export const layer = Layer.effect(ComputerUseService, make).pipe(
  Layer.provide(ComputerUseExecutor.layer),
);
