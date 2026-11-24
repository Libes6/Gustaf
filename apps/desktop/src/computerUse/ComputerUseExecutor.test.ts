// The executor against a fake Mac: nothing here touches the real screen, mouse or keyboard.
import {
  ComputerUseExecutorEvent,
  ComputerUseExecutorReply,
  type ComputerUseAction,
  type ComputerUseDisplay,
  type ComputerUseEndReason,
  type ComputerUseOwner,
  type ComputerUsePermissions,
} from "@t3tools/contracts";
// The executor side of the sample the contracts test decodes.
import wire from "../../../../packages/contracts/src/computerUse.wire.json" with { type: "json" };
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

import * as ComputerUseBackend from "./ComputerUseBackend.ts";
import * as ComputerUseExecutor from "./ComputerUseExecutor.ts";
import * as ComputerUseHost from "./ComputerUseHost.ts";
import type { ComputerUseInput } from "./ComputerUsePlan.ts";

const GRANTED: ComputerUsePermissions = { screenRecording: true, accessibility: true };

const display = (
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  scale: number,
): ComputerUseDisplay => ({
  id,
  name: `Display ${id}`,
  main: id === 1,
  bounds: { x, y, width, height },
  scale,
});

interface World {
  supported: boolean;
  permissions: ComputerUsePermissions;
  /** The helper could not be asked, such as when it failed to start. */
  permissionsFail: boolean;
  displays: ComputerUseDisplay[];
  probe: ComputerUseBackend.ComputerUseProbe;
  inputs: ComputerUseInput[];
  calls: number;
  /** The input with this index waits for `gate` after completing `entered`. */
  pauseAt:
    | {
        readonly index: number;
        readonly entered: Deferred.Deferred<void>;
        readonly gate: Deferred.Deferred<void>;
      }
    | undefined;
}

/** The per-user lock file every instance on the Mac shares. */
interface Lock {
  holder: ComputerUseBackend.ComputerUseHolder | undefined;
  /** The next claim waits for `gate` after completing `entered`. */
  pause?: { readonly entered: Deferred.Deferred<void>; readonly gate: Deferred.Deferred<void> };
}

interface HostLog {
  decline: boolean;
  failStart: boolean;
  enabled: boolean;
  saved: boolean[];
  started: string[];
  stop?: (reason: ComputerUseHost.ComputerUseLocalStop) => void;
}

const makeWorld = (): World => ({
  supported: true,
  permissions: GRANTED,
  permissionsFail: false,
  displays: [display(1, 0, 0, 1440, 900, 2), display(2, -1920, -200, 1920, 1080, 1)],
  probe: { screenLocked: false, secureInput: false },
  inputs: [],
  calls: 0,
  pauseAt: undefined,
});

const fakeBackend = (world: World, lock: Lock) =>
  ComputerUseBackend.ComputerUseBackend.of({
    supported: world.supported,
    permissions: Effect.suspend(() => {
      world.calls += 1;
      return world.permissionsFail
        ? Effect.fail(new ComputerUseBackend.ComputerUseBackendError({ code: "helper-timed-out" }))
        : Effect.succeed(world.permissions);
    }),
    openSettings: () => Effect.void,
    displays: Effect.sync(() =>
      world.displays.map((item) => ({ ...item, bounds: { ...item.bounds } })),
    ),
    probe: Effect.sync(() => world.probe),
    capture: (_display, width, height) => Effect.succeed({ data: "iVBORw0KGgo=", width, height }),
    input: (input) =>
      Effect.gen(function* () {
        const pause = world.pauseAt;
        if (pause !== undefined && pause.index === world.inputs.length) {
          world.pauseAt = undefined;
          yield* Deferred.succeed(pause.entered, undefined);
          yield* Deferred.await(pause.gate);
        }
        world.inputs.push(input);
      }),
    activate: () => Effect.void,
    claim: (owner) =>
      Effect.gen(function* () {
        const pause = lock.pause;
        if (pause !== undefined) {
          delete lock.pause;
          yield* Deferred.succeed(pause.entered, undefined);
          yield* Deferred.await(pause.gate);
        }
        if (lock.holder !== undefined) {
          return yield* new ComputerUseBackend.ComputerUseOwnerBusyError({ holder: lock.holder });
        }
        lock.holder = { pid: 7, app: "Gustaf Test", owner };
        yield* Effect.addFinalizer(() => Effect.sync(() => (lock.holder = undefined)));
      }),
  });

