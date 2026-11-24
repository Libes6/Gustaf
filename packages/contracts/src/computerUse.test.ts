import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  COMPUTER_USE_UNSUPPORTED_STATUS,
  ComputerUseAction,
  ComputerUseExecutorEvent,
  ComputerUseExecutorReply,
  ComputerUseExecutorRequest,
  ComputerUseExecutorScreenshot,
  ComputerUseStatus,
  computerUseSupportsDriver,
} from "./computerUse.ts";
import wire from "./computerUse.wire.json" with { type: "json" };

const decodeRequest = Schema.decodeUnknownSync(ComputerUseExecutorRequest);
const decodeEvent = Schema.decodeUnknownSync(ComputerUseExecutorEvent);
const decodeReply = Schema.decodeUnknownSync(ComputerUseExecutorReply);
const decodeScreenshot = Schema.decodeUnknownSync(ComputerUseExecutorScreenshot);
const decodeAction = Schema.decodeUnknownSync(ComputerUseAction);
const decodeStatus = Schema.decodeUnknownSync(ComputerUseStatus);

// The desktop executor's tests read the same sample, so the two sides cannot drift.
describe("computer-use executor wire", () => {
  it("decodes what the executor sends and accepts what the server sends", () => {
    const { id: _id, ...request } = wire.request;
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

describe("computer-use availability", () => {
  it("has a valid status for environments without the desktop executor", () => {
    expect(decodeStatus(COMPUTER_USE_UNSUPPORTED_STATUS)).toEqual({
      availability: "unsupported",
      emergencyShortcut: "",
    });
  });

  it("only allows drivers whose runtime shows tool images to the model", () => {
    expect(["claudeAgent", "codex", "opencode", "pi"].every(computerUseSupportsDriver)).toBe(true);
    expect(computerUseSupportsDriver("cursor")).toBe(false);
  });
});
