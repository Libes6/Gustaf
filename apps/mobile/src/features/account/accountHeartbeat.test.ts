import { describe, expect, it, vi } from "vite-plus/test";

import type { AccountApi } from "./accountApi";
import { createAccountHeartbeat, HEARTBEAT_INTERVAL_MS } from "./accountHeartbeat";

const REPORT = { appVersion: "1.4.0", platform: "android" as const, osVersion: "15" };

function setup(token: string | null = "gdt_phone") {
  let now = 0;
  const send = vi.fn<AccountApi["heartbeat"]>(() => Promise.resolve());
  const onError = vi.fn();
  const beat = createAccountHeartbeat({
    send,
    deviceToken: () => Promise.resolve(token),
    report: () => REPORT,
    now: () => now,
    onError,
  });
  return { beat, send, onError, advance: (ms: number) => (now += ms) };
}

describe("account heartbeat", () => {
  it("sends on launch, then on foreground only after a day", async () => {
    const { beat, send, advance } = setup();
    await beat();
    expect(send).toHaveBeenCalledWith("gdt_phone", REPORT);
    advance(HEARTBEAT_INTERVAL_MS - 1);
    await beat();
    expect(send).toHaveBeenCalledTimes(1);
    await beat({ force: true });
    expect(send).toHaveBeenCalledTimes(2);
    advance(HEARTBEAT_INTERVAL_MS);
    await beat();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("stays quiet without a registered phone and retries after a failure", async () => {
    const signedOut = setup(null);
    await signedOut.beat();
    expect(signedOut.send).not.toHaveBeenCalled();

    const { beat, send, onError } = setup();
    send.mockRejectedValueOnce(new Error("offline"));
    await beat();
    expect(onError).toHaveBeenCalledTimes(1);
    await beat();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
