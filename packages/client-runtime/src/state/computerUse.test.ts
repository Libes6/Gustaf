import { describe, expect, it } from "@effect/vitest";
import type { ComputerUseStatus } from "@t3tools/contracts";

import {
  type ComputerUseHolder,
  type ComputerUseRemoteView,
  type ComputerUseStep,
  computerUseErrorCode,
  computerUseErrorMessage,
  computerUseHasStopShortcut,
  computerUseHolder,
  computerUseIsOn,
  computerUseRemoteView,
  computerUseStep,
} from "./computerUse.ts";

const shortcut = "⌃⌥⌘⎋";
const owner = { environmentId: "env-1", threadId: "thread-1", label: "Fix the build" };
const granted = { screenRecording: true, accessibility: true };

const unsupported: ComputerUseStatus = { availability: "unsupported", emergencyShortcut: "" };
const disabled: ComputerUseStatus = { availability: "disabled", emergencyShortcut: shortcut };
const ready: ComputerUseStatus = {
  availability: "ready",
  permissions: granted,
  emergencyShortcut: shortcut,
};
const missing = (screenRecording: boolean, accessibility: boolean): ComputerUseStatus => ({
  availability: "permissions-required",
  permissions: { screenRecording, accessibility },
  emergencyShortcut: shortcut,
});
const unprobed: ComputerUseStatus = {
  availability: "permissions-required",
  emergencyShortcut: shortcut,
};
const activeFor = (who: Partial<typeof owner>): ComputerUseStatus => ({
  availability: "active",
  permissions: granted,
  owner: { ...owner, ...who },
  emergencyShortcut: shortcut,
});

describe("computerUseStep", () => {
  const cases: ReadonlyArray<readonly [string, ComputerUseStatus, ComputerUseStep]> = [
    ["no executor", unsupported, { kind: "unsupported" }],
    ["off: one Allow, confirmed at the Mac", disabled, { kind: "allow", confirmOnMac: true }],
    [
      "on and granted: Allow without permission steps",
      ready,
      { kind: "allow", confirmOnMac: false },
    ],
    [
      "both missing",
      missing(false, false),
      { kind: "grant", missing: ["screen-recording", "accessibility"] },
    ],
    [
      "only Screen Recording missing",
      missing(false, true),
      { kind: "grant", missing: ["screen-recording"] },
    ],
    [
      "only Accessibility missing",
      missing(true, false),
      { kind: "grant", missing: ["accessibility"] },
    ],
    [
      "macOS could not be asked: not reported as missing permissions",
      unprobed,
      { kind: "check-failed" },
    ],
    [
      "permissions-required with nothing missing is a failed check, not an empty grant step",
      missing(true, true),
      { kind: "check-failed" },
    ],
    [
      "this thread controls the Mac",
      activeFor({}),
      { kind: "active", here: true, label: "Fix the build" },
    ],
    [
      "another thread controls the Mac",
      activeFor({ threadId: "thread-2" }),
      { kind: "active", here: false, label: "Fix the build" },
    ],
    [
      "the same thread id in another environment",
      activeFor({ environmentId: "env-2" }),
      { kind: "active", here: false, label: "Fix the build" },
    ],
  ];

  it.each(cases)("%s", (_name, status, expected) => {
    expect(computerUseStep(status, "env-1", "thread-1")).toEqual(expected);
  });
});

describe("computerUseHolder", () => {
  const cases: ReadonlyArray<readonly [string, ComputerUseStatus, ComputerUseHolder]> = [
    ["nobody while idle", ready, "none"],
    ["nobody without an executor", unsupported, "none"],
    ["this thread", activeFor({}), "this-thread"],
    ["another thread", activeFor({ threadId: "thread-2" }), "other"],
    ["the same thread id in another environment", activeFor({ environmentId: "env-2" }), "other"],
  ];

  it.each(cases)("%s", (_name, status, expected) => {
    expect(computerUseHolder(status, "env-1", "thread-1")).toBe(expected);
  });
});

describe("computerUseRemoteView", () => {
  const cases: ReadonlyArray<readonly [string, ComputerUseStatus, ComputerUseRemoteView]> = [
    ["no executor is said outright", unsupported, { kind: "unsupported" }],
    ["off is for the person at the Mac to change", disabled, { kind: "off" }],
    [
      "missing permissions are granted at the Mac",
      missing(false, true),
      { kind: "grant-at-mac", missing: ["screen-recording"] },
    ],
    ["unprobed permissions are not reported missing", unprobed, { kind: "check-failed" }],
    ["ready", ready, { kind: "ready" }],
    ["active shows whose session it is", activeFor({}), { kind: "active", label: "Fix the build" }],
  ];

  it.each(cases)("%s", (_name, status, expected) => {
    expect(computerUseRemoteView(status)).toEqual(expected);
  });
});

describe("computerUseIsOn", () => {
  it.each([
    [unsupported, false],
    [disabled, false],
    [unprobed, true],
    [ready, true],
    [activeFor({}), true],
  ] as const)("%j", (status, expected) => {
    expect(computerUseIsOn(status)).toBe(expected);
  });

  it("an environment without an executor has no emergency shortcut to mention", () => {
    expect(computerUseHasStopShortcut(unsupported)).toBe(false);
    expect(computerUseHasStopShortcut(ready)).toBe(true);
  });
});

describe("computerUseErrorMessage", () => {
  it("reads the code off a ComputerUseError and nothing else", () => {
    const refusal = { _tag: "ComputerUseError", code: "busy", message: "agent-facing English" };
    expect(computerUseErrorCode(refusal)).toBe("busy");
    expect(computerUseErrorCode(new Error("busy"))).toBeNull();
    expect(computerUseErrorCode({ _tag: "RpcClientError", code: "busy" })).toBeNull();
    expect(computerUseErrorMessage(refusal)).toBe(
      "The Mac is already controlled by another thread. Stop it first.",
    );
    expect(computerUseErrorMessage(new Error("boom"))).toBe("Something went wrong. Try again.");
  });
});
