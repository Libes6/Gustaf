// Honest latency benchmark for the Device panel's driver, against a REAL booted iOS simulator.
//
//   node apps/desktop/scripts/device-bench.mjs --udid <simulator udid> [--modes baseline,host,human,native] [--runs 8]
//
// It drives the real driver (src/device/driver.ts) the way the panel and the agent tools do, through node child
// processes instead of Tauri, and prints a table: how long until a tap shows up in the next frame, how many frames per
// second a moving screen gives, and how long the interface map takes.
//
//   baseline  CLI helper per call, verified tap (settle + snapshots), simctl screenshots   (what shipped before)
//   host      the same verified calls through the long-lived helper host
//   human     host + the no-settle / no-snapshot input path (`driver.human`), simctl screenshots
//   human-cli the no-settle input path through the CLI helper (no host): isolates what the host saves
//   native    host + the native helper (CoreSimulator HID + framebuffer stream)
//
// SAFETY: it taps and opens Settings, so it only runs on a simulator whose name contains "Bench" (create a throwaway
// one: `xcrun simctl create "Gustaf Bench" "iPhone 17 Pro" <runtime id>`), unless --allow-any is passed. It never boots,
// shuts down or deletes anything. The helper's own state goes to a scratch folder (AGENT_DEVICE_STATE_DIR), so it does
// not touch an agent-device daemon somebody else is using.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

register('../tests/helpers/hooks.mjs', import.meta.url);
const { createDriver } = await import('../src/device/driver.ts');
const { createHelperHost } = await import('../src/device/helperHost.ts');
const { HOST_SCRIPT } = await import('../src/device/hostScript.ts');
const { createNativeSim } = await import('../src/device/nativeSim.ts');
const { ensureNativeBinary } = await import('../src/device/nativeBuild.ts');
const { scriptHash } = await import('../src/device/scriptHash.ts');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? true) : fallback;
};
const udid = opt('udid');
if (!udid) {
  console.error('usage: device-bench.mjs --udid <simulator udid> [--modes baseline,host,human,native] [--runs 8]');
  process.exit(2);
}
const runs = Number(opt('runs', 8));
const verbose = args.includes('--verbose');
const modes = String(opt('modes', 'baseline,host,human,native')).split(',');
const appData = opt('app-data', join(homedir(), 'Library/Application Support/io.github.libes6.gustaf'));
const stateDir = mkdtempSync(join(tmpdir(), 'gustaf-bench-state-'));
const helperDir = `${appData}/device-helper`;

const simName = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8' })).devices;
const found = Object.values(simName)
  .flat()
  .find((d) => d.udid.toLowerCase() === udid.toLowerCase());
if (!found) throw new Error(`no such simulator: ${udid}`);
if (found.state !== 'Booted') throw new Error(`${found.name} is not booted`);
if (!/bench/i.test(found.name) && !args.includes('--allow-any'))
  throw new Error(
    `refusing to tap on "${found.name}": the bench only runs on a simulator named "...Bench..." (or pass --allow-any)`,
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, AGENT_DEVICE_STATE_DIR: stateDir };

/** CommandRunner over zsh, like shellRunner.ts without Tauri. */
const run = (script, o = {}) =>
  new Promise((resolve) => {
    const p = spawn('/bin/zsh', ['-c', script], { env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = o.timeoutMs ? setTimeout(() => ((timedOut = true), p.kill('SIGKILL')), o.timeoutMs) : undefined;
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.replace(/\n$/, ''), stderr, ...(timedOut ? { timedOut } : {}) });
    });
  });

const transports = [];
function lineTransport(cmd, cmdArgs) {
  const p = spawn(cmd, cmdArgs, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let listener;
  const queued = [];
  createInterface({ input: p.stdout }).on('line', (l) => {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    if (listener) listener(m);
    else queued.push(m);
  });
  const closed = new Promise((r) => p.on('close', r));
  const t = {
    write: async (l) => void p.stdin.write(l + '\n'),
    onMessage(cb) {
      listener = cb;
      queued.splice(0).forEach(cb);
    },
    closed,
    stop: async () => void p.kill('SIGTERM'),
  };
  transports.push(t);
  return t;
}

async function writeHostScript() {
  const file = `${stateDir}/gustaf-host-${scriptHash(HOST_SCRIPT)}.mjs`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, HOST_SCRIPT);
  return file;
}

