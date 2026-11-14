import { describe, expect, it } from "@effect/vitest";
import type { ComputerUseStatus } from "@t3tools/contracts";

import { type ComputerUseStep, computerUseStep } from "./computerUse.ts";

const shortcut = "⌃⌥⌘⎋";
const owner = { environmentId: "env-1", threadId: "thread-1", label: "Fix the build" };

describe("computerUseStep", () => {
  const cases: ReadonlyArray<readonly [string, ComputerUseStatus, ComputerUseStep]> = [
    [
      "no executor",
      { availability: "unsupported", emergencyShortcut: "" },
      { kind: "unsupported" },
    ],
    [
      "off: one Allow, confirmed at the Mac",
      { availability: "disabled", emergencyShortcut: shortcut },
      { kind: "allow", confirmOnMac: true },
    ],
    [
      "on and granted: Allow without permission steps",
      {
        availability: "ready",
        permissions: { screenRecording: true, accessibility: true },
        emergencyShortcut: shortcut,
      },
      { kind: "allow", confirmOnMac: false },
    ],
    [
      "both missing",
      {
        availability: "permissions-required",
        permissions: { screenRecording: false, accessibility: false },
        emergencyShortcut: shortcut,
      },
      { kind: "grant", missing: ["screen-recording", "accessibility"] },
    ],
    [
      "only Screen Recording missing",
      {
        availability: "permissions-required",
        permissions: { screenRecording: false, accessibility: true },
        emergencyShortcut: shortcut,
      },
      { kind: "grant", missing: ["screen-recording"] },
    ],
    [
      "only Accessibility missing",
      {
        availability: "permissions-required",
        permissions: { screenRecording: true, accessibility: false },
        emergencyShortcut: shortcut,
      },
      { kind: "grant", missing: ["accessibility"] },
    ],
    [
      "macOS could not be asked: not reported as missing permissions",
      { availability: "permissions-required", emergencyShortcut: shortcut },
      { kind: "check-failed" },
    ],
    [
      "this thread controls the Mac",
      { availability: "active", owner, emergencyShortcut: shortcut },
      { kind: "active", here: true, label: "Fix the build" },
    ],
    [
      "another thread controls the Mac",
      {
        availability: "active",
        owner: { ...owner, threadId: "thread-2" },
        emergencyShortcut: shortcut,
      },
      { kind: "active", here: false, label: "Fix the build" },
    ],
    [
      "the same thread id in another environment",
      {
        availability: "active",
        owner: { ...owner, environmentId: "env-2" },
        emergencyShortcut: shortcut,
      },
      { kind: "active", here: false, label: "Fix the build" },
    ],
  ];

  it.each(cases)("%s", (_name, status, expected) => {
    expect(computerUseStep(status, "env-1", "thread-1")).toEqual(expected);
  });
});
