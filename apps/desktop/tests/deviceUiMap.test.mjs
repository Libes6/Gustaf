// The interface map (src/device/uiMap.ts) on real output of an iOS 26.2 simulator (Settings, Russian UI) plus small
// synthetic maps for cases the real one does not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const ui = await import('../src/device/uiMap.ts');
const real = JSON.parse(readFileSync(new URL('./fixtures/device-ios-settings-snapshot.json', import.meta.url), 'utf8'));

const node = (o) => ({
  type: 'Other',
  kind: 'other',
  enabled: true,
  hittable: true,
  depth: 0,
  rect: { x: 0, y: 0, width: 100, height: 100 },
  ...o,
});
const mapOf = (nodes, extra = {}) => ui.parseSnapshot({ viewport: { width: 400, height: 800 }, nodes, ...extra });

test('parses the real snapshot: tree, roles, labels, ids, geometry', () => {
  const m = ui.parseSnapshot(real);
  assert.equal(m.nodes.length, 22);
  assert.deepEqual(m.viewport, { width: 402, height: 874 });
  assert.equal(m.app.bundleId, 'com.apple.Preferences');
  const general = m.nodes.find((n) => n.id === 'com.apple.settings.general');
  assert.equal(general.role, 'cell');
  assert.equal(general.label, 'Основные');
  assert.equal(general.parent !== null, true);
  assert.equal(m.nodes[general.parent].role, 'collection');
  assert.equal(m.nodes[0].parent, null);
  assert.equal(m.nodes[general.parent].children.includes(general.index), true);
  // Non-breaking spaces of the platform text are normal spaces.
  assert.equal(
    m.nodes.some((n) => n.label?.includes(' ')),
    false,
  );
});

test('malformed input never throws and gives an empty map', () => {
  for (const bad of [undefined, null, 5, 'x', {}, { nodes: 3 }, { nodes: [null, 1, 'a', {}] }]) {
    const m = ui.parseSnapshot(bad);
    assert.deepEqual(m.nodes, []);
  }
  const m = mapOf([node({ ref: 'e1', rect: { x: 'a', y: NaN, width: -4, height: 10 } })]);
  assert.deepEqual(m.nodes[0].rect, { x: 0, y: 0, width: 0, height: 10 });
});

test('hit test picks the deepest element, not the screen-sized container', () => {
  const m = ui.parseSnapshot(real);
  const hit = ui.hitTest(m, { x: 200, y: 355 });
  assert.equal(hit.id, 'com.apple.settings.general');
  const row = ui.hitTest(m, { x: 200, y: 200 });
  assert.equal(row.role, 'button', 'the button inside the Apple account cell');
  assert.equal(ui.hitTest(m, { x: 5000, y: 5 }), null);
});

test('a covered element loses to an uncovered one at the same point', () => {
  const m = mapOf([
    node({ ref: 'e1', index: 0 }),
    node({ ref: 'e2', index: 1, depth: 1, parentIndex: 0, label: 'under', interactionBlocked: 'covered' }),
    node({ ref: 'e3', index: 2, depth: 1, parentIndex: 0, label: 'over' }),
  ]);
  assert.equal(ui.hitTest(m, { x: 10, y: 10 }).label, 'over');
  const only = mapOf([node({ ref: 'e1', index: 0, depth: 1, label: 'under', interactionBlocked: 'covered' })]);
  assert.equal(
    ui.hitTest(only, { x: 10, y: 10 }).label,
    'under',
    'a covered node is still the answer when nothing else is there',
  );
});