async function makeDriver(mode) {
  const common = { run, appDataDir: appData, sleep };
  if (mode === 'baseline' || mode === 'human-cli') return { driver: createDriver(common), cleanup: async () => {} };
  const hostFile = await writeHostScript();
  const host = createHelperHost({
    spawn: async () => lineTransport('node', [hostFile, `${helperDir}/node_modules/agent-device`]),
  });
  if (mode === 'host' || mode === 'human')
    return { driver: createDriver({ ...common, host }), cleanup: () => host.close() };
  const source = readFileSync(new URL('../src/device/native/gustaf-sim.m', import.meta.url), 'utf8');
  const bin = await ensureNativeBinary({ run, dir: helperDir, node: 'node', source });
  const native = createNativeSim({ spawn: async (id) => lineTransport(bin, [id]) });
  return {
    driver: createDriver({ ...common, host, native }),
    cleanup: async () => (await host.close(), await native.closeAll()),
  };
}

const stats = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return { med: NaN, p90: NaN, n: 0 };
  return { med: v[Math.floor(v.length / 2)], p90: v[Math.min(v.length - 1, Math.floor(v.length * 0.9))], n: v.length };
};
const fmt = (s, unit = 'ms') => (s.n ? `${Math.round(s.med)}${unit} (p90 ${Math.round(s.p90)})` : 'n/a');

/** Keeps asking the driver for frames back to back, like the panel does (burst rate) and tells subscribers about each. */
function watchFrames(driver) {
  let stop = false;
  let last;
  let captures = 0;
  let distinct = 0;
  const subs = new Set();
  const loop = (async () => {
    while (!stop) {
      const f = await driver.frame(udid).catch(() => undefined);
      if (!f) {
        await sleep(50);
        continue;
      }
      const t = performance.now();
      captures++;
      const changed = last !== undefined && f.data !== last;
      if (verbose && changed) process.stderr.write(`  frame changed at ${Math.round(t)} (${f.data.length} chars)\n`);
      if (changed) distinct++;
      last = f.data;
      for (const s of [...subs]) s({ t, changed });
    }
  })();
  return {
    subs,
    counts: () => ({ captures, distinct }),
    async stop() {
      stop = true;
      await Promise.race([loop, sleep(3000)]);
    },
    /** Resolves with the time of the next frame that differs from the previous one. */
    nextChange: (timeoutMs = 4000) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => (subs.delete(cb), resolve(null)), timeoutMs);
        const cb = ({ t, changed }) => {
          if (!changed) return;
          clearTimeout(timer);
          subs.delete(cb);
          resolve(t);
        };
        subs.add(cb);
      }),
    /** Resolves when no frame changed for `quietMs`. */
    /** Resolves when at least two frames in a row were identical and nothing changed for `quietMs`. */
    async quiet(quietMs = 700, maxMs = 12000) {
      const end = performance.now() + maxMs;
      while (performance.now() < end) {
        const seen = captures;
        if ((await this.nextChange(quietMs)) === null && captures - seen >= 2) return true;
      }
      return false;
    },
  };
}

const resetSettings = () => {
  execFileSync('xcrun', ['simctl', 'launch', '--terminate-running-process', udid, 'com.apple.Preferences'], {
    stdio: 'ignore',
  });
};

