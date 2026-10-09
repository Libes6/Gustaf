// Pure helpers of the Device panel: pointer -> device point through letterboxing, gesture classification, map rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const ui = await import('../src/device/uiMap.ts');
const geo = await import('../src/components/device/screenGeometry.ts');
const rows = await import('../src/components/device/mapRows.ts');
const poll = await import('../src/components/device/poller.ts');
const real = ui.parseSnapshot(
  JSON.parse(readFileSync(new URL('./fixtures/device-ios-settings-snapshot.json', import.meta.url), 'utf8')),
);

const device = { width: 400, height: 800 };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('boxToDevice: letterbox bars give null, the middle maps to the middle, any box size works', () => {
  // A wide box: the phone is pillarboxed (bars left and right).
  const box = { width: 800, height: 800 };
  assert.equal(geo.boxToDevice(device, box, { x: 100, y: 400 }), null);
  const mid = geo.boxToDevice(device, box, { x: 400, y: 400 });
  near(mid.x, 200);
  near(mid.y, 400);
  const corner = geo.boxToDevice(device, box, { x: 200, y: 0 }); // top-left of the drawn screen
  near(corner.x, 0);
  near(corner.y, 0);
  // A tall box: bars above and below.
  assert.equal(geo.boxToDevice(device, { width: 400, height: 1200 }, { x: 200, y: 10 }), null);
  assert.equal(geo.boxToDevice(device, { width: 0, height: 0 }, { x: 0, y: 0 }), null);
});

test('boxToDeviceClamped snaps a point outside the screen to its edge', () => {
  const box = { width: 800, height: 800 };
  const p = geo.boxToDeviceClamped(device, box, { x: 5000, y: -50 });
  assert.ok(p.x < 400 && p.x > 399.99);
  near(p.y, 0);
});

test('classifyGesture: tap, long press, swipe', () => {
  const a = { x: 10, y: 10 };
  const base = { viewDown: a, viewUp: { x: 12, y: 11 }, from: { x: 50, y: 60 }, to: { x: 52, y: 61 } };
  assert.deepEqual(geo.classifyGesture({ ...base, durationMs: 80 }), { kind: 'tap', at: base.from });
  assert.deepEqual(geo.classifyGesture({ ...base, durationMs: 700 }), { kind: 'longPress', at: base.from, ms: 700 });
  const swipe = geo.classifyGesture({ ...base, viewUp: { x: 10, y: 200 }, to: { x: 50, y: 400 }, durationMs: 300 });
  assert.deepEqual(swipe, { kind: 'swipe', from: base.from, to: { x: 50, y: 400 }, ms: 300 });
  // A slow drag is still a swipe, never a long press.
  assert.equal(geo.classifyGesture({ ...base, viewUp: { x: 10, y: 200 }, durationMs: 2000 }).kind, 'swipe');
});

test('chipPosition stays inside the box', () => {
  const chip = { width: 100, height: 18 };
  const box = { width: 300, height: 300 };
  assert.deepEqual(geo.chipPosition({ x: 50, y: 100, width: 10, height: 10 }, box, chip), { x: 50, y: 80 });
  assert.equal(geo.chipPosition({ x: 50, y: 5, width: 10, height: 10 }, box, chip).y, 7); // no room above: inside
  assert.equal(geo.chipPosition({ x: 290, y: 100, width: 10, height: 10 }, box, chip).x, 200);
});

test('mapRows: indent counts only shown ancestors; search and interactive filter', () => {
  const all = rows.mapRows(real);
  assert.ok(all.length > 8 && all.length < real.nodes.length);
  const general = all.find((r) => r.node.id === 'com.apple.settings.general');
  assert.equal(general.actionable, true);
  assert.ok(general.level >= 1);
  assert.deepEqual(
    rows.mapRows(real, { query: 'камера' }).map((r) => r.node.id),
    ['com.apple.settings.camera'],
  );
  assert.equal(rows.mapRows(real, { query: 'no-such-thing' }).length, 0);
  const interactive = rows.mapRows(real, { interactiveOnly: true });
  assert.ok(interactive.length > 0 && interactive.length < all.length);
  assert.ok(interactive.every((r) => r.actionable));
  assert.equal(rows.nodeTitle(general.node), 'Основные');
});

test('rematchNode finds a pinned element in a refreshed map, or drops it', () => {
  const old = real.nodes.find((n) => n.id === 'com.apple.settings.general');
  const moved = ui.parseSnapshot({
    viewport: { width: 402, height: 874 },
    nodes: [
      {
        ref: 'e50',
        kind: 'cell',
        label: 'Основные',
        identifier: 'com.apple.settings.general',
        rect: { x: 16, y: 40, width: 370, height: 52 },
        enabled: true,
        hittable: true,
        depth: 0,
      },
    ],
  });
  assert.equal(rows.rematchNode(moved, old).ref, 'e50');
  assert.equal(rows.rematchNode(ui.parseSnapshot({ nodes: [] }), old), null);
  assert.equal(rows.rematchNode(real, { ...old, id: undefined, label: undefined }), null);
});

test('frameDelay: fast when active, slow when idle, null when nobody looks', () => {
  const v = { visible: true, focused: true, sinceActivityMs: 0 };
  assert.equal(poll.frameDelay(v), 250);
  assert.equal(poll.frameDelay({ ...v, sinceActivityMs: 60_000 }), 1500);
  assert.equal(poll.frameDelay({ ...v, visible: false }), null);
  assert.equal(poll.frameDelay({ ...v, focused: false }), null);
  assert.ok(poll.frameDelay({ ...v, failing: true }) > 1500);
});
