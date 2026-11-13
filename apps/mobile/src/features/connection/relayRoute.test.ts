import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { connectRelayPairing } from "./relayRoute";

const LINK = "https://laptop.relay.gustaf.invalid/pair#token=CODE";
const SAVED = "env-laptop" as EnvironmentId;

it("adds the relay as a route to a computer the phone already saved", async () => {
  const connect = vi.fn(async (_url: string, environmentId: EnvironmentId | undefined) =>
    environmentId === undefined
      ? { ok: false, error: "Already saved.", alreadySaved: { environmentId: SAVED, address: "x" } }
      : { ok: true, error: null },
  );
  expect(await connectRelayPairing(LINK, undefined, connect)).toEqual({ ok: true, error: null });
  expect(connect.mock.calls).toEqual([
    [LINK, undefined],
    [LINK, SAVED],
  ]);

  const failing = vi.fn(async () => ({ ok: false, error: "Wrong code." }));
  expect(await connectRelayPairing(LINK, undefined, failing)).toEqual({
    ok: false,
    error: "Wrong code.",
  });
  expect(failing).toHaveBeenCalledTimes(1);
});
