// The real transport of the helper host: `node gustaf-host-<hash>.mjs <package dir>` started through
// providers/processHost.ts, so it is in the process ledger (killed on quit and after a crash) and stops gracefully.

import { openJsonProcess } from "../providers/processHost";
import { HOST_SCRIPT } from "./hostScript";
import type { HelperHost, HostTransport } from "./helperHost";
import { createHelperHost } from "./helperHost";
import type { CommandRunner } from "./runner";
import { scriptHash } from "./scriptHash";

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function createProcessHelperHost(o: {
  run: CommandRunner;
  dir: string;
  node: string;
  stateEnv?: string;
}): HelperHost {
  const file = `${o.dir}/gustaf-host-${scriptHash(HOST_SCRIPT)}.mjs`;
  const pkg = `${o.dir}/node_modules/agent-device`;
  let written: Promise<void> | undefined;
  const ensureFile = () =>
    (written ??= (async () => {
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(HOST_SCRIPT)));
      const r = await o.run(
        `test -f ${shq(file)} || ${shq(o.node)} -e 'require("fs").writeFileSync(process.argv[1],Buffer.from(process.argv[2],"base64"))' ${shq(file)} ${shq(b64)}`,
        { timeoutMs: 15_000 },
      );
      if (r.code !== 0) throw new Error(r.stderr.trim() || "could not write the helper host script");
    })().catch((e) => {
      written = undefined;
      throw e;
    }));
  return createHelperHost({
    async spawn() {
      await ensureFile();
      const proc = await openJsonProcess(`exec ${shq(o.node)} ${shq(file)} ${shq(pkg)}`);
      const t: HostTransport = {
        write: (l) => proc.write(l),
        onMessage: (cb) => proc.onMessage(cb),
        closed: proc.closed,
        stop: () => proc.stop(),
      };
      return t;
    },
  });
}