test('screen geometry: letterboxing and the round trip between view and device points', () => {
  const device = { width: 402, height: 874 };
  const shown = ui.fitScreen(device, { width: 800, height: 600 });
  assert.equal(Math.round(shown.height), 600);
  assert.equal(shown.x > 0, true, 'centred horizontally');
  const p = ui.viewToDevice(device, shown, { x: shown.x + shown.width / 2, y: shown.y + shown.height / 2 });
  assert.equal(Math.round(p.x), 201);
  assert.equal(Math.round(p.y), 437);
  assert.equal(ui.viewToDevice(device, shown, { x: 1, y: 1 }), null, 'the letterbox is not the screen');
  const back = ui.deviceToView(device, shown, { x: 201, y: 437, width: 0, height: 0 });
  assert.equal(Math.round(back.x), Math.round(shown.x + shown.width / 2));
  assert.deepEqual(ui.fitScreen({ width: 0, height: 0 }, { width: 10, height: 10 }), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
});

test('text for agents: header, tree order, no unnamed noise, duplicates collapsed, long lists cut', () => {
  const m = ui.parseSnapshot(real);
  const text = ui.renderMap(m);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Settings (com.apple.Preferences) 402x874');
  assert.ok(text.includes('@e7 [cell] "Основные" id=com.apple.settings.general'));
  const dictate = lines.filter((l) => l.includes('Dictate'));
  assert.equal(dictate.length, 1, 'the two identical Dictate buttons are listed once');
  const short = ui.renderMap(m, { maxLines: 3 });
  assert.match(short, /… \d+ more elements/);
  assert.ok(short.split('\n').length <= 6);
});

test('off-screen and empty elements are left out and counted', () => {
  const m = mapOf([
    node({ ref: 'e1', index: 0, label: 'Screen' }),
    node({
      ref: 'e2',
      index: 1,
      depth: 1,
      parentIndex: 0,
      label: 'Far',
      rect: { x: 900, y: 0, width: 50, height: 50 },
    }),
    node({ ref: 'e3', index: 2, depth: 1, parentIndex: 0 }),
  ]);
  const t = ui.renderMap(m);
  assert.ok(t.includes('"Screen"'));
  assert.equal(t.includes('Far'), false);
  assert.match(t, /\(2 unnamed, hidden or off-screen elements not shown\)/);
});

test('search finds by label, id and role; the empty query finds nothing', () => {
  const m = ui.parseSnapshot(real);
  assert.equal(ui.findNodes(m, 'камера').length, 1);
  assert.equal(ui.findNodes(m, 'settings.general').length, 1);
  assert.equal(ui.findNodes(m, 'navigation-bar').length, 1);
  assert.deepEqual(ui.findNodes(m, '  '), []);
});

test('diff pairs elements by role, id and label, so reissued refs are not changes', () => {
  const a = ui.parseSnapshot(real);
  const renumbered = ui.parseSnapshot({ ...real, nodes: real.nodes.map((n) => ({ ...n, ref: 'x' + n.ref })) });
  const same = ui.diffMaps(a, renumbered);
  assert.deepEqual([same.added.length, same.removed.length, same.changed.length], [0, 0, 0]);
  assert.equal(ui.renderDiff(same), '');

  const next = ui.parseSnapshot({
    ...real,
    nodes: [
      ...real.nodes
        .filter((n) => n.identifier !== 'com.apple.settings.camera')
        .map((n) => (n.identifier === 'com.apple.settings.general' ? { ...n, value: '1' } : n)),
      { ...real.nodes[1], ref: 'e99', label: 'About', identifier: 'about' },
    ],
  });
  const d = ui.diffMaps(a, next);
  assert.deepEqual(
    d.removed.map((n) => n.label),
    ['Камера'],
  );
  assert.deepEqual(
    d.added.map((n) => n.label),
    ['About'],
  );
  assert.equal(d.changed.length, 1);
  const t = ui.renderDiff(d);
  assert.match(t, /1 removed, 1 added, 1 changed/);
  assert.match(t, /^- @e9 \[cell\] "Камера"/m);
});

test('interactive: enabled, tappable, uncovered and of an actionable role', () => {
  const m = ui.parseSnapshot(real);
  const by = (id) => m.nodes.find((n) => n.id === id);
  assert.equal(ui.isInteractive(by('com.apple.settings.general')), true);
  assert.equal(
    ui.isInteractive(by('com.apple.settings.screenTime')),
    false,
    'not hittable (scrolled under the toolbar)',
  );
  assert.equal(ui.isInteractive(by('AdditionalDimmingOverlay')), false);
});
