// Builds and starts the native simulator helper (native/gustaf-sim.m): the source is compiled once with the Xcode
// command line tools that `simctl` already needs (no download), into `<helper dir>/native/gustaf-sim-<hash>`, and each
// simulator gets one long-lived process through providers/processHost.ts (ledger, graceful stop; the helper also exits
// by itself when its stdin closes). Nothing here asks for a system permission: the helper only talks to CoreSimulator.

import { openJsonProcess } from "../providers/processHost";
import { createNativeSim, type NativeSim } from "./nativeSim";
import { ensureNativeBinary } from "./nativeBuild";
import type { CommandRunner } from "./runner";

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function createProcessNativeSim(o: {
  run: CommandRunner;
  dir: string;
  node: string;
  source: string;
  onUnavailable?: (udid: string, reason: string) => void;
}): NativeSim {
  let binary: Promise<string> | undefined;
  return createNativeSim({
    onUnavailable: o.onUnavailable,
    async spawn(udid) {
      binary ??= ensureNativeBinary(o);
      const bin = await binary;
      const proc = await openJsonProcess(`exec ${shq(bin)} ${shq(udid)}`);
      return {
        write: (l) => proc.write(l),
        onMessage: (cb) => proc.onMessage(cb),
        closed: proc.closed,
        stop: () => proc.stop(),
      };
    },
  });
}