async function measure(mode) {
  const { driver, cleanup } = await makeDriver(mode);
  const out = { mode };
  try {
    const verified = mode === 'baseline' || mode === 'host';
    resetSettings();
    await sleep(1500);
    // Binds the helper session to Settings (an app opened by simctl alone is not followed by the helper).
    await driver.openApp(udid, 'com.apple.Preferences');
    const w = watchFrames(driver);
    await sleep(2500); // the native helper opens in the background; frames start flowing
    await w.quiet();
    // The element to tap: the first hittable row of the Settings list, found through the real map (not timed).
    let row;
    for (let attempt = 0; attempt < 6 && !row; attempt++) {
      const map = await driver.snapshot(udid);
      // A static destination (no spinner, no loading): "General" in the simulator's language.
      row = map.nodes.find(
        (n) =>
          n.hittable &&
          /^(General|Основные|Accessibility|Универсальный доступ)$/.test(n.label ?? '') &&
          n.rect.height > 30,
      );
      if (!row) await sleep(800);
    }
    if (!row) throw new Error('no tappable row found in Settings');
    const at = { x: Math.round(row.rect.x + row.rect.width / 2), y: Math.round(row.rect.y + row.rect.height / 2) };

    // 1. tap -> first changed frame
    const toFrame = [];
    const dispatched = [];
    for (let i = 0; i < runs; i++) {
      resetSettings();
      await sleep(1500);
      await w.quiet();
      const t0 = performance.now();
      if (verbose) process.stderr.write(`tap at ${Math.round(t0)}\n`);
      const change = w.nextChange(5000);
      const call = (verified ? driver.tap(udid, at) : driver.human.tap(udid, at))
        .then(() => performance.now() - t0)
        .catch(() => null);
      const t = await change;
      toFrame.push(t === null ? null : t - t0);
      dispatched.push(await call);
    }
    out.tapToFrame = stats(toFrame);
    out.tapCall = stats(dispatched);

    // 1b. a drag that scrolls the list: input -> first changed frame. Unlike a tap on a row this does not depend on how
    // fast the app reacts (UIKit delays row highlights, pushes animate later): it is the input + display pipeline.
    // Native: raw touches (down, a pause, then the first moves). Other modes: the swipe the panel would send.
    const toScroll = [];
    for (let i = 0; i < runs; i++) {
      resetSettings();
      await sleep(1500);
      await w.quiet();
      const raw = !verified && driver.human.touch && driver.streaming?.(udid);
      if (raw) driver.human.touch(udid, 'down', { x: 200, y: 650 });
      if (raw) await sleep(150);
      const t0 = performance.now();
      const change = w.nextChange(5000);
      let call;
      if (raw) {
        driver.human.touch(udid, 'move', { x: 200, y: 610 });
        driver.human.touch(udid, 'move', { x: 200, y: 540 });
      } else
        call = verified
          ? driver.swipe(udid, { x: 200, y: 650 }, { x: 200, y: 350 }, 250)
          : driver.human.swipe(udid, { x: 200, y: 650 }, { x: 200, y: 350 }, 250);
      const t = await change;
      toScroll.push(t === null ? null : t - t0);
      if (raw) driver.human.touch(udid, 'up', { x: 200, y: 540 });
      await call?.catch(() => undefined);
    }
    out.scrollToFrame = stats(toScroll);

    // 2. a moving screen: back-to-back drags while frames are consumed
    resetSettings();
    await sleep(1200);
    await w.quiet();
    const c0 = w.counts();
    const s0 = performance.now();
    if (!verified && driver.human.touch && driver.streaming?.(udid)) {
      // raw touch stream, 60 Hz, like a finger dragging up and down
      driver.human.touch(udid, 'down', { x: 200, y: 600 });
      for (let k = 0; performance.now() - s0 < 3000; k++) {
        driver.human.touch(udid, 'move', { x: 200, y: 450 + Math.sin(k / 8) * 150 });
        await sleep(16);
      }
      driver.human.touch(udid, 'up', { x: 200, y: 450 });
    } else {
      while (performance.now() - s0 < 3000)
        await (verified
          ? driver.swipe(udid, { x: 200, y: 600 }, { x: 200, y: 300 })
          : driver.human.swipe(udid, { x: 200, y: 600 }, { x: 200, y: 300 }, 120));
    }
    const secs = (performance.now() - s0) / 1000;
    const c1 = w.counts();
    out.captureFps = (c1.captures - c0.captures) / secs;
    out.changedFps = (c1.distinct - c0.distinct) / secs;
    out.streaming = driver.streaming?.(udid) === true;

    // 3. the interface map: right after an action, then again while nothing changed
    const cold = [];
    const warm = [];
    for (let i = 0; i < Math.min(runs, 5); i++) {
      await (verified ? driver.tap(udid, { x: 5, y: 5 }) : driver.human.tap(udid, { x: 5, y: 5 }));
      let t = performance.now();
      await driver.snapshot(udid);
      cold.push(performance.now() - t);
      t = performance.now();
      await driver.snapshot(udid);
      warm.push(performance.now() - t);
    }
    out.mapCold = stats(cold);
    out.mapWarm = stats(warm);
    await w.stop();
  } finally {
    await cleanup().catch(() => {});
    await driver.release(udid).catch(() => {});
  }
  return out;
}

const results = [];
for (const m of modes) {
  process.stderr.write(`running ${m}...\n`);
  try {
    results.push(await measure(m));
  } catch (e) {
    results.push({ mode: m, error: e instanceof Error ? e.message : String(e) });
  }
}

const rows = [
  [
    'mode',
    'drag start -> changed frame',
    'tap on a row -> changed frame',
    'tap call returns',
    'frame captures/s',
    'changed frames/s (moving)',
    'map after action',
    'map unchanged',
  ],
];
for (const r of results) {
  if (r.error) rows.push([r.mode, `ERROR: ${r.error}`, '', '', '', '', '', '']);
  else
    rows.push([
      r.mode + (r.streaming ? ' (streaming)' : ''),
      fmt(r.scrollToFrame),
      fmt(r.tapToFrame),
      fmt(r.tapCall),
      r.captureFps.toFixed(1),
      r.changedFps.toFixed(1),
      fmt(r.mapCold),
      fmt(r.mapWarm),
    ]);
}
const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
for (const [i, r] of rows.entries()) {
  console.log('| ' + r.map((c, j) => String(c).padEnd(widths[j])).join(' | ') + ' |');
  if (i === 0) console.log('|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|');
}
console.log(
  `\nsimulator: ${found.name}, runs: ${runs}, load average at the end: ${loadavg()
    .map((x) => x.toFixed(1))
    .join(' ')}, state dir: ${stateDir}`,
);
process.exit(0);
