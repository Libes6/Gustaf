import { useEffect, useState } from "react";

import type { AccountComputersLoad } from "./accountComputersState";
import { gustafRelay } from "./relayPool";

const LOADING: AccountComputersLoad = { status: "loading" };

/** The account's computers as the relay lists them, read while `enabled` and again on `refresh`. */
export function useAccountComputers(enabled: boolean) {
  const [load, setLoad] = useState<AccountComputersLoad>(LOADING);
  const [attempt, setAttempt] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The list lives on the relay and is read over the network.
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void gustafRelay.computers(controller.signal).then((result) => {
      if (!controller.signal.aborted) setLoad({ status: "done", result });
    });
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `attempt` only asks for another read.
  }, [enabled, attempt]);
  return {
    load,
    refresh: () => {
      setLoad(LOADING);
      setAttempt((count) => count + 1);
    },
  };
}
