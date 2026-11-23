import { useEffect, useState } from "react";

import { relaySafetyCodeFor } from "./relayTunnels";

/** The safety code for a computer paired over the relay, read from the keychain. */
export function useRelaySafetyCode(hostDeviceId: string | null): string | null {
  const [code, setCode] = useState<{ host: string; code: string | null } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The keys live in the keychain, read asynchronously.
  useEffect(() => {
    if (hostDeviceId === null) return;
    let cancelled = false;
    void relaySafetyCodeFor(hostDeviceId).then((next) => {
      if (!cancelled) setCode({ host: hostDeviceId, code: next });
    });
    return () => {
      cancelled = true;
    };
  }, [hostDeviceId]);
  return code !== null && code.host === hostDeviceId ? code.code : null;
}
