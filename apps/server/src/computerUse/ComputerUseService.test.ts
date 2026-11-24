import {
  ComputerUseError,
  type ComputerUseExecutorRequest,
  type ComputerUseOwner,
  type ComputerUseStatus,
  EnvironmentId,
  type OrchestrationV2DomainEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ComputerUseExecutor from "./ComputerUseExecutor.ts";
import * as ComputerUseService from "./ComputerUseService.ts";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const claude = ProviderInstanceId.make("claude");
const cursor = ProviderInstanceId.make("cursor");
const removed = ProviderInstanceId.make("removed");
const callerA = { threadId: threadA, providerInstanceId: claude };
const callerB = { threadId: threadB, providerInstanceId: claude };
const click = { type: "click" as const, at: { captureId: "c1", x: 10, y: 10 } };

const noSession = () =>
  new ComputerUseError({ code: "no-session", message: "This computer-use session has ended." });

/** The desktop's executor as the server sees it: one session, owned by a token. */
const makeFakeDesktop = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<ComputerUseExecutor.ComputerUseExecutorEvent>();
  const stopReceived = yield* Deferred.make<void>();
  const statusAskedAfterEnd = yield* Deferred.make<void>();
  const sent: Array<ComputerUseExecutorRequest> = [];
  let session: { readonly owner: ComputerUseOwner; readonly token: string } | undefined;
  let endedOnMac = false;
  let gone = false;
  let started = 0;

  const statusNow = (): ComputerUseStatus => ({
    availability: session === undefined ? "ready" : "active",
    permissions: { screenRecording: true, accessibility: true },
    ...(session === undefined ? {} : { owner: session.owner }),
    emergencyShortcut: "⌃⌥⌘⎋",
  });

  const request = (request: ComputerUseExecutorRequest) =>
    Effect.suspend((): Effect.Effect<unknown, ComputerUseError> => {
      sent.push(request);
      if (gone) return Effect.fail(new ComputerUseError({ code: "failed", message: "Gone." }));
      switch (request.op) {
        case "status":
          return (endedOnMac ? Deferred.succeed(statusAskedAfterEnd, undefined) : Effect.void).pipe(
            Effect.as(statusNow()),
          );
        case "start":
          if (session !== undefined && session.owner.threadId !== request.owner.threadId) {
            return Effect.fail(new ComputerUseError({ code: "busy", message: "Mac is busy." }));
          }
          session = { owner: request.owner, token: `session-${++started}` };
          return Effect.succeed({ sessionToken: session.token });
        case "stop":
          session = undefined;
          return Deferred.succeed(stopReceived, undefined).pipe(Effect.as(null));
        case "set-enabled":
        case "open-permission-settings":
          return Effect.succeed(statusNow());
        case "displays":
        case "context":
        case "screenshot":
        case "act": {
          if (session === undefined || request.sessionToken !== session.token) {
            return Effect.fail(noSession());
          }
          if (request.op === "displays") {
            return Effect.succeed([
              {
                id: 2,
                name: "Side",
                main: false,
                bounds: { x: -1920, y: -200, width: 1920, height: 1080 },
                scale: 1,
              },
            ]);
          }
          if (request.op === "context") return Effect.succeed({ screen: "available" });
          if (request.op === "screenshot") {
            return Effect.succeed({
              captureId: "c1",
              displayId: 2,
              bounds: { x: -1920, y: -200, width: 1920, height: 1080 },
              scale: 1,
              width: 1280,
              height: 720,
              mimeType: "image/png",
              data: "iVBORw0KGgo=",
            });
          }
          return Effect.succeed(null);
        }
      }
    });

  return {
    executor: ComputerUseExecutor.ComputerUseExecutor.of({
      available: true,
      request,
      subscribe: PubSub.subscribe(events),
    }),
    sent,
    acted: () => sent.filter((request) => request.op === "act" || request.op === "screenshot"),
    stopReceived,
    statusAskedAfterEnd,
    /** Stop in the menu bar or the emergency shortcut: the desktop ends it and tells the server. */
    endOnMac: () => {
      session = undefined;
      endedOnMac = true;
      return PubSub.publish(events, { _tag: "Status", status: statusNow() });
    },
    /** The desktop app quit or closed the channel. */
    disconnect: () =>
      Effect.suspend(() => {
        gone = true;
        return PubSub.publish(events, { _tag: "Disconnected" });
      }),
  };
});

