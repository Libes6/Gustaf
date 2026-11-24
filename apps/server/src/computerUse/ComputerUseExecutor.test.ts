import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ComputerUseAction } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import wire from "../../../../packages/contracts/src/computerUse.wire.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ComputerUseExecutor from "./ComputerUseExecutor.ts";

/** The desktop's side of the fd pair: what it reads from the server and writes back. */
const fakeDesktop = Effect.gen(function* () {
  const toServer = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const fromServer = yield* Queue.unbounded<string>();
  const executor = yield* ComputerUseExecutor.makeChannel(Stream.fromQueue(toServer), (line) =>
    Queue.offer(fromServer, line),
  );
  return {
    executor,
    /** The next request the server wrote, as the desktop parses it. */
    received: Queue.take(fromServer).pipe(
      Effect.map((line) => {
        expect(line.endsWith("\n")).toBe(true);
        return JSON.parse(line) as { readonly id: number } & Record<string, unknown>;
      }),
    ),
    send: (value: unknown) =>
      Queue.offer(toServer, new TextEncoder().encode(`${JSON.stringify(value)}\n`)),
    close: Queue.end(toServer),
  };
});

const { id: _id, ...actRequest } = wire.request;
const keyAction = actRequest.action as ComputerUseAction;

describe("ComputerUseExecutor channel", () => {
  it.effect("speaks the desktop's wire format and matches replies to requests by id", () =>
    Effect.gen(function* () {
      const desktop = yield* fakeDesktop;
      const events = yield* desktop.executor.subscribe;

      const act = yield* desktop.executor
        .request({ op: "act", sessionToken: "SESSION", action: keyAction })
        .pipe(Effect.asVoid, Effect.flip, Effect.forkChild);
      const sentAct = yield* desktop.received;
      expect(sentAct).toEqual({ ...actRequest, id: sentAct.id });

      // A screenshot asked while the act waits is answered first: one channel, no queueing.
      const shot = yield* desktop.executor
        .request({ op: "screenshot", sessionToken: "SESSION" })
        .pipe(Effect.forkChild);
      const sentShot = yield* desktop.received;
      expect(sentShot.id).not.toBe(sentAct.id);
      yield* desktop.send({ ...wire.screenshot, id: sentShot.id });
      expect(yield* Fiber.join(shot)).toEqual(wire.screenshot.result);

      yield* desktop.send({ ...wire.failure, id: sentAct.id });
      expect(yield* Fiber.join(act)).toMatchObject({ code: "unauthorized" });

      yield* desktop.send(wire.status);
      expect(yield* PubSub.take(events)).toEqual({ _tag: "Status", status: wire.status.status });

      // A reply the server cannot read still ends its request instead of leaving it waiting.
      const odd = yield* desktop.executor
        .request({ op: "status" })
        .pipe(Effect.asVoid, Effect.flip, Effect.forkChild);
      const sentStatus = yield* desktop.received;
      yield* desktop.send({ id: sentStatus.id, ok: false, error: { code: "from-the-future" } });
      expect(yield* Fiber.join(odd)).toMatchObject({ code: "failed" });
    }).pipe(Effect.scoped),
  );

  it.effect("fails what waits and everything after once the desktop closes the channel", () =>
    Effect.gen(function* () {
      const desktop = yield* fakeDesktop;
      const events = yield* desktop.executor.subscribe;
      const waiting = yield* desktop.executor
        .request({ op: "screenshot", sessionToken: "SESSION" })
        .pipe(Effect.asVoid, Effect.flip, Effect.forkChild);
      yield* desktop.received;

      yield* desktop.close;
      expect(yield* PubSub.take(events)).toEqual({ _tag: "Disconnected" });
      expect((yield* Fiber.join(waiting)).code).toBe("failed");
      expect(
        (yield* Effect.flip(Effect.asVoid(desktop.executor.request({ op: "status" })))).code,
      ).toBe("failed");
    }).pipe(Effect.scoped),
  );

  it.effect("is unavailable without the desktop's fds, as on a VPS or in the CLI", () =>
    Effect.gen(function* () {
      const executor = yield* ComputerUseExecutor.ComputerUseExecutor;
      expect(executor.available).toBe(false);
      expect((yield* Effect.flip(Effect.asVoid(executor.request({ op: "status" })))).code).toBe(
        "unsupported",
      );
    }).pipe(
      Effect.provide(
        ComputerUseExecutor.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-computer-use-" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
});
