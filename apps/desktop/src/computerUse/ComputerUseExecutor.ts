/**
 * Agents seeing and driving the whole Mac. Design and threat model: docs/internals/computer-use.md.
 *
 * The executor owns the session: one owner per Mac (the helper's lock), a visible indicator and
 * an emergency shortcut (ComputerUseHost), and the primary backend as its only caller, over the
 * file-descriptor pair it was spawned with (`connect`).
 */
import {
  ComputerUseError,
  ComputerUseExecutorRequest,
  type ComputerUseExecutorRequest as ComputerUseExecutorRequestType,
  type ComputerUseAction,
  type ComputerUseCaptureGeometry,
  type ComputerUseContext,
  type ComputerUseDisplay,
  type ComputerUseEndReason,
  type ComputerUseExecutorScreenshot,
  type ComputerUseOwner,
  type ComputerUsePermission,
  type ComputerUsePermissions,
  type ComputerUseScreenState,
  type ComputerUseStatus,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ComputerUseBackend from "./ComputerUseBackend.ts";
import * as ComputerUseHost from "./ComputerUseHost.ts";
import {
  actionPoints,
  captureIsCurrent,
  captureSize,
  planInputs,
  toGlobal,
  type ComputerUseInput,
} from "./ComputerUsePlan.ts";

const KEPT_CAPTURES = 8;
const MAX_LABEL_CHARS = 80;
const MAX_ID_CHARS = 128;
const MAX_APP_CHARS = 200;

/** Apps whose windows macOS does not let synthetic events reach. */
const SYSTEM_DIALOG_APPS = new Set([
  "com.apple.loginwindow",
  "com.apple.SecurityAgent",
  "com.apple.UserNotificationCenter",
]);

const CONTROL_CHARACTER = /\p{Cc}/u;

export interface ComputerUseScreenshotOptions {
  readonly displayId?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
}

/** One backend run speaking NDJSON: requests in through `handleLine`, replies and events out. */
export interface ComputerUseConnection {
  readonly output: Stream.Stream<Uint8Array>;
  readonly handleLine: (line: string) => Effect.Effect<void>;
}

export class ComputerUseExecutor extends Context.Service<
  ComputerUseExecutor,
  {
    readonly status: Effect.Effect<ComputerUseStatus>;
    readonly setEnabled: (enabled: boolean) => Effect.Effect<void, ComputerUseError>;
    readonly openSettings: (
      permission: ComputerUsePermission,
    ) => Effect.Effect<void, ComputerUseError>;
    /** Returns the session token every later call must carry. */
    readonly start: (
      connection: number,
      owner: ComputerUseOwner,
    ) => Effect.Effect<string, ComputerUseError>;
    /** The owner's own stop needs its token; without one, whatever runs stops. */
    readonly stop: (
      connection: number,
      token: string | undefined,
    ) => Effect.Effect<void, ComputerUseError>;
    /** Ends the session and leaves nothing pressed; false when none ran. */
    readonly end: (reason: ComputerUseEndReason) => Effect.Effect<boolean>;
    readonly displays: (
      connection: number,
      token: string,
    ) => Effect.Effect<readonly ComputerUseDisplay[], ComputerUseError>;
    readonly context: (
      connection: number,
      token: string,
    ) => Effect.Effect<ComputerUseContext, ComputerUseError>;
    readonly screenshot: (
      connection: number,
      token: string,
      options: ComputerUseScreenshotOptions,
    ) => Effect.Effect<ComputerUseExecutorScreenshot, ComputerUseError>;
    readonly act: (
      connection: number,
      token: string,
      action: ComputerUseAction,
    ) => Effect.Effect<void, ComputerUseError>;
    /** A connection for one backend run; closing its scope ends a session it started. */
    readonly connect: Effect.Effect<ComputerUseConnection, never, Scope.Scope>;
  }
>()("@t3tools/desktop/computerUse/ComputerUseExecutor") {}

type Held =
  | { readonly kind: "button"; readonly button: "left" | "right" | "middle" }
  | { readonly kind: "key"; readonly code: number };

interface Session {
  readonly token: string;
  readonly owner: ComputerUseOwner;
  readonly connection: number;
  /** Holds the owner lock until closed. */
  readonly scope: Scope.Closeable;
  readonly captures: ComputerUseCaptureGeometry[];
  /** Pressed and not yet released, in press order. */
  readonly held: Held[];
  pointer: { readonly x: number; readonly y: number };
}

/** What `detach` took from an ended session, for `release` to undo. */
interface Ended {
  readonly reason: ComputerUseEndReason;
  readonly session: Session;
}

const error = (code: ComputerUseError["code"], message: string) =>
  new ComputerUseError({ code, message });

const cancelled = () =>
  error("cancelled", "Control was stopped; the rest of this action was not performed.");
const stale = () =>
  error("stale-capture", "That screenshot no longer matches the screen. Take a new one.");
const noSession = () =>
  error(
    "no-session",
    "This computer-use session has ended. Start a new one when the user allows it.",
  );
const busy = (owner: string, app: string | undefined) =>
  error(
    "busy",
    `This Mac is already controlled by "${owner}"${app === undefined ? "" : ` in ${app}`}. It must stop first.`,
  );

const fromBackend = (failure: ComputerUseBackend.ComputerUseBackendError) => {
  switch (failure.code) {
    case "screen-recording-denied":
    case "accessibility-denied":
      return error("permission-required", "macOS refused the request: a permission was revoked.");
    case "app-not-found":
      return error("invalid-action", "No such app on this Mac.");
    default:
      return error("failed", `The Mac did not respond: ${failure.code}.`);
  }
};

const granted = (permissions: ComputerUsePermissions) =>
  permissions.screenRecording && permissions.accessibility;

const missing = (permissions: ComputerUsePermissions) =>
  !permissions.screenRecording && !permissions.accessibility
    ? "Screen Recording and Accessibility"
    : !permissions.screenRecording
      ? "Screen Recording"
      : "Accessibility";

const screenOf = (probe: ComputerUseBackend.ComputerUseProbe): ComputerUseScreenState =>
  probe.screenLocked
    ? "locked"
    : probe.app !== undefined && SYSTEM_DIALOG_APPS.has(probe.app.bundleId)
      ? "system-dialog"
      : probe.secureInput
        ? "secure-input"
        : "available";

const validOwner = (owner: ComputerUseOwner): ComputerUseOwner | undefined => {
  const id = (value: string) =>
    value.trim().length > 0 && [...value].length <= MAX_ID_CHARS && !CONTROL_CHARACTER.test(value);
  if (!id(owner.environmentId) || !id(owner.threadId)) return undefined;
  const label = [...owner.label.replaceAll(/\p{Cc}/gu, "")]
    .slice(0, MAX_LABEL_CHARS)
    .join("")
    .trim();
  return { ...owner, label: label.length === 0 ? "Gustaf agent" : label };
};

/** Compares secrets without returning early on the first difference. */
const sameSecret = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const sameOwner = (left: ComputerUseOwner, right: ComputerUseOwner) =>
  left.environmentId === right.environmentId &&
  left.threadId === right.threadId &&
  left.label === right.label;

const isPlanError = Schema.is(ComputerUseError);

const make = Effect.gen(function* () {
  const backend = yield* ComputerUseBackend.ComputerUseBackend;
  const host = yield* ComputerUseHost.ComputerUseHost;
  const random = yield* SecureRandom.SecureRandom;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  // Every OS call goes through this, like one helper at a time. A stop takes it to release
  // what is held, and each step checks the epoch while holding it, so nothing posts after.
  const backendLock = yield* Semaphore.make(1);
  const startLock = yield* Semaphore.make(1);
  const enableLock = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<void>();
  const withBackend = backendLock.withPermits(1);

  let enabled: boolean | undefined;
  let session: Session | undefined;
  /** Bumped when a session ends, so a step planned before cannot run after. */
  let epoch = 0;
  let nextCapture = 0;
  let lastEnd: ComputerUseEndReason | undefined;
  /** A start between its checks and its claim; an end in that window cancels it. */
  let pendingStart: { cancelled: boolean } | undefined;
  let nextConnection = 0;

  const announce = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const isEnabled = Effect.suspend(() =>
    enabled === undefined
      ? host.readEnabled.pipe(Effect.tap((value) => Effect.sync(() => (enabled ??= value))))
      : Effect.succeed(enabled),
  );

  const requireSupported = backend.supported
    ? Effect.void
    : Effect.fail(error("unsupported", "Computer use is only available on macOS."));

  const status = Effect.gen(function* () {
    const on = yield* isEnabled;
    const permissions =
      backend.supported && on
        ? yield* withBackend(backend.permissions).pipe(
            Effect.option,
            Effect.map(Option.getOrUndefined),
          )
        : undefined;
    const owner = session?.owner;
    const availability: ComputerUseStatus["availability"] = !backend.supported
      ? "unsupported"
      : !on
        ? "disabled"
        : permissions === undefined || !granted(permissions)
          ? "permissions-required"
          : owner !== undefined
            ? "active"
            : "ready";
    return {
      availability,
      ...(permissions === undefined ? {} : { permissions }),
      ...(owner === undefined ? {} : { owner }),
      ...(lastEnd === undefined ? {} : { lastEndReason: lastEnd }),
      emergencyShortcut: ComputerUseHost.EMERGENCY_SHORTCUT,
    } satisfies ComputerUseStatus;
  }).pipe(Effect.withSpan("ComputerUseExecutor.status"));

  /** Stops the session at once: no step that has not started will run. */
  const detach = (reason: ComputerUseEndReason): Ended | undefined => {
    if (session === undefined) {
      if (pendingStart !== undefined) pendingStart.cancelled = true;
      return undefined;
    }
    const ended = { reason, session };
    session = undefined;
    epoch += 1;
    lastEnd = reason;
    return ended;
  };

  /** Waits for a step in flight, releases what it left pressed, then frees the Mac. */
  const release = Effect.fn("ComputerUseExecutor.release")(function* (ended: Ended) {
    const { pointer, held } = ended.session;
    yield* withBackend(
      Effect.forEach(
        held.toReversed(),
        (item) =>
          backend
            .input(
              item.kind === "button"
                ? { kind: "button", ...pointer, button: item.button, down: false, clicks: 1 }
                : { kind: "key", code: item.code, down: false, flags: 0 },
            )
            .pipe(Effect.ignore),
        { discard: true },
      ),
    );
    yield* Scope.close(ended.session.scope, Exit.void);
    yield* host.sessionEnded;
    yield* announce;
  }, Effect.uninterruptible);

  const end = (reason: ComputerUseEndReason) =>
    Effect.suspend(() => {
      const ended = detach(reason);
      return ended === undefined ? Effect.succeed(false) : release(ended).pipe(Effect.as(true));
    }).pipe(Effect.withSpan("ComputerUseExecutor.end", { attributes: { reason } }));

  const setEnabled = Effect.fn("ComputerUseExecutor.setEnabled")(function* (next: boolean) {
    yield* requireSupported;
    const was = yield* isEnabled;
    if (next && !was && !(yield* host.confirmEnable)) {
      return yield* error("declined", "The user did not allow computer use on this Mac.");
    }
    yield* host
      .saveEnabled(next)
      .pipe(Effect.mapError((failure) => error("failed", failure.message)));
    enabled = next;
    if (!next) yield* end("disabled");
    if (next !== was) yield* announce;
  }, enableLock.withPermits(1));

  const openSettings = Effect.fn("ComputerUseExecutor.openSettings")(function* (
    permission: ComputerUsePermission,
  ) {
    yield* requireSupported;
    yield* withBackend(backend.openSettings(permission)).pipe(Effect.mapError(fromBackend));
  });

  const start = Effect.fn("ComputerUseExecutor.start")(
    function* (connection: number, requested: ComputerUseOwner) {
      yield* requireSupported;
      const owner = validOwner(requested);
      if (owner === undefined) return yield* error("invalid-request", "Invalid owner ids.");
      if (!(yield* isEnabled)) {
        return yield* error(
          "disabled",
          "Computer use is turned off on this Mac. The user can turn it on from the thread's Control Mac button.",
        );
      }
      const permissions = yield* withBackend(backend.permissions).pipe(
        Effect.mapError(fromBackend),
      );
      if (!granted(permissions)) {
        return yield* error(
          "permission-required",
          `Gustaf needs ${missing(permissions)} permission in System Settings > Privacy & Security.`,
        );
      }
      if (session !== undefined) {
        if (sameOwner(session.owner, owner) && session.connection === connection) {
          return session.token;
        }
        return yield* busy(session.owner.label, undefined);
      }
      const token = Buffer.from(yield* random.randomBytes(32)).toString("base64url");
      // Uninterruptible: a claimed lock or a shown indicator is never left without a session.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const pending = { cancelled: false };
          pendingStart = pending;
          const scope = yield* Scope.make();
          const claimed = yield* backend.claim(owner.label).pipe(
            Scope.provide(scope),
            Effect.mapError((failure) =>
              failure._tag === "ComputerUseOwnerBusyError"
                ? busy(failure.holder?.owner ?? "another Gustaf", failure.holder?.app)
                : fromBackend(failure),
            ),
            // A stop while claiming wins over the start.
            Effect.andThen(() => (pending.cancelled ? Effect.fail(cancelled()) : Effect.void)),
            Effect.andThen(() =>
              host
                .sessionStarted(owner, (reason) => {
                  runFork(end(reason));
                })
                .pipe(
                  Effect.mapError((failure) =>
                    error(
                      "emergency-stop-unavailable",
                      `The emergency stop shortcut could not be set up, so control was not started: ${failure.message}`,
                    ),
                  ),
                ),
            ),
            Effect.exit,
          );
          pendingStart = undefined;
          if (Exit.isFailure(claimed)) {
            yield* Scope.close(scope, Exit.void);
            return yield* Effect.failCause(claimed.cause);
          }
          session = {
            token,
            owner,
            connection,
            scope,
            captures: [],
            held: [],
            pointer: { x: 0, y: 0 },
          };
        }),
      );
      lastEnd = undefined;
      yield* announce;
      return token;
    },
    // A second start waits, so it finds this one's session instead of racing its claim.
    startLock.withPermits(1),
  );

  /** The epoch of the session `token` names, if the connection that started it asks. */
  const sessionEpoch = (connection: number, token: string) =>
    Effect.suspend(() =>
      session !== undefined && sameSecret(session.token, token) && session.connection === connection
        ? Effect.succeed(epoch)
        : Effect.fail(noSession()),
    );

  const stop = Effect.fn("ComputerUseExecutor.stop")(function* (
    connection: number,
    token: string | undefined,
  ) {
    if (token !== undefined) yield* sessionEpoch(connection, token);
    yield* end(token === undefined ? "stopped-by-user" : "stopped-by-owner");
  });

  const connectionClosed = (connection: number) =>
    Effect.suspend(() =>
      session?.connection === connection ? end("connection-lost") : Effect.succeed(false),
    );

  /** Checks before acting: permissions still granted (else the session ends) and the screen usable. */
  const preflight = Effect.fn("ComputerUseExecutor.preflight")(function* (keyboard: boolean) {
    const checked = yield* withBackend(
      Effect.gen(function* () {
        const permissions = yield* backend.permissions;
        return granted(permissions) ? { probe: yield* backend.probe } : { revoked: permissions };
      }),
    ).pipe(Effect.mapError(fromBackend));
    if ("revoked" in checked) {
      yield* end("permission-revoked");
      return yield* error(
        "permission-required",
        `${missing(checked.revoked)} permission was turned off, so control stopped.`,
      );
    }
    switch (screenOf(checked.probe)) {
      case "locked":
        return yield* error(
          "screen-locked",
          "The Mac's screen is locked. Ask the user to unlock it.",
        );
      case "system-dialog":
        return yield* error(
          "system-dialog",
          "A system dialog is in front, and macOS does not let it be controlled. Ask the user to answer it.",
        );
      case "secure-input":
        if (keyboard) {
          return yield* error(
            "secure-input",
            "A secure field, such as a password prompt, has the keyboard; typing is blocked.",
          );
        }
    }
  });

  const checkEpoch = (planned: number) =>
    Effect.suspend(() =>
      epoch === planned && session !== undefined ? Effect.void : Effect.fail(cancelled()),
    );

  /** One event, posted only if the session it was planned in is still running. */
  const step = (planned: number, input: ComputerUseInput) =>
    withBackend(
      Effect.gen(function* () {
        const current = session;
        if (epoch !== planned || current === undefined) return yield* cancelled();
        if (input.kind === "button" && input.down)
          current.held.push({ kind: "button", button: input.button });
        if (input.kind === "key" && input.down)
          current.held.push({ kind: "key", code: input.code });
        if (input.kind === "move" || input.kind === "button")
          current.pointer = { x: input.x, y: input.y };
        yield* backend.input(input).pipe(Effect.mapError(fromBackend));
        if (epoch !== planned || session !== current) return;
        const released = current.held.findLastIndex((held) =>
          held.kind === "button"
            ? input.kind === "button" && !input.down && input.button === held.button
            : input.kind === "key" && !input.down && input.code === held.code,
        );
        if (released !== -1) current.held.splice(released, 1);
      }),
    );

  const screenshot = Effect.fn("ComputerUseExecutor.screenshot")(function* (
    connection: number,
    token: string,
    options: ComputerUseScreenshotOptions,
  ) {
    const planned = yield* sessionEpoch(connection, token);
    yield* preflight(false);
    const { target, image } = yield* withBackend(
      Effect.gen(function* () {
        const displays = yield* backend.displays.pipe(Effect.mapError(fromBackend));
        const target =
          options.displayId === undefined
            ? (displays.find((display) => display.main) ?? displays[0])
            : displays.find((display) => display.id === options.displayId);
        if (target === undefined) {
          return yield* error("invalid-action", "No such display. List the displays first.");
        }
        const { width, height } = captureSize(target, options.maxWidth, options.maxHeight);
        const image = yield* backend
          .capture(target.id, width, height)
          .pipe(Effect.mapError(fromBackend));
        return { target, image };
      }),
    );
    const current = session;
    if (epoch !== planned || current === undefined) return yield* cancelled();
    nextCapture += 1;
    const geometry: ComputerUseCaptureGeometry = {
      captureId: `c${nextCapture}`,
      displayId: target.id,
      bounds: target.bounds,
      scale: target.scale,
      width: image.width,
      height: image.height,
    };
    if (current.captures.length === KEPT_CAPTURES) current.captures.shift();
    current.captures.push(geometry);
    return { ...geometry, mimeType: "image/png", data: image.data } as const;
  });

  const act = Effect.fn("ComputerUseExecutor.act")(function* (
    connection: number,
    token: string,
    action: ComputerUseAction,
  ) {
    yield* Effect.annotateCurrentSpan({ action: action.type });
    const planned = yield* sessionEpoch(connection, token);
    yield* preflight(action.type === "type" || action.type === "key");
    if (action.type === "activate") {
      const app = action.app.trim();
      if (
        app.length === 0 ||
        [...app].length > MAX_APP_CHARS ||
        app.includes("/") ||
        CONTROL_CHARACTER.test(app)
      ) {
        return yield* error(
          "invalid-action",
          "Name the app, such as TextEdit, or its bundle id, such as com.apple.TextEdit.",
        );
      }
      return yield* withBackend(
        checkEpoch(planned).pipe(
          Effect.andThen(backend.activate(app).pipe(Effect.mapError(fromBackend))),
        ),
      );
    }
    const current = session;
    if (current === undefined) return yield* cancelled();
    const captures: ComputerUseCaptureGeometry[] = [];
    for (const point of actionPoints(action)) {
      const capture = current.captures.find((candidate) => candidate.captureId === point.captureId);
      if (capture === undefined) return yield* stale();
      captures.push(capture);
    }
    if (captures.length > 0) {
      const displays = yield* withBackend(backend.displays).pipe(Effect.mapError(fromBackend));
      if (!captures.every((capture) => captureIsCurrent(capture, displays))) return yield* stale();
    }
    const inputs = yield* Effect.try({
      try: () =>
        planInputs(action, (point) => {
          const capture = captures.find((candidate) => candidate.captureId === point.captureId);
          if (capture === undefined) throw stale();
          return toGlobal(capture, point.x, point.y);
        }),
      catch: (cause) =>
        isPlanError(cause) ? cause : error("invalid-action", "The action could not be planned."),
    });
    for (const input of inputs) yield* step(planned, input);
  });

  const displays = Effect.fn("ComputerUseExecutor.displays")(function* (
    connection: number,
    token: string,
  ) {
    yield* sessionEpoch(connection, token);
    return yield* withBackend(backend.displays).pipe(Effect.mapError(fromBackend));
  });

  const context = Effect.fn("ComputerUseExecutor.context")(function* (
    connection: number,
    token: string,
  ) {
    yield* sessionEpoch(connection, token);
    const probe = yield* withBackend(backend.probe).pipe(Effect.mapError(fromBackend));
    return {
      screen: screenOf(probe),
      ...(probe.app === undefined ? {} : { app: probe.app }),
      ...(probe.windowTitle === undefined ? {} : { windowTitle: probe.windowTitle }),
    } satisfies ComputerUseContext;
  });

  const answer = (
    connection: number,
    request: ComputerUseExecutorRequestType,
  ): Effect.Effect<unknown, ComputerUseError> => {
    switch (request.op) {
      case "status":
        return status;
      case "set-enabled":
        return setEnabled(request.enabled).pipe(Effect.andThen(status));
      case "open-permission-settings":
        return openSettings(request.permission).pipe(Effect.as(null));
      case "start":
        return start(connection, request.owner).pipe(
          Effect.map((sessionToken) => ({ sessionToken })),
        );
      case "stop":
        return stop(connection, request.sessionToken).pipe(Effect.as(null));
      case "displays":
        return displays(connection, request.sessionToken);
      case "context":
        return context(connection, request.sessionToken);
      case "screenshot":
        return screenshot(connection, request.sessionToken, {
          ...(request.displayId === undefined ? {} : { displayId: request.displayId }),
          ...(request.maxWidth === undefined ? {} : { maxWidth: request.maxWidth }),
          ...(request.maxHeight === undefined ? {} : { maxHeight: request.maxHeight }),
        });
      case "act":
        return act(connection, request.sessionToken, request.action).pipe(Effect.as(null));
    }
  };

  const connect = Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    nextConnection += 1;
    const connection = nextConnection;
    const outbox = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    // Replies are plain JSON values; failing to encode one is a defect.
    const send = (value: unknown) =>
      encodeJson(value).pipe(
        Effect.orDie,
        Effect.flatMap((json) => Queue.offer(outbox, lineEncoder.encode(`${json}\n`))),
        Effect.asVoid,
      );
    // Session requests keep their order; status, stop and switching never wait behind them.
    const sessionLane = yield* Semaphore.make(1);
    yield* Effect.addFinalizer(() =>
      connectionClosed(connection).pipe(Effect.andThen(Queue.end(outbox)), Effect.asVoid),
    );
    const subscription = yield* PubSub.subscribe(changes);
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach(() =>
        status.pipe(Effect.flatMap((current) => send({ event: "status", status: current }))),
      ),
      Effect.forkIn(scope),
    );

    // Untraced: each request's own operation has the span.
    const handleLine = Effect.fnUntraced(function* (line: string) {
      const parsed = decodeJson(line);
      const envelope = Option.flatMap(parsed, decodeEnvelope);
      if (Option.isNone(envelope)) {
        return yield* send({
          id: null,
          ok: false,
          error: { code: "invalid-request", message: "Malformed request." },
        });
      }
      const { id } = envelope.value;
      const request = Option.flatMap(parsed, decodeRequest);
      if (Option.isNone(request)) {
        return yield* send({
          id,
          ok: false,
          error: { code: "invalid-request", message: "Invalid request." },
        });
      }
      const lane = SESSION_OPS.has(request.value.op) ? sessionLane.withPermits(1) : identity;
      yield* answer(connection, request.value).pipe(
        lane,
        Effect.matchEffect({
          onFailure: (failure) =>
            send({ id, ok: false, error: { code: failure.code, message: failure.message } }),
          onSuccess: (result) => send({ id, ok: true, result }),
        }),
        Effect.forkIn(scope),
      );
    });

    return { output: Stream.fromQueue(outbox), handleLine } satisfies ComputerUseConnection;
  });

  // A restart never resumes control: the switch persists, a session does not.
  yield* host.quitRequested.pipe(Effect.andThen(end("app-quit")), Effect.forkScoped);
  yield* Effect.addFinalizer(() => end("app-quit"));

  return ComputerUseExecutor.of({
    status,
    setEnabled,
    openSettings,
    start,
    stop,
    end,
    displays,
    context,
    screenshot,
    act,
    connect,
  });
});

const identity = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect;
const lineEncoder = new TextEncoder();
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const SESSION_OPS = new Set(["start", "displays", "context", "screenshot", "act"]);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeEnvelope = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Number }));
const decodeRequest = Schema.decodeUnknownOption(ComputerUseExecutorRequest);

export const layer = Layer.effect(ComputerUseExecutor, make);
