import type { RelayComputersResult } from "@t3tools/client-runtime/gustaf-relay";
import { describe, expect, it } from "vite-plus/test";

import { accountComputersView, canListAccountComputers } from "./accountComputersState";

const laptop = { deviceId: "laptop", name: "Laptop", online: true };
const desktop = { deviceId: "desktop", name: "Desktop", online: false };
const done = (result: RelayComputersResult) => ({ status: "done" as const, result });
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

  it("lists online computers first and leaves out those already connected", () => {
    const load = done({
      computers: [desktop, laptop, { deviceId: "vps", name: "VPS", online: true }],
    });
    expect(accountComputersView({ account: signedIn, load, connected: new Set(["vps"]) })).toEqual({
      kind: "list",
      computers: [laptop, desktop],
    });
    expect(
      accountComputersView({
        account: signedIn,
        load,
        connected: new Set(["vps", "laptop", "desktop"]),
      }),
    ).toEqual({ kind: "empty" });
  });

  it("tells a relay that did not answer from a credential it turned down", () => {
    expect(
      accountComputersView({
        account: signedIn,
        load: done({ computers: [], problem: "unavailable" }),
        connected: nothingConnected,
      }),
    ).toEqual({ kind: "unavailable" });
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
        load: { status: "loading" },
        connected: nothingConnected,
      }),
    ).toEqual({ kind: "loading" });
  });
});
