import { generateNoiseKeyPair, relaySafetyCode } from "@t3tools/shared/relayNoise";
import { fromBase64Url, toBase64Url } from "@t3tools/shared/relayTunnel";
import { RelayTunnelClient } from "@t3tools/shared/relayTunnelClient";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  RELAY_CLIENT_KEY_STORAGE,
  RELAY_HOSTS_STORAGE,
  makeGustafRelayClient,
} from "./relayClient.ts";

const seeded = (seed: number) => (length: number) =>
  Uint8Array.from({ length }, (_, index) => (seed + index * 7) % 256);

function platform(storage: Map<string, string>) {
  return {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => void storage.set(key, value)),
    deviceToken: vi.fn(async () => "gdt_device"),
    relayUrl: vi.fn(async () => "https://cloud.test"),
    native: vi.fn(async () => ({ name: "Laptop", randomBytes: seeded(3) })),
  };
}

describe("Gustaf relay client", () => {
  it("creates this device's key once from the platform's randomness and keeps it", async () => {
    const storage = new Map<string, string>();
    const hostKey = toBase64Url(generateNoiseKeyPair(seeded(9)).publicKey);
    storage.set(
      RELAY_HOSTS_STORAGE,
      JSON.stringify({ host1: { relayUrl: "https://cloud.test", hostKey, hostName: "VM" } }),
    );
    const first = makeGustafRelayClient(platform(storage));
    const code = await first.safetyCodeFor("host1");
    const ownKey = generateNoiseKeyPair(seeded(3));
    expect(storage.get(RELAY_CLIENT_KEY_STORAGE)).toBe(toBase64Url(ownKey.secretKey));
    expect(code).toBe(relaySafetyCode(ownKey.publicKey, fromBase64Url(hostKey)));

    const again = platform(storage);
    expect(await makeGustafRelayClient(again).safetyCodeFor("host1")).toBe(code);
    expect(again.setItem).not.toHaveBeenCalled();
    expect(await makeGustafRelayClient(again).safetyCodeFor("other")).toBeNull();
  });

  it("refuses unknown links and computers it never paired with", async () => {
    const deps = platform(new Map());
    const client = makeGustafRelayClient(deps);
    await expect(client.pair("https://example.com/pair#token=X", () => {})).rejects.toThrow(
      "not a Gustaf relay code",
    );
    expect(deps.deviceToken).not.toHaveBeenCalled();
    await expect(client.tunnels.client("host1")).rejects.toThrow("not paired over the relay");
  });

  it("pairs with a computer picked from the account's list, keeping the key it presented", async () => {
    const storage = new Map<string, string>();
    const hostKey = generateNoiseKeyPair(seeded(9)).publicKey;
    const close = vi.fn();
    const connect = vi.spyOn(RelayTunnelClient, "connect").mockImplementation(async (options) => {
      options.onPending?.(hostKey);
      return {
        pairingToken: "ABC 123",
        remoteStaticKey: hostKey,
        close,
      } as unknown as RelayTunnelClient;
    });
    const client = makeGustafRelayClient(platform(storage));
    const codes: Array<string> = [];

    const link = await client.pairWithComputer({ deviceId: "Mac1", name: "Mac" }, (code) =>
      codes.push(code),
    );

    // First contact has no key to check, and it asks for the account pairing, never a link's.
    expect(connect.mock.calls[0]?.[0]).toMatchObject({
      hostDeviceId: "Mac1",
      hostKey: null,
      accountPairing: true,
      relayUrl: "https://cloud.test",
    });
    expect(connect.mock.calls[0]?.[0].pairingSecret).toBeUndefined();
    expect(connect.mock.calls[0]?.[0].peerLink).toBeUndefined();
    expect(link).toBe("https://mac1.relay.gustaf.invalid/pair#token=ABC%20123");
    expect(codes).toEqual([relaySafetyCode(generateNoiseKeyPair(seeded(3)).publicKey, hostKey)]);
    expect(JSON.parse(storage.get(RELAY_HOSTS_STORAGE)!)).toEqual({
      mac1: { relayUrl: "https://cloud.test", hostKey: toBase64Url(hostKey), hostName: "Mac" },
    });
    expect(close).toHaveBeenCalled();

    // A computer that answers without a code predates this pairing: nothing is saved for it.
    connect.mockImplementation(
      async () =>
        ({
          pairingToken: undefined,
          remoteStaticKey: hostKey,
          close,
        }) as unknown as RelayTunnelClient,
    );
    await expect(
      client.pairWithComputer({ deviceId: "old", name: "Old" }, () => {}),
    ).rejects.toMatchObject({ reason: "unknown_device" });
    expect(Object.keys(JSON.parse(storage.get(RELAY_HOSTS_STORAGE)!))).toEqual(["mac1"]);
    connect.mockRestore();
  });

  it("lists the account's computers as signed out when this device has no credential", async () => {
    const deps = platform(new Map());
    deps.deviceToken.mockRejectedValue(new Error("not registered"));
    expect(await makeGustafRelayClient(deps).computers()).toEqual({
      computers: [],
      problem: "signed_out",
    });
  });
});
