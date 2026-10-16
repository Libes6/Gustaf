// Builds the native simulator helper (native/gustaf-sim.m): the source is compiled once with the Xcode command line
// tools that `simctl` already needs (no download), into `<helper dir>/native/gustaf-sim-<hash>`. Pure orchestration over
// the injected runner (no Tauri imports), so the bench script can use it too.

import type { CommandRunner } from "./runner";
import { scriptHash } from "./scriptHash";

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The path of the compiled helper, building it first when needed. Throws with a reason when that is not possible. */
export async function ensureNativeBinary(o: {
  run: CommandRunner;
  dir: string;
  node: string;
  source: string;
}): Promise<string> {
  const hash = scriptHash(o.source);
  const out = `${o.dir}/native`;
  const bin = `${out}/gustaf-sim-${hash}`;
  const have = await o.run(`test -x ${shq(bin)} && echo yes || echo no`, { timeoutMs: 10_000 });
  if (have.stdout.trim() === "yes") return bin;
  const tools = await o.run('[ "$(uname)" = Darwin ] && xcrun --find clang', { timeoutMs: 15_000 });
  if (tools.code !== 0) throw new Error("the Xcode command line tools are not available");
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(o.source)));
  const src = `${bin}.m`;
  const write = await o.run(
    `mkdir -p ${shq(out)} && ${shq(o.node)} -e 'require("fs").writeFileSync(process.argv[1],Buffer.from(process.argv[2],"base64"))' ${shq(src)} ${shq(b64)}`,
    { timeoutMs: 15_000 },
  );
  if (write.code !== 0) throw new Error(write.stderr.trim() || "could not write the helper source");
  const build = await o.run(
    `xcrun clang -fobjc-arc -O2 -framework Foundation -framework IOSurface -framework CoreGraphics -framework ImageIO ${shq(src)} -o ${shq(`${bin}.tmp`)} && mv ${shq(`${bin}.tmp`)} ${shq(bin)}`,
    { timeoutMs: 120_000 },
  );
  if (build.code !== 0) throw new Error(`compiling failed: ${(build.stderr || build.stdout).trim().slice(-200)}`);
  return bin;
}
