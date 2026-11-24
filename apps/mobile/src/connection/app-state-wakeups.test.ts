import { expect, it } from "vite-plus/test";

import { mobileApplicationActiveWakeup } from "./app-state-wakeups";

it.each([
  ["a short pause", 1_000, 5_000, null, "application-active-probe"],
  ["a long pause", 1_000, 11_000, null, "application-active-long"],
  ["no recorded pause", null, 11_000, null, "application-active-probe"],
  ["a long pause the service kept alive", 1_000, 60_000, 500, "application-active-probe"],
  ["a long pause the service joined late", 1_000, 60_000, 2_000, "application-active-long"],
] as const)("treats %s as %s", (_name, backgroundedAt, activeAt, keptAliveSince, wakeup) => {
  expect(mobileApplicationActiveWakeup(backgroundedAt, activeAt, keptAliveSince)).toBe(wakeup);
});
