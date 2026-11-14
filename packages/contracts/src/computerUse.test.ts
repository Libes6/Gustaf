import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  ComputerUseAction,
  ComputerUseExecutorEvent,
  ComputerUseExecutorReply,
  ComputerUseExecutorRequest,
  ComputerUseExecutorScreenshot,
} from "./computerUse.ts";
import wire from "./computerUse.wire.json" with { type: "json" };

const decodeRequest = Schema.decodeUnknownSync(ComputerUseExecutorRequest);
const decodeEvent = Schema.decodeUnknownSync(ComputerUseExecutorEvent);
const decodeReply = Schema.decodeUnknownSync(ComputerUseExecutorReply);
const decodeScreenshot = Schema.decodeUnknownSync(ComputerUseExecutorScreenshot);
const decodeAction = Schema.decodeUnknownSync(ComputerUseAction);

// The shell's own test checks it produces exactly these lines (computer_use/tests.rs).
describe("computer-use executor wire", () => {
  it("decodes what the shell sends and accepts what the server sends", () => {
    const { id: _id, token: _token, ...request } = wire.request;
    expect(decodeRequest(request)).toEqual(request);
    expect(decodeEvent(wire.status).status.owner?.label).toBe("A");
    const reply = decodeReply(wire.screenshot);
    expect(reply.ok && decodeScreenshot(reply.result)).toMatchObject({
      captureId: "c1",
      bounds: { x: -1920, y: -200 },
    });
    const failure = decodeReply(wire.failure);
    expect(!failure.ok && failure.error.code).toBe("unauthorized");
    expect(() =>
      decodeAction({ type: "click", at: { captureId: "c1", x: 1, y: 1 }, count: 9 }),
    ).toThrow();
  });
});
