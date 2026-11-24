/**
 * The OS calls behind computer use, one per method, over native/computer-use/ComputerUse.swift.
 * A separate process because ScreenCaptureKit is Swift-first, and killing it is a hard stop.
 * Requests and replies are never logged: they carry screen pixels and typed text.
 */
import type {
  ComputerUseDisplay,
  ComputerUseFrontApp,
  ComputerUsePermission,
  ComputerUsePermissions,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import type { ComputerUseInput } from "./ComputerUsePlan.ts";

/** `code` is a short helper code such as "helper-timed-out", never user content. */
export class ComputerUseBackendError extends Schema.TaggedError<ComputerUseBackendError>()(
  "ComputerUseBackendError",
  { code: Schema.String },
) {
  override get message(): string {
    return `The computer-use helper failed: ${this.code}.`;
  }
}

/** Who holds the Mac, as the lock file records it; written by this and older Tauri builds. */
export const ComputerUseHolder = Schema.Struct({
  pid: Schema.Number,
  app: Schema.String,
  owner: Schema.String,
});
export type ComputerUseHolder = typeof ComputerUseHolder.Type;

export class ComputerUseOwnerBusyError extends Schema.TaggedError<ComputerUseOwnerBusyError>()(
  "ComputerUseOwnerBusyError",
  { holder: Schema.optional(ComputerUseHolder) },
) {
  override get message(): string {
    return "Another Gustaf controls this Mac.";
  }
}

/** What the OS reports about the front of the screen. */
export interface ComputerUseProbe {
  readonly app?: ComputerUseFrontApp;
  readonly windowTitle?: string;
  readonly screenLocked: boolean;
  readonly secureInput: boolean;
}

export interface ComputerUseRawImage {
  /** Base64 PNG. */
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

export class ComputerUseBackend extends Context.Service<
  ComputerUseBackend,
  {
    /** macOS with the helper built; elsewhere the executor reports "unsupported". */
    readonly supported: boolean;
    readonly permissions: Effect.Effect<ComputerUsePermissions, ComputerUseBackendError>;
    readonly openSettings: (
      permission: ComputerUsePermission,
    ) => Effect.Effect<void, ComputerUseBackendError>;
    readonly displays: Effect.Effect<readonly ComputerUseDisplay[], ComputerUseBackendError>;
    readonly probe: Effect.Effect<ComputerUseProbe, ComputerUseBackendError>;
    readonly capture: (
      display: number,
      width: number,
      height: number,
    ) => Effect.Effect<ComputerUseRawImage, ComputerUseBackendError>;
    readonly input: (input: ComputerUseInput) => Effect.Effect<void, ComputerUseBackendError>;
    readonly activate: (app: string) => Effect.Effect<void, ComputerUseBackendError>;
    /** Holds the per-user owner lock, labelled with `owner`, until the scope closes. */
    readonly claim: (
      owner: string,
    ) => Effect.Effect<void, ComputerUseBackendError | ComputerUseOwnerBusyError, Scope.Scope>;
  }
>()("@t3tools/desktop/computerUse/ComputerUseBackend") {}

const QUICK = Duration.seconds(5);
const SLOW = Duration.seconds(20);
const lineEncoder = new TextEncoder();
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const HelperReply = Schema.Struct({
  id: Schema.Number,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(HelperReply));

const HelperPermissions = Schema.Struct({
  screenRecording: Schema.Boolean,
  accessibility: Schema.Boolean,
});
const HelperDisplay = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  main: Schema.Boolean,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  scale: Schema.Number,
});
const HelperContext = Schema.Struct({
  screenLocked: Schema.Boolean,
  secureInput: Schema.Boolean,
  app: Schema.optional(
    Schema.Struct({ name: Schema.String, bundleId: Schema.String, pid: Schema.Number }),
  ),
  windowTitle: Schema.optional(Schema.String),
});
const HelperImage = Schema.Struct({
  data: Schema.String,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
const LockAnswer = Schema.Union([
  Schema.Struct({ held: Schema.Literal(true) }),
  Schema.Struct({ busy: Schema.NullOr(Schema.Unknown) }),
  Schema.Struct({ error: Schema.String }),
]);
const decodeLockAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(LockAnswer));
const decodeHolder = Schema.decodeUnknownOption(ComputerUseHolder);

const decodeResult =
  <S extends Schema.Decoder<unknown>>(schema: S, code: string) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => new ComputerUseBackendError({ code })),
    );
