import { generateNoiseKeyPair, relaySafetyCode } from "@t3tools/shared/relayNoise";
import { fromBase64Url, toBase64Url } from "@t3tools/shared/relayTunnel";
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
});
