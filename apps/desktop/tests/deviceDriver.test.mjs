// The device driver (src/device/driver.ts) against a fake command runner that replays output recorded from this Mac
// (iOS 26.2 simulator, agent-device 0.21.23: tests/fixtures/device-ios-helper.json, device-simctl.json) and, for Android,
// SYNTHETIC output written to the documented formats (tests/fixtures/device-android-synthetic.json): no Android device
// was available when the driver was written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { createDriver, HELPER_VERSION, guessPoints } = await import('../src/device/driver.ts');
const { imageInfo } = await import('../src/device/image.ts');
const { parseSimctlList, parseAdbDevices, parseAvdList, androidDevices } = await import('../src/device/lists.ts');
const { parseHelperReply, helperFailure } = await import('../src/device/helperOutput.ts');
const { KeyedQueue } = await import('../src/device/keyed.ts');
const { bundleForLabel, parseLanguages } = await import('../src/device/appNames.ts');
const { DeviceError } = await import('../src/device/types.ts');
const { parseSnapshot } = await import('../src/device/uiMap.ts');

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const ios = fx('device-ios-helper.json');
const sim = fx('device-simctl.json');
const droid = fx('device-android-synthetic.json');
const UDID = '22144834-F40F-4063-A585-2C2BB11A88C5';
const SERIAL = 'emulator-5554';
const ok = (stdout = '', extra = {}) => ({ code: 0, stdout, stderr: '', ...extra });
const json = (o) => ok(JSON.stringify(o));
const tick = () => new Promise((r) => setImmediate(r));

/**
 * A fake runner. `routes`: [regex on the script, reply | (script, opts) => reply], first match wins. Helper calls are
 * matched on `'<command>'` right after the agent-device path (`h('press')`). Every call is recorded in `calls`.
 */
