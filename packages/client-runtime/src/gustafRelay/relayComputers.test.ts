import { EnvironmentId } from "@t3tools/contracts";
import { RelayTunnelClientError, relayVirtualBaseUrl } from "@t3tools/shared/relayTunnelClient";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

import { BearerConnectionProfile, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import {
  fetchRelayComputers,
  pairWithRelayComputer,
  pickableRelayComputers,
  relayComputersOfEnvironments,
  relayComputersView,
  relayPairingFailureMessage,
  startRelayComputerPairing,
  type RelayPairingProgress,
} from "./relayComputers.ts";

const answer = (status: number, body: unknown = {}) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const listing = {
  online: ["laptop"],
  computers: [
    { id: "laptop", name: "Laptop", online: true },
    { id: "desktop", name: "Desktop", online: false },
    { id: "me", name: "This Mac", online: true },
  ],
};

describe("account computers", () => {
  it("lists the computers with the device's own credential and leaves out the device itself", async () => {
    const fetchImpl = answer(200, listing);
    const result = await fetchRelayComputers({
      relayUrl: "https://cloud.test",
      deviceToken: "gdt_x",
      selfDeviceId: "me",
      fetch: fetchImpl,
    });
    expect(result).toEqual({
      computers: [
        { deviceId: "laptop", name: "Laptop", online: true },
        { deviceId: "desktop", name: "Desktop", online: false },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://cloud.test/v1/relay/hosts"),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer gdt_x" }),
      }),
    );
  });

  it("names a computer by its id for an API that only knows which are online", async () => {
    const result = await fetchRelayComputers({
      relayUrl: "https://cloud.test",
      deviceToken: "gdt_x",
      fetch: answer(200, { online: ["abcd1234ef567890"] }),
    });
    expect(result.computers).toEqual([
      { deviceId: "abcd1234ef567890", name: "Computer abcd1234", online: true },
    ]);
  });

  it("tells a signed-out device from a relay that did not answer", async () => {
    const request = (fetchImpl: typeof fetch) =>
      fetchRelayComputers({ relayUrl: "https://cloud.test", deviceToken: "t", fetch: fetchImpl });
    expect(await request(answer(401))).toEqual({ computers: [], problem: "signed_out" });
    expect(await request(answer(503))).toEqual({ computers: [], problem: "unavailable" });
    expect(
      await request(vi.fn(async () => Promise.reject(new TypeError("offline"))) as typeof fetch),
    ).toEqual({ computers: [], problem: "unavailable" });
  });

  it("offers online computers first and none this device already reaches through the relay", () => {
    const saved = (id: string, httpBaseUrl: string): ConnectionCatalogEntry => {
      const environmentId = EnvironmentId.make(`env-${id}`);
      return {
        target: new BearerConnectionTarget({ environmentId, label: id, connectionId: id }),
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: id,
            environmentId,
            label: id,
            httpBaseUrl,
            wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
          }),
        ),
        enabled: true,
      };
    };
    const connected = relayComputersOfEnvironments([
      saved("a", relayVirtualBaseUrl("Desktop")),
      saved("b", "http://192.168.1.2:3773/"),
    ]);
    expect([...connected]).toEqual(["desktop"]);
    expect(
      pickableRelayComputers(
        [
          { deviceId: "zed", name: "Zed", online: false },
          { deviceId: "desktop", name: "Desktop", online: true },
          { deviceId: "laptop", name: "Laptop", online: true },
          { deviceId: "alpha", name: "Alpha", online: false },
        ],
        connected,
      ).map((computer) => computer.deviceId),
    ).toEqual(["laptop", "alpha", "zed"]);
  });
});

describe("the list of account computers", () => {
  const laptop = { deviceId: "laptop", name: "Laptop", online: true };
  const desktop = { deviceId: "desktop", name: "Desktop", online: false };
  const done = (result: Parameters<typeof relayComputersView>[0] & { status: "done" }) => result;
  it("shows the state of the read, and the computers not yet connected, online ones first", () => {
    const none = new Set<string>();
    expect(relayComputersView({ status: "loading" }, none)).toEqual({ kind: "loading" });
    expect(
      relayComputersView(
        done({ status: "done", result: { computers: [], problem: "signed_out" } }),
        none,
      ),
    ).toEqual({ kind: "signedOut" });
    expect(
      relayComputersView(
        done({ status: "done", result: { computers: [], problem: "unavailable" } }),
        none,
      ),
    ).toEqual({ kind: "unavailable" });
    const all = { status: "done", result: { computers: [desktop, laptop] } } as const;
    expect(relayComputersView(all, none)).toEqual({ kind: "list", computers: [laptop, desktop] });
    expect(relayComputersView(all, new Set(["laptop"]))).toEqual({
      kind: "list",
      computers: [desktop],
    });
    expect(relayComputersView(all, new Set(["laptop", "desktop"]))).toEqual({ kind: "empty" });
  });
});

