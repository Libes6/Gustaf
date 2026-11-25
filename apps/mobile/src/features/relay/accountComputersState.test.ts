import type { RelayComputersResult } from "@t3tools/client-runtime/gustaf-relay";
import { describe, expect, it } from "vite-plus/test";

import { accountComputersView, canListAccountComputers } from "./accountComputersState";

const done = (result: RelayComputersResult) => ({ status: "done" as const, result });
const laptop = { deviceId: "laptop", name: "Laptop", online: true };
const signedIn = { status: "signedIn", phoneDeviceId: "phone" } as const;
const nothingConnected = new Set<string>();

describe("My computers", () => {
  it("names the step the user still has to take before it lists anything", () => {
    const load = done({ computers: [laptop] });
    expect(
      accountComputersView({
        account: { status: "signedOut", phoneDeviceId: null },
        load,
        connected: nothingConnected,
      }),
    ).toEqual({ kind: "signedOut" });
    expect(
      accountComputersView({
        account: { status: "signedIn", phoneDeviceId: null },
        load,
        connected: nothingConnected,
      }),
    ).toEqual({ kind: "unregistered" });
    expect(canListAccountComputers({ status: "signedIn", phoneDeviceId: null })).toBe(false);
    expect(canListAccountComputers(signedIn)).toBe(true);
  });

  it("asks a phone the relay turned away to register again, and lists otherwise", () => {
    expect(
      accountComputersView({
        account: signedIn,
        load: done({ computers: [], problem: "signed_out" }),
        connected: nothingConnected,
      }),
    ).toEqual({ kind: "unregistered" });
    expect(
      accountComputersView({
        account: signedIn,
        load: done({ computers: [laptop] }),
        connected: nothingConnected,
      }),
    ).toEqual({ kind: "list", computers: [laptop] });
  });
});