function fakeRunner(routes) {
  const calls = [];
  // Like the real helper: a command other than `open` fails with SESSION_NOT_FOUND until its session was opened.
  const opened = new Set();
  const run = async (script, opts) => {
    calls.push({ script, opts });
    const cmd = /agent-device\.mjs' '([\w-]+)'.*'--session' '([^']+)'/.exec(script);
    if (cmd && cmd[1] === 'open') opened.add(cmd[2]);
    else if (cmd && cmd[1] !== 'close' && !opened.has(cmd[2])) return json(ios.sessionNotFound);
    if (cmd && cmd[1] === 'close') opened.delete(cmd[2]);
    for (const [re, reply] of routes)
      if (re.test(script)) return typeof reply === 'function' ? reply(script, opts) : reply;
    return { code: 127, stdout: '', stderr: `no route for: ${script.slice(0, 200)}` };
  };
  return { run, calls, helperCalls: (cmd) => calls.filter((c) => h(cmd).test(c.script)) };
}
const h = (cmd) => new RegExp(`agent-device\\.mjs' '${cmd}'`);
const HELPER_PRESENT = [/test -f .*agent-device\.mjs/, ok('yes\n')];

/** The Settings snapshot of the real fixture, with refs, as the helper returns it. */
const settingsSnapshot = () => ios.snapshot;
/** The same screen after a tap: other labels, so the diff is not empty. */
const changedSnapshot = () => {
  const s = structuredClone(ios.snapshot);
  s.data.nodes = s.data.nodes.filter((n) => n.label !== 'Основные');
  s.data.nodes.push({
    ...s.data.nodes.at(-1),
    index: 99,
    ref: 'e99',
    label: 'Новая страница',
    kind: 'cell',
    identifier: 'new.page',
  });
  return s;
};
const PNG = (w, h) => {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString('base64');
};

function iosDriver(extra = []) {
  const r = fakeRunner([
    HELPER_PRESENT,
    [
      h('open'),
      json({
        success: true,
        data: { appName: 'com.apple.springboard', appBundleId: 'com.apple.springboard', message: 'Opened' },
      }),
    ],
    [h('snapshot'), json(settingsSnapshot())],
    ...extra,
  ]);
  const d = createDriver({ run: r.run, appDataDir: '/data/app', sleep: async () => {}, quietMs: 0 });
  return { ...r, d };
}

// ---------- pure parsers ----------

test('image size from the first bytes: real JPEG and PNG headers of a simulator screenshot, synthetic PNG', () => {
  assert.deepEqual(imageInfo(sim.frameHead_jpeg), { mime: 'image/jpeg', size: { width: 1206, height: 2622 } });
  assert.deepEqual(imageInfo(sim.frameHead_png), { mime: 'image/png', size: { width: 1206, height: 2622 } });
  assert.deepEqual(imageInfo(PNG(1080, 2400)).size, { width: 1080, height: 2400 });
  assert.equal(imageInfo('bm90IGFuIGltYWdl'), null);
  assert.equal(imageInfo(''), null);
});

test('simctl list: real output gives the iOS simulators; other runtimes, unavailable and odd states are handled', () => {
  const real = parseSimctlList(sim.list);
  assert.deepEqual(real, [{ id: UDID, name: 'iPhone 17 Pro', platform: 'ios', state: 'booted', os: 'iOS 26.2' }]);
  // Synthetic additions: watchOS must not show, "Shutting Down" is unknown, an iPad on an older runtime sorts after booted.
  const j = JSON.parse(sim.list);
  j.devices['com.apple.CoreSimulator.SimRuntime.watchOS-11-0'] = [
    { udid: 'W', name: 'Watch', state: 'Shutdown', isAvailable: true },
  ];
  j.devices['com.apple.CoreSimulator.SimRuntime.iOS-18-6'] = [
    { udid: 'A', name: 'iPad Pro', state: 'Shutdown', isAvailable: true },
    { udid: 'B', name: 'iPhone 16', state: 'Shutting Down', isAvailable: true },
    { udid: 'C', name: 'Broken', state: 'Shutdown', isAvailable: false },
  ];
  const list = parseSimctlList(JSON.stringify(j));
  assert.deepEqual(
    list.map((d) => [d.name, d.state, d.os]),
    [
      ['iPhone 17 Pro', 'booted', 'iOS 26.2'],
      ['iPhone 16', 'unknown', 'iOS 18.6'],
      ['iPad Pro', 'shutdown', 'iOS 18.6'],
    ],
  );
  assert.deepEqual(parseSimctlList('not json'), []);
});

test('adb and emulator lists (synthetic): running, offline, unauthorized, usb; AVDs not running are shutdown devices', () => {
  const adb = parseAdbDevices(droid.adbDevices);
  assert.deepEqual(
    adb.map((e) => [e.serial, e.status, e.model, e.usb]),
    [
      [SERIAL, 'device', 'sdk_gphone64_arm64', false],
      ['R5CT123ABCD', 'device', 'SM_G973U', true],
      ['emulator-5556', 'offline', undefined, false],
      ['ZX1G22XYZ', 'unauthorized', undefined, true],
    ],
  );
  assert.deepEqual(parseAvdList(droid.avds), ['Pixel_8_API_35', 'Medium_Phone_API_36']);
  const list = androidDevices(adb, parseAvdList(droid.avds), {
    [SERIAL]: { avd: 'Pixel_8_API_35', release: '15' },
    R5CT123ABCD: { release: '14' },
  });
  const byId = Object.fromEntries(list.map((d) => [d.id, d]));
  assert.deepEqual(byId[SERIAL], {
    id: SERIAL,
    name: 'Pixel 8 API 35',
    platform: 'android',
    state: 'booted',
    os: 'Android 15',
  });
  assert.equal(byId.R5CT123ABCD.name, 'SM G973U');
  assert.equal(byId['emulator-5556'].state, 'booting');
  assert.equal(byId.ZX1G22XYZ.state, 'unknown');
  assert.equal(byId['avd:Pixel_8_API_35'], undefined, 'the running AVD is not listed twice');
  assert.deepEqual(byId['avd:Medium_Phone_API_36'], {
    id: 'avd:Medium_Phone_API_36',
    name: 'Medium Phone API 36',
    platform: 'android',
    state: 'shutdown',
  });
});

test('helper replies: success, error with reason, banner before JSON, nothing; stale ref and the other error codes', () => {
  assert.equal(parseHelperReply(JSON.stringify(ios.home)).ok, true);
  assert.equal(parseHelperReply('warning: update available\n' + JSON.stringify(ios.home)).ok, true);
  assert.equal(parseHelperReply('boom'), null);
  const stale = parseHelperReply(JSON.stringify(ios.staleRef));
  assert.equal(stale.ok, false);
  assert.equal(helperFailure(stale.error).code, 'stale-ref');
  const err = (e) => helperFailure({ message: 'x', ...e });
  assert.equal(err({ message: 'Ref @e3 is stale' }).code, 'stale-ref');
  assert.equal(err({ code: 'REF_NOT_FOUND' }).code, 'stale-ref');
  assert.equal(err({ code: 'COMMAND_TIMEOUT', message: 'timed out' }).code, 'timeout');
  assert.equal(err({ code: 'DEVICE_NOT_FOUND', message: 'No device' }).code, 'no-device');
  assert.equal(err({ message: 'adb not found in PATH, install it' }).code, 'toolchain');
  const busy = helperFailure(parseHelperReply(JSON.stringify(ios.deviceInUse)).error);
  assert.match(busy.message, /Another automation session holds this device/);
  assert.equal(helperFailure(parseHelperReply(JSON.stringify(ios.swipeOutOfBounds)).error).code, 'failed');
});

test('home-screen names: the simulator language and the English name both map to the bundle id', () => {
  const names = {
    'com.apple.Preferences': ['Settings', 'Настройки'],
    'com.apple.mobilesafari': ['Safari'],
    'com.apple.mobilecal': ['Calendar', 'Календарь'],
  };
  assert.equal(bundleForLabel(names, 'Настройки'), 'com.apple.Preferences');
  assert.equal(bundleForLabel(names, 'Settings, 2 notifications'), 'com.apple.Preferences');
  assert.equal(bundleForLabel(names, 'Safari'), 'com.apple.mobilesafari');
  assert.equal(bundleForLabel(names, 'Календарь'), 'com.apple.mobilecal');
  assert.equal(bundleForLabel(names, 'Unknown app'), undefined);
  assert.deepEqual(parseLanguages(sim.languages), ['ru-RU', 'en-RU', 'ak-RU']);
});

test('guessPoints: 3x for the iPhone width range, 2x otherwise', () => {
  assert.deepEqual(guessPoints({ width: 1206, height: 2622 }), { width: 402, height: 874 });
  assert.deepEqual(guessPoints({ width: 750, height: 1334 }), { width: 375, height: 667 });
  assert.deepEqual(guessPoints({ width: 2064, height: 2752 }), { width: 1032, height: 1376 });
});

test('KeyedQueue: one key runs in order even when an earlier one fails; keys do not wait for each other', async () => {
  const q = new KeyedQueue();
  const log = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const a = q.run('x', async () => (log.push('a1'), await gate, log.push('a2')));
  const b = q.run(
    'x',
    async () => (
      log.push('b'),
      (() => {
        throw new Error('boom');
      })()
    ),
  );
  const c = q.run('x', async () => log.push('c'));
  const other = q.run('y', async () => log.push('y'));
  await other;
  assert.deepEqual(log, ['a1', 'y']);
  release();
  await a;
  await assert.rejects(b, /boom/);
  await c;
  assert.deepEqual(log, ['a1', 'y', 'a2', 'b', 'c']);
  await tick();
  assert.equal(q.busy('x'), false);
});

// ---------- toolchain, list, boot ----------

test('toolchain: what is available, why not, helper installed vs pinned', async () => {
  const mk = (routes) => createDriver({ run: fakeRunner(routes).run, appDataDir: '/data/app' });
  const good = await mk([
    [/xcrun --find simctl/, ok('/usr/bin/simctl\n')],
    [/command -v adb/, ok('/sdk/platform-tools/adb\n')],
    [/cat .*package\.json/, ok(JSON.stringify({ version: '0.21.20' }))],
    [/-v$/, ok('v22.22.0\n')],
  ]).toolchain();
  assert.deepEqual(good.ios, { available: true });
  assert.deepEqual(good.android, { available: true });
  assert.deepEqual(good.helper, { installed: true, version: '0.21.20', pinned: HELPER_VERSION });

  const bad = await mk([
    [/xcrun --find simctl/, { code: 3, stdout: 'NOT_MAC\n', stderr: '' }],
    [/command -v adb/, { code: 1, stdout: '', stderr: '' }],
    [/cat .*package\.json/, { code: 1, stdout: '', stderr: 'No such file' }],
    [/-v$/, ok('v20.11.0\n')],
  ]).toolchain();
  assert.equal(bad.ios.available, false);
  assert.match(bad.ios.reason, /need a Mac/);
  assert.match(bad.android.reason, /adb was not found/);
  assert.equal(bad.helper.installed, false);
  assert.match(bad.helper.reason, /too old/);

  const noXcode = await mk([
    [/xcrun --find simctl/, { code: 1, stdout: '', stderr: 'xcrun: error: unable to find utility "simctl"' }],
    [/./, { code: 1, stdout: '', stderr: '' }],
  ]).toolchain();
  assert.match(noXcode.ios.reason, /xcode-select --install/);
  assert.match(noXcode.helper.reason, /Node\.js was not found/);
});

test('list: real simctl output plus synthetic adb output, merged and sorted; a missing platform gives nothing, not an error', async () => {
  const { d } = (() => {
    const r = fakeRunner([
      [/simctl list devices/, ok(sim.list)],
      [/adb devices -l/, ok(droid.adbDevices)],
      [/emulator -list-avds/, ok(droid.avds)],
      [/emu avd name/, ok(droid.emuAvdName)],
      [/getprop ro\.build\.version\.release/, ok(droid.release)],
    ]);
    return { d: createDriver({ run: r.run, appDataDir: '/d' }) };
  })();
  const list = await d.list();
  assert.deepEqual(
    list.map((x) => `${x.platform}:${x.name}:${x.state}`),
    [
      'android:Pixel 8 API 35:booted',
      'android:SM G973U:booted',
      'ios:iPhone 17 Pro:booted',
      'android:emulator-5556:booting',
      'android:ZX1G22XYZ:unknown',
      'android:Medium Phone API 36:shutdown',
    ],
  );
  const onlyIos = await createDriver({
    run: fakeRunner([
      [/simctl list devices/, ok(sim.list)],
      [/./, { code: 127, stdout: '', stderr: 'adb: command not found' }],
    ]).run,
    appDataDir: '/d',
  }).list();
  assert.equal(onlyIos.length, 1);
  assert.deepEqual(await createDriver({ run: fakeRunner([]).run, appDataDir: '/d' }).list(), []);
});

test('boot and shutdown: simctl boot then bootstatus; already booted is fine; AVDs start detached; shutdown releases the helper session', async () => {
  const { d, calls, helperCalls } = iosDriver([
    [/simctl boot '/, { code: 149, stdout: '', stderr: 'Unable to boot device in current state: Booted' }],
    [/simctl bootstatus/, ok()],
    [h('close'), json(ios.close)],
    [/simctl shutdown/, ok()],
  ]);
  await d.boot(UDID);
  assert.ok(calls.some((c) => /simctl bootstatus '22144834/.test(c.script)));
  await d.snapshot(UDID); // opens a helper session
  await d.shutdown(UDID);
  assert.equal(helperCalls('close').length, 1);
  assert.ok(calls.at(-1).script.includes(`simctl shutdown '${UDID}'`));

  const r = fakeRunner([[/emulator -avd/, ok()]]);
  await createDriver({ run: r.run, appDataDir: '/d' }).boot('avd:Pixel_8_API_35');
  assert.match(r.calls[0].script, /emulator -avd 'Pixel_8_API_35'$/);
  assert.equal(r.calls[0].opts.detached, true);

  const gone = createDriver({
    run: fakeRunner([[/simctl boot '/, { code: 164, stdout: '', stderr: 'Invalid device: NOPE' }]]).run,
    appDataDir: '/d',
  });
  await assert.rejects(gone.boot(UDID), (e) => e instanceof DeviceError && e.code === 'no-device');
});

// ---------- frame ----------

test('frame: JPEG through base64, size read from the header, points guessed from the pixels then learned from a snapshot', async () => {
  const { d, calls } = iosDriver([[/simctl io .* screenshot/, ok(sim.frameHead_jpeg + '\n')]]);
  const f = await d.frame(UDID);
  assert.equal(f.mime, 'image/jpeg');
  assert.deepEqual(f.pixels, { width: 1206, height: 2622 });
  assert.deepEqual(f.points, { width: 402, height: 874 });
  assert.equal(f.data, sim.frameHead_jpeg);
  assert.match(calls[0].script, /screenshot --type=jpeg - .*base64/);
  assert.equal(calls[0].opts.timeoutMs > 0, true);
  // Points from a snapshot win over the guess.
  await d.snapshot(UDID);
  const g = await d.frame(UDID);
  assert.deepEqual(g.points, { width: 402, height: 874 });
});

test('frame: PNG option, Android (pixels are the points), and a clear error when the device cannot be captured', async () => {
  const p = createDriver({
    run: fakeRunner([[/--type=png/, ok(sim.frameHead_png)]]).run,
    appDataDir: '/d',
    frameFormat: 'png',
  });
  assert.equal((await p.frame(UDID)).mime, 'image/png');
  const r = fakeRunner([[/exec-out screencap -p/, ok(PNG(1080, 2400))]]);
  const a = await createDriver({ run: r.run, appDataDir: '/d' }).frame(SERIAL);
  assert.deepEqual(a.pixels, { width: 1080, height: 2400 });
  assert.deepEqual(a.points, a.pixels);
  assert.match(r.calls[0].script, /adb -s 'emulator-5554' exec-out screencap -p \| base64/);
  const none = createDriver({
    run: fakeRunner([
      [/screenshot/, { code: 1, stdout: '', stderr: 'Invalid device state' }],
      [/./, ok()],
    ]).run,
    appDataDir: '/d',
  });
  await assert.rejects(none.frame(UDID), (e) => e.code === 'no-device' && /Invalid device state/.test(e.message));
});

test('frame calls in flight are shared; frame does not wait behind a slow snapshot', async () => {
  let releaseSnap;
  const snapGate = new Promise((r) => (releaseSnap = r));
  let shots = 0;
  const { d } = iosDriver([
    [h('snapshot'), async () => (await snapGate, json(settingsSnapshot()))],
    [/screenshot/, async () => (shots++, ok(sim.frameHead_jpeg))],
  ]);
  const snap = d.snapshot(UDID);
  await tick();
  const [a, b] = await Promise.all([d.frame(UDID), d.frame(UDID)]);
  assert.equal(shots, 1, 'two frame calls, one screenshot');
  assert.strictEqual(a, b);
  releaseSnap();
  await snap;
});

// ---------- helper: missing, install ----------

test('helper missing: every helper-backed call says so with the code, nothing is run', async () => {
  const r = fakeRunner([[/test -f/, ok('no\n')]]);
  const d = createDriver({ run: r.run, appDataDir: '/d' });
  for (const call of [
    () => d.snapshot(UDID),
    () => d.tap(UDID, { ref: 'e1' }),
    () => d.type(UDID, 'x'),
    () => d.openApp(UDID, 'Settings'),
  ])
    await assert.rejects(
      call(),
      (e) => e instanceof DeviceError && e.code === 'helper-missing' && /Install it once/.test(e.message),
    );
  assert.ok(
    r.calls.every((c) => /^test -f/.test(c.script)),
    'only the existence check ran',
  );
});

test('a damaged helper install (module not found) is reported as helper-missing and re-checked next time', async () => {
  const r = fakeRunner([
    HELPER_PRESENT,
    [h('open'), json({ success: true, data: {} })],
    [
      h('snapshot'),
      { code: 1, stdout: '', stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/dist/bin.js'" },
    ],
  ]);
  const d = createDriver({ run: r.run, appDataDir: '/d' });
  await assert.rejects(d.snapshot(UDID), (e) => e.code === 'helper-missing' && /damaged/.test(e.message));
});

test('installHelper: pinned npm install into <appDataDir>/device-helper with progress, version verified; old Node, npm failure, wrong version', async () => {
  const lines = [];
  const r = fakeRunner([
    [/^'node' -v/, ok('v22.22.0\n')],
    [
      /npm install agent-device@/,
      (_s, opts) => {
        for (const l of ['npm http fetch GET 200 https://registry.npmjs.org/agent-device', 'added 1 package in 1s'])
          opts.onLine(l);
        return ok();
      },
    ],
    [/cat .*package\.json/, ok(JSON.stringify({ version: HELPER_VERSION }))],
  ]);
  const d = createDriver({ run: r.run, appDataDir: '/data/app/' });
  await d.installHelper((l) => lines.push(l));
  const script = r.calls.find((c) => /npm install/.test(c.script)).script;
  assert.match(script, /mkdir -p '\/data\/app\/device-helper' && cd '\/data\/app\/device-helper'/);
  assert.match(script, new RegExp(`npm install agent-device@${HELPER_VERSION} --save-exact --ignore-scripts`));
  assert.equal(r.calls.find((c) => /npm install/.test(c.script)).opts.timeoutMs, 180_000);
  assert.deepEqual(lines.filter((l) => /fetch|added/.test(l)).length, 2);
  assert.match(lines.at(-1), new RegExp(`Installed agent-device ${HELPER_VERSION}`));
  assert.match(d.helperPath, /^\/data\/app\/device-helper\/node_modules\/agent-device\/bin\//);

  const old = createDriver({ run: fakeRunner([[/-v/, ok('v20.1.0\n')]]).run, appDataDir: '/d' });
  await assert.rejects(old.installHelper(), (e) => e.code === 'toolchain' && /too old/.test(e.message));
  const noNode = createDriver({
    run: fakeRunner([[/-v/, { code: 127, stdout: '', stderr: 'node: not found' }]]).run,
    appDataDir: '/d',
  });
  await assert.rejects(noNode.installHelper(), (e) => e.code === 'toolchain');
  const failing = createDriver({
    run: fakeRunner([
      [/-v/, ok('v22.22.0\n')],
      [/npm install/, { code: 1, stdout: 'npm error network request failed', stderr: '' }],
    ]).run,
    appDataDir: '/d',
  });
  await assert.rejects(failing.installHelper(), (e) => /network request failed/.test(e.message));
  const wrong = createDriver({
    run: fakeRunner([
      [/-v/, ok('v22.22.0\n')],
      [/npm install/, ok()],
      [/cat/, ok(JSON.stringify({ version: '0.1.0' }))],
    ]).run,
    appDataDir: '/d',
  });
  await assert.rejects(wrong.installHelper(), (e) => /installed as 0\.1\.0, expected/.test(e.message));
});

test('installHelper called twice at once installs once', async () => {
  let installs = 0;
  const r = fakeRunner([
    [/^'node' -v/, ok('v22.22.0\n')],
    [/npm install/, async () => (installs++, await tick(), ok())],
    [/cat/, ok(JSON.stringify({ version: HELPER_VERSION }))],
  ]);
  const d = createDriver({ run: r.run, appDataDir: '/d' });
  await Promise.all([d.installHelper(), d.installHelper()]);
  assert.equal(installs, 1);
});

// ---------- snapshot ----------

test('snapshot: binds the helper session to the home screen first, passes explicit session / udid / platform, parses the real nodes', async () => {
  const { d, calls, helperCalls } = iosDriver();
  const map = await d.snapshot(UDID);
  assert.equal(map.nodes.length, 22);
  assert.deepEqual(map.viewport, { width: 402, height: 874 });
  assert.equal(map.nodes.find((n) => n.id === 'com.apple.settings.general').label, 'Основные');
  const open = helperCalls('open')[0].script;
  assert.match(
    open,
    /'open' 'com\.apple\.springboard' '--session' 'gustaf-22144834-F40F-4063-A585-2C2BB11A88C5' '--udid' '22144834-F40F-4063-A585-2C2BB11A88C5' '--platform' 'ios' '--json'/,
  );
  const snap = helperCalls('snapshot')[0].script;
  assert.match(snap, /'snapshot' '-i' '--session' 'gustaf-[^']+' '--udid' '[^']+' '--platform' 'ios' '--json'/);
  assert.match(snap, /^'node' '\/data\/app\/device-helper\/node_modules\/agent-device\/bin\/agent-device\.mjs'/);
  await d.snapshot(UDID);
  assert.equal(helperCalls('open').length, 1, 'the session is opened once');
  assert.equal(calls.filter((c) => /npx|npm /.test(c.script)).length, 0, 'never npx / npm at call time');
});

test('snapshot: a lost helper session (daemon idle) is reopened once and the call retried', async () => {
  let n = 0;
  const r = fakeRunner([
    HELPER_PRESENT,
    [h('open'), json({ success: true, data: {} })],
    [h('snapshot'), () => (n++ === 1 ? json(ios.sessionNotFound) : json(settingsSnapshot()))],
  ]);
  const d = createDriver({ run: r.run, appDataDir: '/d', sleep: async () => {} });
  assert.equal((await d.snapshot(UDID)).nodes.length, 22);
  assert.equal((await d.snapshot(UDID)).nodes.length, 22, 'the second call lost its session and recovered');
  assert.equal(r.helperCalls('open').length, 2, 'bound at the first call, rebound after the loss');
  assert.equal(n, 3);
});

test('snapshot: a screen that is still settling (few nodes, "unverified") is looked at again', async () => {
  let n = 0;
  const sparse = {
    success: true,
    data: {
      nodes: settingsSnapshot().data.nodes.slice(0, 3),
      warnings: ['Simulator AX snapshot unavailable (foreground-owner-unverified)'],
      viewport: { width: 320, height: 256 },
    },
  };
  const r = fakeRunner([
    HELPER_PRESENT,
    [h('open'), json({ success: true, data: {} })],
    [h('snapshot'), () => json(n++ < 1 ? sparse : settingsSnapshot())],
  ]);
  const map = await createDriver({ run: r.run, appDataDir: '/d', sleep: async () => {} }).snapshot(UDID);
  assert.equal(map.nodes.length, 22);
  assert.equal(r.helperCalls('snapshot').length, 3, 'no session yet, sparse, full');
});

// ---------- actions ----------

test('tap by ref: press @ref --settle, message and settled from the helper, diff from our own before/after maps', async () => {
  let shots = 0;
  const { d, helperCalls } = iosDriver([[h('press'), json(ios.pressSettled)]]);
  // snapshot sequence: the real one, then a changed screen after the tap
  const r = fakeRunner([
    HELPER_PRESENT,
    [h('open'), json({ success: true, data: {} })],
    [h('snapshot'), () => json(shots++ === 0 ? settingsSnapshot() : changedSnapshot())],
    [h('press'), json(ios.pressSettled)],
  ]);
  const dr = createDriver({ run: r.run, appDataDir: '/d', sleep: async () => {} });
  await dr.snapshot(UDID);
  const res = await dr.tap(UDID, { ref: 'e7' });
  assert.match(r.helperCalls('press')[0].script, /'press' '@e7' '--settle' '--session'/);
  assert.equal(res.message, ios.pressSettled.data.message);
  assert.equal(res.settled, true);
  assert.match(res.diff, /^1 removed, 1 added, 0 changed/);
  assert.match(res.diff, /- @e\d+ \[cell\] "Основные"/);
  assert.match(res.diff, /\+ @e99 \[cell\] "Новая страница"/);
  void d;
  void helperCalls;
});

test('tap by point and ref spelling: "@e7" and "e7" are the same; coordinates are device points, rounded to 0.1', async () => {
  const { d, helperCalls } = iosDriver([[h('press'), json(ios.pressSettled)]]);
  await d.tap(UDID, { ref: '@e7' });
  await d.tap(UDID, { x: 200.04, y: 300.46 });
  const [a, b] = helperCalls('press').map((c) => c.script);
  assert.match(a, /'press' '@e7' '--settle'/);
  assert.match(b, /'press' '200' '300\.5' '--settle'/);
});

test('when nothing changed the diff is empty and the helper settle flag is passed on', async () => {
  const { d } = iosDriver([
    [
      h('press'),
      json({
        success: true,
        data: {
          message: 'Tapped',
          settle: {
            settled: false,
            waitedMs: 10000,
            diff: { summary: { additions: 0, removals: 0, unchanged: 22 }, lines: [] },
          },
        },
      }),
    ],
  ]);
  const res = await d.tap(UDID, { ref: 'e1' });
  assert.deepEqual(res, { message: 'Tapped', diff: '', settled: false });
});

test('stale ref: the helper rejection becomes DeviceError "stale-ref"', async () => {
  const { d } = iosDriver([
    [h('press'), json(ios.staleRef)],
    [h('fill'), json(ios.staleRef)],
  ]);
  await assert.rejects(
    d.tap(UDID, { ref: 'e999' }),
    (e) => e instanceof DeviceError && e.code === 'stale-ref' && /new snapshot/.test(e.message),
  );
  await assert.rejects(d.fill(UDID, { ref: 'e999' }, 'x'), (e) => e.code === 'stale-ref');
});

test('helper failures keep their message: device in use, swipe out of bounds, no in-app back', async () => {
  const { d } = iosDriver([
    [h('swipe'), json(ios.swipeOutOfBounds)],
    [h('back'), json(ios.backUnavailable)],
  ]);
  await assert.rejects(
    d.swipe(UDID, { x: 200, y: 700 }, { x: 200, y: 300 }),
    (e) => e.code === 'failed' && /does not fit inside the viewport/.test(e.message),
  );
  await assert.rejects(d.press(UDID, 'back'), (e) => /in-app back control is not available/.test(e.message));
  const busy = createDriver({
    run: fakeRunner([HELPER_PRESENT, [h('open'), json(ios.deviceInUse)]]).run,
    appDataDir: '/d',
  });
  await assert.rejects(
    busy.snapshot(UDID),
    (e) => /Another automation session holds this device/.test(e.message) && /other-holder/.test(e.message),
  );
});

test('a runner timeout is a DeviceError "timeout"', async () => {
  const { d } = iosDriver([[h('press'), { code: -1, stdout: '', stderr: '', timedOut: true }]]);
  await assert.rejects(d.tap(UDID, { ref: 'e1' }), (e) => e.code === 'timeout');
});

test('each action maps to its helper command', async () => {
  const { d, helperCalls } = iosDriver([
    [h('longpress'), json(ios.longpress)],
    [h('swipe'), json({ success: true, data: { message: 'Swiped' } })],
    [h('gesture'), json({ success: true, data: { message: 'Panned' } })],
    [h('type'), json(ios.type)],
    [h('fill'), json(ios.fill)],
    [h('scroll'), json(ios.scroll)],
    [h('back'), json(ios.back)],
    [h('home'), json(ios.home)],
    [h('app-switcher'), json(ios.appSwitcher)],
  ]);
  const script = (cmd) =>
    helperCalls(cmd).map((c) => c.script.replace(/^.*agent-device\.mjs' /, '').replace(/ '--session'.*$/, ''));
  assert.match((await d.longPress(UDID, { ref: 'e5' }, 800)).message, /Long pressed/);
  await d.longPress(UDID, { x: 10, y: 20 });
  assert.deepEqual(script('longpress'), ["'longpress' '@e5' '800' '--settle'", "'longpress' '10' '20' '--settle'"]);
  await d.swipe(UDID, { x: 200, y: 600 }, { x: 200, y: 300 });
  await d.swipe(UDID, { x: 200, y: 600 }, { x: 200, y: 300 }, 450);
  assert.deepEqual(script('swipe'), ["'swipe' '200' '600' '200' '300'"]);
  assert.deepEqual(script('gesture'), ["'gesture' 'pan' '200' '600' '0' '-300' '450'"]);
  const typed = await d.type(UDID, 'it\'s "quoted" $HOME; rm -rf /');
  assert.match(typed.message, /Typed 2 chars/);
  assert.ok(helperCalls('type')[0].script.includes(`'it'\\''s "quoted" $HOME; rm -rf /'`), 'text is shell-quoted');
  assert.ok(!/'--settle'/.test(helperCalls('type')[0].script), 'type never gets --settle');
  await d.fill(UDID, { ref: 'e18' }, 'VPN');
  await d.fill(UDID, { x: 5, y: 6 }, '');
  assert.deepEqual(script('fill'), ["'fill' '@e18' 'VPN' '--settle'", "'fill' '5' '6' '' '--settle'"]);
  await d.scroll(UDID, 'down', 0.5);
  await d.scroll(UDID, 'up', 5);
  await d.scroll(UDID, 'left');
  assert.deepEqual(script('scroll'), [
    "'scroll' 'down' '0.5' '--settle'",
    "'scroll' 'up' '0.8' '--settle'",
    "'scroll' 'left' '--settle'",
  ]);
  await d.press(UDID, 'back');
  await d.press(UDID, 'app-switcher');
  await d.press(UDID, 'enter');
  assert.deepEqual(script('back'), ["'back' '--settle'"]);
  assert.equal(helperCalls('app-switcher').length, 1);
  assert.match(helperCalls('type').at(-1).script, /'type' '\n'/);
  await assert.rejects(d.press(UDID, 'volume-up'), /no volume buttons/);
});

test('press home on iOS goes to the home screen and rebinds the helper session to SpringBoard', async () => {
  const { d, helperCalls } = iosDriver([
    [h('home'), json(ios.home)],
    [h('open'), json({ success: true, data: {} })],
  ]);
  await d.snapshot(UDID);
  const r = await d.press(UDID, 'home');
  assert.equal(r.message, 'Home');
  const opens = helperCalls('open').map((c) => c.script.match(/'open' '([^']+)'/)[1]);
  assert.deepEqual(opens, ['com.apple.springboard', 'com.apple.springboard']);
});

test('openApp: open <app> through the helper, the session follows the app; a later home rebinds', async () => {
  const rr = fakeRunner([
    HELPER_PRESENT,
    [
      h('open'),
      json({
        success: true,
        data: { message: 'Opened: Settings', appName: 'Settings', appBundleId: 'com.apple.Preferences' },
      }),
    ],
    [h('snapshot'), json(settingsSnapshot())],
  ]);
  const { helperCalls } = rr;
  const d = createDriver({ run: rr.run, appDataDir: '/d', sleep: async () => {} });
  const r = await d.openApp(UDID, 'Settings');
  assert.equal(r.message, 'Opened: Settings');
  assert.match(helperCalls('open')[0].script, /'open' 'Settings' '--foreground' '--session'/);
  assert.equal(helperCalls('snapshot').length, 1, 'a snapshot after the launch');
  await assert.rejects(
    createDriver({
      run: fakeRunner([HELPER_PRESENT, [h('open'), json(ios.appNotInstalled)]]).run,
      appDataDir: '/d',
    }).openApp(UDID, 'Настройки'),
    /No app found matching/,
  );
});

test('tapping an app icon on the home screen follows the app that opened (localised name -> bundle id)', async () => {
  const home = settingsSnapshot();
  home.data.nodes = home.data.nodes.map((n) => ({ ...n }));
  home.data.nodes[5] = { ...home.data.nodes[5], ref: 'e50', label: 'Настройки', kind: 'icon', hittable: true };
  let phase = 0;
  const r = fakeRunner([
    HELPER_PRESENT,
    [h('open'), json({ success: true, data: {} })],
    [h('snapshot'), () => json(phase++ === 0 ? home : settingsSnapshot())],
    [h('press'), json({ success: true, data: { message: 'Tapped @e50' } })],
    [/defaults read -g AppleLanguages/, ok(sim.languages)],
    [/listapps/, ok(JSON.stringify({ 'com.apple.Preferences': ['Settings', 'Настройки'] }))],
  ]);
  const d = createDriver({ run: r.run, appDataDir: '/d', sleep: async () => {} });
  await d.snapshot(UDID);
  await d.tap(UDID, { ref: 'e50' });
  const opens = r.helperCalls('open').map((c) => c.script.match(/'open' '([^']+)'/)[1]);
  assert.deepEqual(opens, ['com.apple.springboard', 'com.apple.Preferences']);
});

// ---------- release ----------

test('release closes the helper session and forgets the device; unused devices cost nothing', async () => {
  const { d, helperCalls } = iosDriver([[h('close'), json(ios.close)]]);
  await d.release(UDID);
  assert.equal(helperCalls('close').length, 0);
  await d.snapshot(UDID);
  await d.release(UDID);
  assert.equal(helperCalls('close').length, 1);
  assert.match(helperCalls('close')[0].script, /'close' '--session' 'gustaf-22144834/);
  await d.snapshot(UDID);
  assert.equal(helperCalls('open').length, 2, 'a new session after release');
});

// ---------- concurrency ----------

/** A fake whose helper commands block until released, and log start / end. */
function gatedRunner() {
  const log = [];
  const gates = new Map();
  const gate = (name) => {
    let release;
    const p = new Promise((r) => (release = r));
    gates.set(name, { p, release });
    return p;
  };
  const r = fakeRunner([
    HELPER_PRESENT,
    [h('open'), json({ success: true, data: {} })],
    [
      h('snapshot'),
      async (s) => {
        const dev = s.match(/--udid' '([^']+)'|--serial' '([^']+)'/);
        log.push(`snapshot-start:${dev[1] ?? dev[2]}`);
        await gates.get('snapshot')?.p;
        log.push(`snapshot-end:${dev[1] ?? dev[2]}`);
        return json(settingsSnapshot());
      },
    ],
    [
      h('press'),
      async (s) => {
        const dev = s.match(/--udid' '([^']+)'|--serial' '([^']+)'/);
        log.push(`press-start:${dev[1] ?? dev[2]}:${s.match(/'press' '([^']+)'/)[1]}`);
        await gates.get('press')?.p;
        log.push(`press-end:${dev[1] ?? dev[2]}`);
        return json(ios.pressSettled);
      },
    ],
  ]);
  return { ...r, log, gate, release: (n) => gates.get(n).release() };
}

test('mutating calls on one device run one after another; another device is not held up', async () => {
  const g = gatedRunner();
  const d = createDriver({ run: g.run, appDataDir: '/d', sleep: async () => {} });
  const OTHER = '33333333-F40F-4063-A585-2C2BB11A88C5';
  await d.snapshot(UDID); // warm: the map is cached, actions need no extra snapshot first
  await d.snapshot(OTHER);
  g.log.length = 0;
  g.gate('press');
  const t1 = d.tap(UDID, { ref: 'e1' });
  const t2 = d.tap(UDID, { ref: 'e2' });
  const t3 = d.tap(OTHER, { ref: 'e3' });
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(
    g.log.filter((l) => l.startsWith('press-start')).sort(),
    [`press-start:${OTHER}:@e3`, `press-start:${UDID}:@e1`].sort(),
    'the second tap on the same device has not started',
  );
  g.release('press');
  await Promise.all([t1, t2, t3]);
  assert.ok(
    g.log.indexOf(`press-end:${UDID}`) < g.log.indexOf(`press-start:${UDID}:@e2`),
    'second tap starts after the first ended',
  );
});

test('concurrent snapshots share one helper call; one requested after an action was queued does not join an older one', async () => {
  const g = gatedRunner();
  const d = createDriver({ run: g.run, appDataDir: '/d', sleep: async () => {} });
  g.gate('snapshot');
  const [a, b, c] = [d.snapshot(UDID), d.snapshot(UDID), d.snapshot(UDID)];
  for (let i = 0; i < 10; i++) await tick();
  g.release('snapshot');
  const [ma, mb, mc] = await Promise.all([a, b, c]);
  assert.strictEqual(ma, mb);
  assert.strictEqual(mb, mc);
  assert.equal(g.log.filter((l) => l.startsWith('snapshot-start')).length, 1, 'one helper snapshot for three callers');

  // A snapshot, then a tap, then another snapshot: the second snapshot must run after the tap.
  g.log.length = 0;
  const s1 = d.snapshot(UDID);
  const tap = d.tap(UDID, { ref: 'e1' });
  const s2 = d.snapshot(UDID);
  await Promise.all([s1, tap, s2]);
  assert.notStrictEqual(await s1, await s2);
  const order = g.log.filter((l) => /press-end|snapshot-start/.test(l));
  assert.ok(
    order.lastIndexOf(order.find((l) => l.startsWith('press-end'))) < order.length - 1,
    'a snapshot ran after the tap',
  );
});

test('a failed action does not block the next one', async () => {
  let n = 0;
  const { d } = iosDriver([[h('press'), () => (n++ === 0 ? json(ios.staleRef) : json(ios.pressSettled))]]);
  await assert.rejects(d.tap(UDID, { ref: 'e999' }), /new snapshot/);
  assert.equal((await d.tap(UDID, { ref: 'e1' })).message, ios.pressSettled.data.message);
});

// ---------- Android (synthetic fixtures) ----------

function androidDriver(extra = []) {
  const r = fakeRunner([
    HELPER_PRESENT,
    [/dumpsys window/, ok(droid.dumpsysFocus)],
    [h('open'), json({ success: true, data: {} })],
    [h('snapshot'), json(droid.snapshot)],
    ...extra,
  ]);
  return { ...r, d: createDriver({ run: r.run, appDataDir: '/d', sleep: async () => {} }) };
}

test('Android (synthetic): helper calls use --serial and --platform android with the SDK folders on PATH; the session opens on the focused app', async () => {
  const { d, helperCalls } = androidDriver([[h('press'), json(droid.pressReply)]]);
  const map = await d.snapshot(SERIAL);
  assert.equal(map.app.bundleId, 'com.android.settings');
  assert.deepEqual(map.viewport, { width: 1080, height: 2400 });
  const open = helperCalls('open')[0].script;
  assert.match(open, /^export PATH=.*platform-tools.*; 'node' /);
  assert.match(
    open,
    /'open' 'com\.android\.settings' '--session' 'gustaf-emulator-5554' '--serial' 'emulator-5554' '--platform' 'android' '--json'/,
  );
  const res = await d.tap(SERIAL, { ref: 'e4' });
  assert.equal(res.message, 'Tapped @e4 (540, 610)');
  assert.equal(res.settled, true);
  // Android back is the system key; volume keys go through adb.
  const keys = [];
  const { d: d2, calls } = androidDriver([
    [h('back'), json({ success: true, data: { message: 'Back' } })],
    [/input keyevent/, (s) => (keys.push(s.match(/keyevent (\d+)/)[1]), ok())],
  ]);
  await d2.press(SERIAL, 'back');
  await d2.press(SERIAL, 'volume-up');
  await d2.press(SERIAL, 'volume-down');
  assert.match(calls.find((c) => h('back').test(c.script)).script, /'back' '--system' '--settle'/);
  assert.deepEqual(keys, ['24', '25']);
});

test('Android (synthetic): no focused app to bind to is a clear error', async () => {
  const { d } = androidDriver([]);
  const r = fakeRunner([HELPER_PRESENT, [/dumpsys window/, ok('')]]);
  await assert.rejects(createDriver({ run: r.run, appDataDir: '/d' }).snapshot(SERIAL), /Open one with openApp first/);
  void d;
});

test('parseSnapshot keeps working on the Android shape (pixel rects, text-field)', () => {
  const m = parseSnapshot(droid.snapshot.data);
  assert.equal(m.nodes.find((n) => n.role === 'text-field').id, 'com.android.settings:id/search_src_text');
});