interface Rig {
  readonly executor: ComputerUseExecutor.ComputerUseExecutor["Service"];
  readonly world: World;
  readonly log: HostLog;
  readonly lock: Lock;
  /** Takes one per session end, from whatever ended it. */
  readonly ended: Queue.Queue<void>;
}

const rig = (
  options: { readonly enabled?: boolean; readonly lock?: Lock; readonly world?: World } = {},
) =>
  Effect.gen(function* () {
    const world = options.world ?? makeWorld();
    const lock = options.lock ?? { holder: undefined };
    const log: HostLog = {
      decline: false,
      failStart: false,
      enabled: options.enabled ?? true,
      saved: [],
      started: [],
    };
    const ended = yield* Queue.unbounded<void>();
    const host = ComputerUseHost.ComputerUseHost.of({
      readEnabled: Effect.sync(() => log.enabled),
      confirmEnable: Effect.sync(() => !log.decline),
      saveEnabled: (enabled) => Effect.sync(() => log.saved.push(enabled)),
      sessionStarted: (owner, stop) =>
        log.failStart
          ? Effect.fail(
              new ComputerUseHost.ComputerUseHostError({ reason: "shortcut-unavailable" }),
            )
          : Effect.sync(() => {
              log.started.push(owner.label);
              log.stop = stop;
            }),
      sessionEnded: Queue.offer(ended, undefined).pipe(Effect.asVoid),
      quitRequested: Effect.never,
    });
    const context = yield* Layer.build(
      ComputerUseExecutor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ComputerUseBackend.ComputerUseBackend, fakeBackend(world, lock)),
            Layer.succeed(ComputerUseHost.ComputerUseHost, host),
            SecureRandom.layerWebCrypto,
          ),
        ),
      ),
    );
    return {
      executor: Context.get(context, ComputerUseExecutor.ComputerUseExecutor),
      world,
      log,
      lock,
      ended,
    } satisfies Rig;
  });

const owner = (label: string): ComputerUseOwner => ({
  environmentId: "env-1",
  threadId: `thread-${label}`,
  label,
});

const at = (captureId: string, x: number, y: number) => ({ captureId, x, y });

const codeOf = <A>(effect: Effect.Effect<A, { readonly code: string }>) =>
  effect.pipe(Effect.match({ onFailure: (failure) => failure.code, onSuccess: () => undefined }));

/**
 * Runs `action`, stops control while input `pauseAt` is being posted, and returns every input
 * the Mac received, including what the stop released.
 */
const stoppedMidAction = (action: ComputerUseAction, pauseAt: number, screenshot: boolean) =>
  Effect.gen(function* () {
    const r = yield* rig();
    const token = yield* r.executor.start(1, owner("A"));
    if (screenshot) yield* r.executor.screenshot(1, token, {});
    const entered = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    r.world.pauseAt = { index: pauseAt, entered, gate };
    const acting = yield* codeOf(r.executor.act(1, token, action)).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    // Starts at once: the stop takes effect before the paused input finishes.
    const ending = yield* Effect.forkChild(r.executor.end("stopped-by-user"), {
      startImmediately: true,
    });
    yield* Deferred.succeed(gate, undefined);
    assert.equal(yield* Fiber.join(acting), "cancelled");
    assert.isTrue(yield* Fiber.join(ending));
    return { rig: r, token, inputs: r.world.inputs };
  });