const encodeLine = (value: unknown) =>
  encodeJson(value).pipe(
    Effect.map((json) => lineEncoder.encode(`${json}\n`)),
    Effect.mapError(() => new ComputerUseBackendError({ code: "encode-failed" })),
  );

interface HelperProcess {
  readonly scope: Scope.Closeable;
  readonly requests: Queue.Queue<Uint8Array, Cause.Done>;
  readonly pending: Map<number, Deferred.Deferred<unknown, ComputerUseBackendError>>;
  next: number;
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostEnvironment = yield* HostProcess.Environment;
  const { path } = environment;

  const helperPath = environment.isPackaged
    ? path.join(environment.resourcesPath, "computer-use", "gustaf-computer-use")
    : path.join(
        environment.rootDir,
        "native",
        "computer-use",
        "build",
        environment.processArch,
        "gustaf-computer-use",
      );
  const supported =
    environment.platform === "darwin" &&
    (yield* fileSystem.exists(helperPath).pipe(Effect.orElseSucceed(() => false)));
  // Every Gustaf build and instance, and the older Tauri builds, find the lock here.
  const lockPath = path.join(environment.appDataDirectory, "Gustaf", "computer-use.lock");

  let helper: HelperProcess | undefined;

  const drop = Effect.suspend(() => {
    const current = helper;
    helper = undefined;
    return current === undefined ? Effect.void : Scope.close(current.scope, Exit.void);
  });