const harness = Effect.fn("harness")(function* (options: { readonly available?: boolean } = {}) {
  const desktop = yield* makeFakeDesktop;
  const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const executor =
    options.available === false
      ? ComputerUseExecutor.ComputerUseExecutor.of({
          available: false,
          request: () => Effect.fail(ComputerUseExecutor.unavailableError()),
          subscribe: Effect.flatMap(
            PubSub.unbounded<ComputerUseExecutor.ComputerUseExecutorEvent>(),
            PubSub.subscribe,
          ),
        })
      : desktop.executor;
  const dependencies = Layer.mergeAll(
    Layer.succeed(ComputerUseExecutor.ComputerUseExecutor, executor),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadTitles: (threadIds) =>
        Effect.succeed(Object.fromEntries(threadIds.map((id) => [id, `Title of ${id}`]))),
      streamDomainEvents: Stream.fromQueue(domainEvents),
    }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (instanceId) =>
        Effect.succeed(
          instanceId === removed
            ? undefined
            : ({
                instanceId,
                driverKind: ProviderDriverKind.make(
                  instanceId === cursor ? "cursor" : "claudeAgent",
                ),
              } as ProviderInstance),
        ),
    }),
  );
  const context = yield* Layer.build(
    Layer.effect(ComputerUseService.ComputerUseService, ComputerUseService.make).pipe(
      Layer.provide(dependencies),
    ),
  );
  return {
    service: Context.get(context, ComputerUseService.ComputerUseService),
    desktop,
    domainEvents,
  };
});

const failureCode = <A, R>(effect: Effect.Effect<A, ComputerUseError, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.code));