describe("ComputerUseExecutor", () => {
  it.effect("follows platform, switch, permissions and session in its status", () =>
    Effect.gen(function* () {
      const none = { screenRecording: false, accessibility: false };
      const screenOnly = { screenRecording: true, accessibility: false };
      // (supported, enabled, permissions, expected, code start refuses with)
      const cases = [
        [false, true, GRANTED, "unsupported", "unsupported"],
        [true, false, GRANTED, "disabled", "disabled"],
        [true, true, none, "permissions-required", "permission-required"],
        [true, true, screenOnly, "permissions-required", "permission-required"],
        [true, true, GRANTED, "ready", undefined],
      ] as const;
      for (const [supported, enabled, permissions, expected, refusal] of cases) {
        const world = { ...makeWorld(), supported, permissions };
        const r = yield* rig({ enabled, world });
        assert.equal((yield* r.executor.status).availability, expected);
        const started = yield* codeOf(r.executor.start(1, owner("A")));
        assert.equal(started, refusal);
        if (started === undefined) assert.equal((yield* r.executor.status).availability, "active");
      }
      const r = yield* rig();
      r.world.permissions = screenOnly;
      const refused = yield* r.executor.start(1, owner("A")).pipe(Effect.flip);
      assert.include(refused.message, "needs Accessibility permission");
      // A helper that cannot be asked names no permission as missing; clients say the check failed.
      r.world.permissionsFail = true;
      const unknown = yield* r.executor.status;
      assert.equal(unknown.availability, "permissions-required");
      assert.notProperty(unknown, "permissions");
      // A disabled feature never starts the helper to ask.
      const off = yield* rig({ enabled: false });
      assert.notProperty(yield* off.executor.status, "permissions");
      assert.equal(off.world.calls, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("lets one owner control the Mac across threads and instances", () =>
    Effect.gen(function* () {
      const first = yield* rig();
      const token = yield* first.executor.start(1, owner("Thread A"));
      assert.equal(yield* first.executor.start(1, owner("Thread A")), token);
      const otherThread = yield* first.executor.start(1, owner("Thread B")).pipe(Effect.flip);
      assert.equal(otherThread.code, "busy");
      assert.include(otherThread.message, '"Thread A"');
      // Another Gustaf instance finds the same lock.
      const second = yield* rig({ lock: first.lock });
      const otherInstance = yield* second.executor.start(1, owner("Thread C")).pipe(Effect.flip);
      assert.equal(otherInstance.code, "busy");
      assert.include(otherInstance.message, '"Thread A" in Gustaf Test');
      assert.deepEqual(second.log.started, []);

      yield* first.executor.stop(1, token);
      assert.equal((yield* first.executor.status).lastEndReason, "stopped-by-owner");
      yield* second.executor.start(1, owner("Thread C"));
    }).pipe(Effect.scoped),
  );

  it.effect("lets a stop that arrives while the Mac is being claimed win over the start", () =>
    Effect.gen(function* () {
      const r = yield* rig();
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      r.lock.pause = { entered, gate };
      const starting = yield* codeOf(r.executor.start(1, owner("A"))).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* r.executor.stop(1, undefined);
      yield* Deferred.succeed(gate, undefined);
      assert.equal(yield* Fiber.join(starting), "cancelled");
      assert.deepEqual(r.log.started, []);
      assert.isUndefined(r.lock.holder);
      assert.equal((yield* r.executor.status).availability, "ready");
    }).pipe(Effect.scoped),
  );

  it.effect("does not start a session without an emergency stop", () =>
    Effect.gen(function* () {
      const r = yield* rig();
      r.log.failStart = true;
      const refused = yield* r.executor.start(1, owner("A")).pipe(Effect.flip);
      assert.equal(refused.code, "emergency-stop-unavailable");
      assert.equal((yield* r.executor.status).availability, "ready");
      // The lock was not kept.
      assert.isUndefined(r.lock.holder);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels the rest of a drag on stop and releases the button", () =>
    Effect.gen(function* () {
      const drag: ComputerUseAction = {
        type: "drag",
        from: at("c1", 10, 10),
        to: at("c1", 600, 400),
      };
      const { rig: r, token, inputs } = yield* stoppedMidAction(drag, 2, true);
      // The step already posting finishes; the seven remaining drag steps never run.
      assert.deepEqual(
        inputs.map((input) =>
          input.kind === "move"
            ? input.dragging === undefined
              ? "move"
              : "drag"
            : input.kind === "button"
              ? input.down
                ? "down"
                : "up"
              : input.kind,
        ),
        ["move", "down", "drag", "up"],
      );
      assert.equal((yield* r.executor.status).lastEndReason, "stopped-by-user");
      // Nothing is accepted after the stop, screenshots included.
      assert.equal(
        yield* codeOf(r.executor.act(1, token, { type: "type", text: "x" })),
        "no-session",
      );
      assert.equal(yield* codeOf(r.executor.screenshot(1, token, {})), "no-session");
      assert.lengthOf(r.world.inputs, 4);
    }).pipe(Effect.scoped),
  );

  it.effect("releases keys held by a stopped shortcut in reverse", () =>
    Effect.gen(function* () {
      const shortcut: ComputerUseAction = { type: "key", keys: ["command", "shift", "s"] };
      const { inputs } = yield* stoppedMidAction(shortcut, 2, false);
      const up = (code: number): ComputerUseInput => ({ kind: "key", code, down: false, flags: 0 });
      assert.lengthOf(inputs, 6);
      assert.deepEqual(inputs.slice(3), [up(0x01), up(0x38), up(0x37)]);
    }).pipe(Effect.scoped),
  );

  it.effect("ends control when a permission is revoked", () =>
    Effect.gen(function* () {
      const r = yield* rig();
      const token = yield* r.executor.start(1, owner("A"));
      yield* r.executor.screenshot(1, token, {});
      r.world.permissions = { ...GRANTED, accessibility: false };
      const click: ComputerUseAction = { type: "click", at: at("c1", 1, 1) };
      assert.equal(yield* codeOf(r.executor.act(1, token, click)), "permission-required");
      const status = yield* r.executor.status;
      assert.equal(status.availability, "permissions-required");
      assert.equal(status.lastEndReason, "permission-revoked");
      assert.deepEqual(r.world.inputs, []);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a locked screen or system dialog instead of working around it", () =>
    Effect.gen(function* () {
      const app = (bundleId: string) => ({ name: "App", bundleId, pid: 1 });
      const click: ComputerUseAction = { type: "click", at: at("c1", 5, 5) };
      const typing: ComputerUseAction = { type: "type", text: "пароль" };
      const idle = { screenLocked: false, secureInput: false };
      // (probe, action, expected refusal, expected screen)
      const cases = [
        [{ ...idle, screenLocked: true }, click, "screen-locked", "locked"],
        [{ ...idle, app: app("com.apple.SecurityAgent") }, click, "system-dialog", "system-dialog"],
        [{ ...idle, secureInput: true }, typing, "secure-input", "secure-input"],
        [{ ...idle, secureInput: true }, click, undefined, "secure-input"],
        [{ ...idle, app: app("com.apple.TextEdit") }, typing, undefined, "available"],
      ] as const;
      for (const [probe, action, refusal, screen] of cases) {
        const r = yield* rig();
        const token = yield* r.executor.start(1, owner("A"));
        yield* r.executor.screenshot(1, token, {});
        r.world.probe = probe;
        assert.equal(yield* codeOf(r.executor.act(1, token, action)), refusal);
        assert.equal((yield* r.executor.context(1, token)).screen, screen);
      }
      const r = yield* rig();
      const token = yield* r.executor.start(1, owner("A"));
      r.world.probe = { ...idle, screenLocked: true };
      assert.equal(yield* codeOf(r.executor.screenshot(1, token, {})), "screen-locked");
    }).pipe(Effect.scoped),
  );

  it.effect("lands clicks where the screenshot shows them", () =>
    Effect.gen(function* () {
      const r = yield* rig();
      const token = yield* r.executor.start(1, owner("A"));
      const second = yield* r.executor.screenshot(1, token, { displayId: 2 });
      assert.deepEqual([second.captureId, second.width, second.height], ["c1", 1280, 720]);
      const main = yield* r.executor.screenshot(1, token, {});
      assert.deepEqual([main.displayId, main.width], [1, 1280]);
      yield* r.executor.act(1, token, { type: "click", at: at("c1", 0, 0), button: "right" });
      yield* r.executor.act(1, token, { type: "move", at: at("c2", 640, 400) });
      assert.deepEqual(r.world.inputs[1], {
        kind: "button",
        x: -1919.25,
        y: -199.25,
        button: "right",
        down: true,
        clicks: 1,
      });
      assert.deepEqual(r.world.inputs[3], { kind: "move", x: 720.5625, y: 450.5625 });

      const move = (captureId: string): ComputerUseAction => ({
        type: "move",
        at: at(captureId, 1, 1),
      });
      assert.equal(yield* codeOf(r.executor.act(1, token, move("c9"))), "stale-capture");
      r.world.displays[1] = display(2, 1440, -200, 1920, 1080, 1);
      assert.equal(yield* codeOf(r.executor.act(1, token, move("c1"))), "stale-capture");
      assert.lengthOf(r.world.inputs, 4);
    }).pipe(Effect.scoped),
  );

  it.effect("needs consent at the Mac to turn on, and stops control when turned off", () =>
    Effect.gen(function* () {
      const r = yield* rig({ enabled: false });
      r.log.decline = true;
      assert.equal(yield* codeOf(r.executor.setEnabled(true)), "declined");
      assert.equal((yield* r.executor.status).availability, "disabled");
      r.log.decline = false;
      yield* r.executor.setEnabled(true);
      const token = yield* r.executor.start(1, owner("A"));
      yield* r.executor.setEnabled(false);
      assert.equal((yield* r.executor.status).lastEndReason, "disabled");
      assert.deepEqual(r.log.saved, [true, false]);
      assert.equal(
        yield* codeOf(r.executor.act(1, token, { type: "type", text: "x" })),
        "no-session",
      );
      assert.equal(yield* codeOf(r.executor.start(1, owner("A"))), "disabled");
    }).pipe(Effect.scoped),
  );

  it.effect("stops from the Mac itself: the emergency shortcut and the menu bar", () =>
    Effect.gen(function* () {
      for (const reason of ["emergency-shortcut", "stopped-by-user"] as const) {
        const r = yield* rig();
        yield* r.executor.start(1, owner("A"));
        r.log.stop?.(reason);
        yield* Queue.take(r.ended);
        const status = yield* r.executor.status;
        assert.equal(status.availability, "ready");
        assert.equal(status.lastEndReason, reason satisfies ComputerUseEndReason);
        assert.isUndefined(r.lock.holder);
      }
    }).pipe(Effect.scoped),
  );
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeReply = Schema.decodeUnknownSync(ComputerUseExecutorReply);
const decodeEvent = Schema.decodeUnknownSync(ComputerUseExecutorEvent);

/** One backend run's end of the pipe: write a request line, read what comes back. */
const connectPipe = (
  executor: ComputerUseExecutor.ComputerUseExecutor["Service"],
  scope: Scope.Scope,
) =>
  Effect.gen(function* () {
    const connection = yield* executor.connect.pipe(Scope.provide(scope));
    const replies = yield* Queue.unbounded<Record<string, unknown>>();
    const events = yield* Queue.unbounded<Record<string, unknown>>();
    yield* connection.output.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        const value = decodeJson(line) as Record<string, unknown>;
        return Queue.offer("event" in value ? events : replies, value);
      }),
      Effect.forkIn(scope),
    );
    const request = (body: Readonly<Record<string, unknown>> | string) =>
      connection.handleLine(typeof body === "string" ? body : encodeJson(body));
    return { request, reply: Queue.take(replies), event: Queue.take(events) };
  });

describe("ComputerUseExecutor channel", () => {
  it.effect("answers only the backend run that started the session", () =>
    Effect.gen(function* () {
      const r = yield* rig();
      const first = yield* connectPipe(r.executor, yield* Scope.Scope);
      const second = yield* connectPipe(r.executor, yield* Scope.Scope);

      yield* first.request("not json");
      assert.deepEqual(yield* first.reply, {
        id: null,
        ok: false,
        error: { code: "invalid-request", message: "Malformed request." },
      });
      yield* first.request({ id: 1, op: "launch-missiles" });
      assert.deepInclude(yield* first.reply, { id: 1, ok: false });

      yield* first.request({ id: 2, op: "start", owner: owner("A") });
      const started = decodeReply(yield* first.reply);
      assert.isTrue(started.ok);
      const sessionToken = (started as { readonly result: { readonly sessionToken: string } })
        .result.sessionToken;
      const typing = { op: "act", sessionToken, action: { type: "type", text: "hi" } };
      // Another run, even with the token, cannot use this session.
      yield* second.request({ id: 3, ...typing });
      assert.deepInclude(yield* second.reply, { id: 3, ok: false });
      yield* first.request({ id: 4, ...typing, sessionToken: "guess" });
      const forged = decodeReply(yield* first.reply);
      assert.equal(!forged.ok && forged.error.code, "no-session");
      assert.deepEqual(r.world.inputs, []);
      yield* first.request({ id: 5, ...typing });
      assert.deepEqual(yield* first.reply, { id: 5, ok: true, result: null });
      assert.deepEqual(r.world.inputs, [{ kind: "text", text: "hi" }]);
    }).pipe(Effect.scoped),
  );

  it.effect("ends control when the backend run that owns it goes away", () =>
    Effect.gen(function* () {
      const r = yield* rig();
      const scope = yield* Scope.make();
      const pipe = yield* connectPipe(r.executor, scope);
      yield* pipe.request({ id: 1, op: "start", owner: owner("A") });
      assert.deepInclude(yield* pipe.reply, { id: 1, ok: true });
      assert.equal((yield* r.executor.status).availability, "active");
      yield* Scope.close(scope, Exit.void);
      const status = yield* r.executor.status;
      assert.equal(status.lastEndReason, "connection-lost");
      assert.notProperty(status, "owner");
      assert.isUndefined(r.lock.holder);
    }).pipe(Effect.scoped),
  );

  // The server decodes these with packages/contracts; the same file is its test.
  it.effect("speaks the shared contract samples", () =>
    Effect.gen(function* () {
      const r = yield* rig();
      const pipe = yield* connectPipe(r.executor, yield* Scope.Scope);
      yield* pipe.request({
        id: 1,
        op: "start",
        owner: { environmentId: "env-1", threadId: "thread-A", label: "A" },
      });
      const started = decodeReply(yield* pipe.reply);
      const sessionToken = (started as { readonly result: { readonly sessionToken: string } })
        .result.sessionToken;
      // Announced when the session started.
      const event = yield* pipe.event;
      assert.deepEqual(event, wire.status);
      assert.equal(decodeEvent(event).status.availability, "active");

      yield* pipe.request({ id: 7, op: "screenshot", sessionToken, displayId: 2 });
      assert.deepEqual(yield* pipe.reply, wire.screenshot);
      yield* pipe.request(encodeJson(wire.request).replace("SESSION", sessionToken));
      assert.deepEqual(yield* pipe.reply, { id: 3, ok: true, result: null });
      assert.lengthOf(r.world.inputs, 4);
    }).pipe(Effect.scoped),
  );
});