  const start = Effect.gen(function* () {
    const scope = yield* Scope.make();
    const requests = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const pending = new Map<number, Deferred.Deferred<unknown, ComputerUseBackendError>>();
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(helperPath, [], {
          stdin: Stream.fromQueue(requests),
          stdout: "pipe",
          stderr: "ignore",
          env: hostEnvironment,
        }),
      )
      .pipe(
        Scope.provide(scope),
        Effect.tapError(() => Scope.close(scope, Exit.void)),
        Effect.mapError(() => new ComputerUseBackendError({ code: "helper-failed-to-start" })),
      );
    // Untraced: one reply per request, already inside the calling operation's span.
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Option.match(decodeReply(line), {
          onNone: () => Effect.void,
          onSome: (reply) => {
            const waiting = pending.get(reply.id);
            pending.delete(reply.id);
            if (waiting === undefined) return Effect.void;
            return reply.error === undefined
              ? Deferred.succeed(waiting, reply.result)
              : Deferred.fail(waiting, new ComputerUseBackendError({ code: reply.error }));
          },
        }),
      ),
      Effect.ignore,
      Effect.ensuring(
        Effect.suspend(() =>
          Effect.forEach(
            [...pending.values()],
            (waiting) =>
              Deferred.fail(waiting, new ComputerUseBackendError({ code: "helper-stopped" })),
            { discard: true },
          ),
        ),
      ),
      Effect.forkIn(scope),
    );
    return { scope, requests, pending, next: 0 } satisfies HelperProcess;
  });

  const call = Effect.fnUntraced(function* (
    request: Readonly<Record<string, unknown>>,
    timeout: Duration.Duration,
  ) {
    if (!supported) return yield* new ComputerUseBackendError({ code: "unsupported" });
    helper ??= yield* start;
    const current = helper;
    current.next += 1;
    const id = current.next;
    const reply = yield* Deferred.make<unknown, ComputerUseBackendError>();
    current.pending.set(id, reply);
    yield* Queue.offer(current.requests, yield* encodeLine({ ...request, id }));
    const answer = yield* Deferred.await(reply).pipe(Effect.timeoutOption(timeout));
    if (Option.isNone(answer)) {
      // A helper that stops answering is replaced; the executor releases what it held.
      if (helper === current) yield* drop;
      return yield* new ComputerUseBackendError({ code: "helper-timed-out" });
    }
    return answer.value;
  });

  const askPermissions = call({ op: "permissions" }, QUICK).pipe(
    Effect.flatMap(decodeResult(HelperPermissions, "invalid-reply")),
  );

  const claim = Effect.fn("ComputerUseBackend.claim")(function* (owner: string) {
    const holder: ComputerUseHolder = { pid: process.pid, app: environment.displayName, owner };
    if (!supported) return yield* new ComputerUseBackendError({ code: "unsupported" });
    const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(helperPath, ["--hold-lock", lockPath], {
          stdin: Stream.fromQueue(input),
          stdout: "pipe",
          stderr: "ignore",
          env: hostEnvironment,
        }),
      )
      .pipe(Effect.mapError(() => new ComputerUseBackendError({ code: "lock-failed" })));
    // Runs before the spawner's kill: closing stdin lets the helper clear its record first.
    yield* Effect.addFinalizer(() =>
      Queue.end(input).pipe(
        Effect.andThen(handle.exitCode.pipe(Effect.timeoutOption(QUICK))),
        Effect.ignore,
      ),
    );
    yield* Queue.offer(input, yield* encodeLine(holder));
    const answer = yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runHead,
      Effect.timeoutOption(QUICK),
      Effect.map((line) => Option.flatMap(Option.flatten(line), decodeLockAnswer)),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(answer)) return yield* new ComputerUseBackendError({ code: "lock-failed" });
    const value = answer.value;
    if ("busy" in value) {
      const known = decodeHolder(value.busy);
      return yield* new ComputerUseOwnerBusyError(
        Option.isSome(known) ? { holder: known.value } : {},
      );
    }
    if ("error" in value) return yield* new ComputerUseBackendError({ code: value.error });
  });

  yield* Effect.addFinalizer(() => drop);

  return ComputerUseBackend.of({
    supported,
    permissions: Effect.gen(function* () {
      // A helper that failed to start or answer says nothing about permissions: ask a fresh one.
      const permissions = yield* askPermissions.pipe(Effect.catch(() => askPermissions));
      // A process keeps the Screen Recording answer it first got, so a grant made in System
      // Settings shows only in a new helper.
      if (!permissions.screenRecording) yield* drop;
      return permissions;
    }).pipe(Effect.withSpan("ComputerUseBackend.permissions")),
    openSettings: Effect.fn("ComputerUseBackend.openSettings")(function* (permission) {
      yield* call({ op: "open-settings", permission }, QUICK);
    }),
    displays: call({ op: "displays" }, QUICK).pipe(
      Effect.flatMap(decodeResult(Schema.Array(HelperDisplay), "invalid-reply")),
      Effect.map((displays) =>
        displays.map(({ x, y, width, height, ...display }) => ({
          ...display,
          bounds: { x, y, width, height },
        })),
      ),
      Effect.withSpan("ComputerUseBackend.displays"),
    ),
    probe: call({ op: "context" }, QUICK).pipe(
      Effect.flatMap(decodeResult(HelperContext, "invalid-reply")),
      Effect.map(({ app, windowTitle, ...probe }): ComputerUseProbe => ({
        ...probe,
        ...(app === undefined ? {} : { app }),
        ...(windowTitle === undefined ? {} : { windowTitle }),
      })),
      Effect.withSpan("ComputerUseBackend.probe"),
    ),
    capture: Effect.fn("ComputerUseBackend.capture")(function* (display, width, height) {
      const image = yield* call({ op: "capture", display, width, height }, SLOW);
      return yield* decodeResult(HelperImage, "capture-failed")(image);
    }),
    // Untraced: a drag or typed text posts dozens of events inside one action's span.
    input: Effect.fnUntraced(function* (input) {
      yield* call({ op: "input", ...input }, QUICK);
    }),
    activate: Effect.fn("ComputerUseBackend.activate")(function* (app) {
      yield* call({ op: "activate", app }, SLOW);
    }),
    claim,
  });
});

export const layerHelper = Layer.effect(ComputerUseBackend, make);
