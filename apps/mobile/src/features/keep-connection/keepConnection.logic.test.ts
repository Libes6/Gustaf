import { expect, it } from "vite-plus/test";

import { keepConnectionState } from "./keepConnection.logic";

it.each([
  [
    { supported: false, enabled: true, notificationsAllowed: true, environmentCount: 1 },
    "unsupported",
  ],
  [{ supported: true, enabled: false, notificationsAllowed: true, environmentCount: 1 }, "off"],
  [
    { supported: true, enabled: true, notificationsAllowed: false, environmentCount: 1 },
    "needs-permission",
  ],
  [{ supported: true, enabled: true, notificationsAllowed: true, environmentCount: 0 }, "idle"],
  [{ supported: true, enabled: true, notificationsAllowed: true, environmentCount: 2 }, "on"],
] as const)("resolves %j to %s", (input, state) => {
  expect(keepConnectionState(input)).toBe(state);
});