describe("ComputerUseService", () => {
  it.effect("acts only for the thread the user allowed, checking every action", () =>
    Effect.gen(function* () {
      const { service, desktop } = yield* harness();
      expect(yield* failureCode(service.screenshot(callerA, {}))).toBe("not-allowed");

      const status = yield* service.allowThread(threadA);
      expect(status.owner).toEqual({
        environmentId: "env-1",
        threadId: threadA,
        label: `Title of ${threadA}`,
      });
      const shot = yield* service.screenshot(callerA, {});
      expect(shot.geometry).toMatchObject({ captureId: "c1", displayId: 2, width: 1280 });
      expect(shot.displays[0]?.bounds.x).toBe(-1920);
      yield* service.act(callerA, click);
      expect(desktop.sent.find((request) => request.op === "act")).toEqual({
        op: "act",
        sessionToken: "session-1",
        action: click,
      });

      // Another thread neither acts under A's session nor takes the Mac from it.
      expect(yield* failureCode(service.act(callerB, click))).toBe("not-allowed");
      expect(yield* failureCode(service.allowThread(threadB))).toBe("busy");
      expect(yield* failureCode(service.act(callerB, click))).toBe("not-allowed");
      expect(desktop.acted().map((request) => request.op)).toEqual(["screenshot", "act"]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses providers that cannot see screenshots before reaching the Mac", () =>
    Effect.gen(function* () {
      const { service, desktop } = yield* harness();
      yield* service.allowThread(threadA);
      const error = yield* Effect.flip(
        service.act({ threadId: threadA, providerInstanceId: cursor }, click),
      );
      expect(error.code).toBe("provider-unsupported");
      expect(error.message).toContain("cursor");
      expect(
        yield* failureCode(
          service.screenshot({ threadId: threadA, providerInstanceId: removed }, {}),
        ),
      ).toBe("provider-unsupported");
      expect(desktop.acted()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("the user's Stop ends control at once and nothing runs after it", () =>
    Effect.gen(function* () {
      const { service, desktop } = yield* harness();
      yield* service.allowThread(threadA);
      const status = yield* service.stop;
      expect(status.owner).toBeUndefined();
      // Tokenless: the desktop stops whatever runs, cutting a step in flight short.
      expect(desktop.sent.find((request) => request.op === "stop")).toEqual({ op: "stop" });
      expect(yield* failureCode(service.act(callerA, click))).toBe("not-allowed");
      expect(yield* failureCode(service.wait(callerA, 1))).toBe("not-allowed");
      expect(desktop.acted()).toEqual([]);
      // The Mac is free for another thread the user allows.
      expect((yield* service.allowThread(threadB)).owner?.threadId).toBe(threadB);
    }).pipe(Effect.scoped),
  );

  it.effect("the agent's own stop gives the Mac back with its session token", () =>
    Effect.gen(function* () {
      const { service, desktop } = yield* harness();
      yield* service.allowThread(threadA);
      expect(yield* failureCode(service.release(callerB))).toBe("not-allowed");
      yield* service.release(callerA);
      expect(desktop.sent.filter((request) => request.op === "stop")).toEqual([
        { op: "stop", sessionToken: "session-1" },
      ]);
      expect(yield* failureCode(service.act(callerA, click))).toBe("not-allowed");
    }).pipe(Effect.scoped),
  );

  it.effect("a stop on the Mac itself revokes the thread's permission", () =>
    Effect.gen(function* () {
      const { service, desktop } = yield* harness();
      yield* service.allowThread(threadA);
      yield* desktop.endOnMac();
      yield* Deferred.await(desktop.statusAskedAfterEnd);
      expect(yield* failureCode(service.act(callerA, click))).toBe("not-allowed");
      expect(desktop.acted()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("losing the desktop ends control and reads as unsupported", () =>
    Effect.gen(function* () {
      const { service, desktop } = yield* harness();
      yield* service.allowThread(threadA);
      yield* desktop.disconnect();
      const lost = yield* service.statusChanges.pipe(
        Stream.filter((status) => status.availability === "unsupported"),
        Stream.runHead,
      );
      expect(lost).toMatchObject({
        value: { availability: "unsupported", lastEndReason: "connection-lost" },
      });
      expect(yield* failureCode(service.act(callerA, click))).toBe("not-allowed");
    }).pipe(Effect.scoped),
  );

  it.effect("stopping or archiving the thread ends its control, not another thread's", () =>
    Effect.gen(function* () {
      const { service, desktop, domainEvents } = yield* harness();
      yield* service.allowThread(threadA);
      const event = (threadId: ThreadId, type: string, status?: string) =>
        ({
          type,
          threadId,
          ...(status === undefined ? {} : { payload: { status } }),
        }) as unknown as OrchestrationV2DomainEvent;
      yield* Queue.offer(domainEvents, event(threadB, "thread.archived"));
      yield* Queue.offer(domainEvents, event(threadA, "run.updated", "completed"));
      yield* Queue.offer(domainEvents, event(threadA, "run.updated", "interrupted"));
      yield* Deferred.await(desktop.stopReceived);
      expect(yield* failureCode(service.act(callerA, click))).toBe("not-allowed");
      expect(desktop.sent.filter((request) => request.op === "stop")).toEqual([{ op: "stop" }]);
    }).pipe(Effect.scoped),
  );

  it.effect("an ended executor session revokes the permission on the next action", () =>
    Effect.gen(function* () {
      const { service, desktop } = yield* harness();
      yield* service.allowThread(threadA);
      // The desktop ended it without telling; it answers with no-session.
      yield* desktop.executor.request({ op: "stop" });
      expect(yield* failureCode(service.act(callerA, click))).toBe("no-session");
      expect(yield* failureCode(service.act(callerA, click))).toBe("not-allowed");
    }).pipe(Effect.scoped),
  );

  it.effect("an environment without the desktop's executor reports unsupported", () =>
    Effect.gen(function* () {
      const { service } = yield* harness({ available: false });
      expect(service.available).toBe(false);
      expect((yield* service.status).availability).toBe("unsupported");
      expect(yield* failureCode(service.allowThread(threadA))).toBe("unsupported");
      expect(yield* failureCode(service.screenshot(callerA, {}))).toBe("unsupported");
    }).pipe(Effect.scoped),
  );
});