describe("pairing from the account's computers", () => {
  const computer = { deviceId: "laptop", name: "Laptop", online: true };
  const failure = (reason: RelayTunnelClientError["reason"]) =>
    new RelayTunnelClientError(reason, "raw");

  it("says what to do about each way the relay or the computer can refuse", () => {
    const message = (reason: RelayTunnelClientError["reason"]) =>
      relayPairingFailureMessage(failure(reason), "Laptop");
    expect(message("host_offline")).toContain("Laptop is not connected");
    expect(message("host_offline")).toContain("same Gustaf account");
    expect(message("unauthorized")).toContain("not signed in to the Gustaf relay");
    expect(message("rejected")).toContain("did not allow this device");
    expect(message("busy")).toContain("already has requests waiting");
    // A computer from before account pairing answers a new device with unknown_device.
    expect(message("unknown_device")).toContain("Update Gustaf there");
    expect(message("handshake_failed")).toContain("secure connection to Laptop failed");
    expect(relayPairingFailureMessage(new Error("boom"), "Laptop")).toBe(
      "Pairing over the relay failed.",
    );
  });

  it("redeems the pairing at the computer's relay address once its user allowed it", async () => {
    const pairWithComputer = vi.fn(
      async (_computer: unknown, onPending: (code: string) => void) => {
        onPending("1234-5678");
        return "https://laptop.relay.gustaf.invalid/pair#token=T";
      },
    );
    const connect = vi.fn(async () => ({ ok: true, error: null }));
    const codes: Array<string> = [];
    const result = await pairWithRelayComputer({
      relay: { pairWithComputer },
      computer,
      routeFor: undefined,
      connect,
      onPending: (code) => codes.push(code),
    });
    expect(result).toEqual({ status: "paired" });
    expect(codes).toEqual(["1234-5678"]);
    expect(connect).toHaveBeenCalledWith(
      "https://laptop.relay.gustaf.invalid/pair#token=T",
      undefined,
    );
  });

  it("reports a refusal, a failed redeem and a cancel apart", async () => {
    const refused = await pairWithRelayComputer({
      relay: { pairWithComputer: async () => Promise.reject(failure("host_offline")) },
      computer,
      routeFor: undefined,
      connect: vi.fn(),
      onPending: () => {},
    });
    expect(refused).toMatchObject({ status: "failed" });
    expect(refused.status === "failed" && refused.message).toContain("Laptop is not connected");

    const redeemFailed = await pairWithRelayComputer({
      relay: { pairWithComputer: async () => "https://laptop.relay.gustaf.invalid/pair#token=T" },
      computer,
      routeFor: undefined,
      connect: async () => ({ ok: false, error: "That pairing code expired." }),
      onPending: () => {},
    });
    expect(redeemFailed).toEqual({ status: "failed", message: "That pairing code expired." });

    // The user backed out while the computer waited: not an error to show.
    const controller = new AbortController();
    const cancelled = await pairWithRelayComputer({
      relay: {
        pairWithComputer: async () => {
          controller.abort();
          throw failure("closed");
        },
      },
      computer,
      routeFor: undefined,
      connect: vi.fn(),
      onPending: () => {},
      signal: controller.signal,
    });
    expect(cancelled).toEqual({ status: "cancelled" });
  });

  it("reports connecting, the safety code, then settles; cancel ends a waiting attempt", async () => {
    const steps: Array<RelayPairingProgress> = [];
    const waiting = Promise.withResolvers<void>();
    const attempt = startRelayComputerPairing({
      relay: {
        pairWithComputer: (_computer, onPending, signal) =>
          new Promise<string>((_resolve, reject) => {
            onPending("1234-5678");
            waiting.resolve();
            signal?.addEventListener("abort", () => reject(failure("closed")));
          }),
      },
      computer,
      routeFor: undefined,
      connect: vi.fn(),
      onProgress: (progress) => steps.push(progress),
    });
    await waiting.promise;
    expect(steps).toEqual([
      { phase: "connecting", computer },
      { phase: "waiting", computer, safetyCode: "1234-5678" },
    ]);
    attempt.cancel();
    expect(await attempt.done).toEqual({ status: "cancelled" });
    expect(steps.at(-1)).toEqual({ phase: "idle" });

    const refused: Array<RelayPairingProgress> = [];
    const failed = startRelayComputerPairing({
      relay: { pairWithComputer: async () => Promise.reject(failure("rejected")) },
      computer,
      routeFor: undefined,
      connect: vi.fn(),
      onProgress: (progress) => refused.push(progress),
    });
    await failed.done;
    expect(refused.at(-1)).toMatchObject({ phase: "failed", computer });
  });
});
