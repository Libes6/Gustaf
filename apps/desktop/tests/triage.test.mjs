import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTriage, placeOf, settle, snooze, snoozePresets, wakeUps, without } from '../src/lib/triageCore.ts';

const NOW = new Date(2026, 9, 6, 14, 0).getTime(); // Tuesday 14:00 local

test('placeOf: attention beats everything, running goes to Working, an expired snooze is open', () => {
  const m = snooze(settle({}, 1, NOW), 2, NOW + 3600_000);
  assert.equal(placeOf(1, m, null, NOW), 'settled');
  assert.equal(placeOf(2, m, null, NOW), 'snoozed');
  assert.equal(placeOf(2, m, null, NOW + 2 * 3600_000), 'open');
  assert.equal(placeOf(1, m, 'waiting', NOW), 'attention');
  assert.equal(placeOf(2, m, 'unread', NOW), 'attention');
  assert.equal(placeOf(3, m, 'running', NOW), 'working');
  assert.equal(placeOf(3, m, null, NOW), 'open');
});

test('wakeUps: expired snoozes, newer activity on settled chats, chats that need attention', () => {
  const m = {
    1: { settledAt: NOW },
    2: { snoozedUntil: NOW - 1 },
    3: { snoozedUntil: NOW + 10 },
    4: { settledAt: NOW },
  };
  const ids = wakeUps(
    m,
    NOW,
    new Set([3]),
    new Map([
      [1, NOW + 5],
      [4, NOW - 5],
    ]),
  );
  assert.deepEqual(ids.sort(), [1, 2, 3]);
});

test('settle and snooze replace each other; without removes; parse is tolerant', () => {
  const m = snooze(settle({}, 5, NOW), 5, NOW + 10);
  assert.deepEqual(m, { 5: { snoozedUntil: NOW + 10 } });
  assert.deepEqual(without(m, 5), {});
  assert.deepEqual(parseTriage({ 5: { settledAt: 7 }, x: {}, 6: { snoozedUntil: -1 }, 7: null }), {
    5: { settledAt: 7, snoozedUntil: undefined },
  });
});

test('snooze presets: an hour, this evening, tomorrow 9:00, next Monday 9:00', () => {
  const at = Object.fromEntries(snoozePresets(NOW).map((p) => [p.key, new Date(p.at)]));
  assert.equal(at.hour.getTime(), NOW + 3600_000);
  assert.deepEqual([at.evening.getDate(), at.evening.getHours()], [6, 18]);
  assert.deepEqual([at.tomorrow.getDate(), at.tomorrow.getHours()], [7, 9]);
  assert.deepEqual([at.nextWeek.getDay(), at.nextWeek.getDate(), at.nextWeek.getHours()], [1, 12, 9]);
  const late = new Date(2026, 9, 6, 17, 50).getTime();
  assert.equal(
    new Date(snoozePresets(late).find((p) => p.key === 'evening').at).getDate(),
    7,
    'too close to 18:00: tomorrow evening',
  );
});
