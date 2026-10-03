// Schedule math, missed-run policy, overlap prevention, access capping and settings validation (pure module,
// injected clock; local time zones are switched through process.env.TZ).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const sp = await import('../src/lib/scheduledPrompts.ts');

const tz = (zone) => { process.env.TZ = zone; };
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const hhmm = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const HOUR = 3_600_000;

const draft = (over = {}) => ({ title: 'Nightly', prompt: 'Summarize the changes', projectId: 1, providerId: 'p', model: 'm', access: 'auto', schedule: { kind: 'daily', time: '09:00' }, ...over });
const item = (over = {}) => ({ ...sp.createSchedule(draft(), over.id ?? 's1', 0), ...over });
const live = (over = {}) => ({ ...item(over), enabled: true, confirmedAt: 1 });

// ---- schedule math ----

test('daily: later today, then tomorrow; strictly after `from`', () => {
  tz('UTC');
  const s = { kind: 'daily', time: '09:00' };
  assert.equal(hhmm(sp.nextRunAfter(s, at(2026, 5, 10, 8, 0))), '2026-05-10 09:00');
  assert.equal(hhmm(sp.nextRunAfter(s, at(2026, 5, 10, 9, 0))), '2026-05-11 09:00');
  assert.equal(hhmm(sp.nextRunAfter(s, at(2026, 5, 10, 23, 59))), '2026-05-11 09:00');
  assert.equal(hhmm(sp.nextRunAfter({ kind: 'daily', time: '00:00' }, at(2026, 12, 31, 12))), '2027-01-01 00:00');
});

test('daily across the US spring-forward change keeps the wall-clock time', () => {
  tz('America/New_York');
  const s = { kind: 'daily', time: '09:00' };
  const day1 = sp.nextRunAfter(s, at(2026, 3, 7, 10)); // 2026-03-08 09:00 EDT (22 h later instead of the usual 23)
  assert.equal(hhmm(day1), '2026-03-08 09:00');
  assert.equal(day1 - at(2026, 3, 7, 10), 22 * HOUR);
  assert.equal(hhmm(sp.nextRunAfter(s, day1)), '2026-03-09 09:00');
});

test('daily across the fall-back change keeps the wall-clock time', () => {
  tz('America/New_York');
  const s = { kind: 'daily', time: '09:00' };
  const next = sp.nextRunAfter(s, at(2026, 10, 31, 10));
  assert.equal(hhmm(next), '2026-11-01 09:00');
  assert.equal(next - at(2026, 10, 31, 10), 24 * HOUR);
});

test('a time inside the spring-forward gap runs once, right after the gap; an ambiguous time runs once', () => {
  tz('America/New_York');
  const gap = { kind: 'daily', time: '02:30' }; // 2026-03-08 02:30 does not exist
  const a = sp.nextRunAfter(gap, at(2026, 3, 8, 0, 10));
  assert.equal(hhmm(a), '2026-03-08 03:30');
  const b = sp.nextRunAfter(gap, a);
  assert.equal(hhmm(b), '2026-03-09 02:30');
  const twice = { kind: 'daily', time: '01:30' }; // 2026-11-01 01:30 happens twice
  const first = sp.nextRunAfter(twice, at(2026, 11, 1, 0, 10));
  const after = sp.nextRunAfter(twice, first);
  assert.equal(hhmm(after), '2026-11-02 01:30', 'the repeated hour does not fire a second time');
});

test('daily across the Berlin change dates', () => {
  tz('Europe/Berlin');
  const s = { kind: 'daily', time: '07:15' };
  assert.equal(hhmm(sp.nextRunAfter(s, at(2026, 3, 28, 8))), '2026-03-29 07:15');
  assert.equal(hhmm(sp.nextRunAfter(s, at(2026, 10, 24, 8))), '2026-10-25 07:15');
});

test('weekdays skip Saturday and Sunday', () => {
  tz('UTC');
  const s = { kind: 'weekdays', time: '08:30' };
  // 2026-05-15 is a Friday.
  assert.equal(new Date(at(2026, 5, 15, 12)).getDay(), 5);
  assert.equal(hhmm(sp.nextRunAfter(s, at(2026, 5, 15, 8, 0))), '2026-05-15 08:30');
  assert.equal(hhmm(sp.nextRunAfter(s, at(2026, 5, 15, 9, 0))), '2026-05-18 08:30'); // Monday
  assert.equal(hhmm(sp.nextRunAfter(s, at(2026, 5, 16, 12))), '2026-05-18 08:30'); // from Saturday
  assert.equal(hhmm(sp.nextRunAfter(s, at(2026, 5, 17, 23))), '2026-05-18 08:30'); // from Sunday
  assert.equal(hhmm(sp.nextRunAfter(s, at(2026, 5, 18, 8, 30))), '2026-05-19 08:30');
});

test('weekdays over a DST change on a Monday', () => {
  tz('America/New_York');
  const s = { kind: 'weekdays', time: '09:00' };
  assert.equal(hhmm(sp.nextRunAfter(s, at(2026, 3, 6, 10))), '2026-03-09 09:00'); // Fri 10:00 -> Mon, DST began on Sunday
});

test('once: in the future runs at its time, in the past never', () => {
  tz('UTC');
  const now = at(2026, 5, 10, 12);
  assert.equal(sp.nextRunAfter({ kind: 'once', at: now + HOUR }, now), now + HOUR);
  assert.equal(sp.nextRunAfter({ kind: 'once', at: now }, now), null);
  assert.equal(sp.nextRunAfter({ kind: 'once', at: now - HOUR }, now), null);
  assert.equal(sp.setEnabled(item({ schedule: { kind: 'once', at: now - HOUR } }), true, now), null, 'cannot be switched on');
  assert.equal(sp.setEnabled(item({ schedule: { kind: 'once', at: now + HOUR } }), true, now).nextRunAt, now + HOUR);
});

test('interval is relative to the reference time', () => {
  assert.equal(sp.nextRunAfter({ kind: 'interval', everyMinutes: 90 }, 1000), 1000 + 90 * 60_000);
});

// ---- the periodic check ----

test('nothing happens before the schedule is due, or while disabled / unconfirmed', () => {
  tz('UTC');
  const now = at(2026, 5, 10, 12);
  const due = { nextRunAt: now - 1000 };
  const none = new Set();
  assert.deepEqual(sp.planTick([live({ nextRunAt: now + 1 })], now, none).start, []);
  assert.deepEqual(sp.planTick([item({ ...due })], now, none).start, [], 'disabled');
  assert.deepEqual(sp.planTick([{ ...live(due), confirmedAt: undefined }], now, none).start, [], 'enabled flag without confirmation');
  assert.deepEqual(sp.planTick([live(due)], now, none).start, ['s1']);
});

test('an enabled schedule without nextRunAt just gets one', () => {
  tz('UTC');
  const now = at(2026, 5, 10, 8);
  const plan = sp.planTick([live()], now, new Set());
  assert.deepEqual(plan.start, []);
  assert.equal(hhmm(plan.patches[0].patch.nextRunAt), '2026-05-10 09:00');
});

test('starting a run marks it running and advances nextRunAt', () => {
  tz('UTC');
  const now = at(2026, 5, 10, 9, 0);
  const s = live({ nextRunAt: now });
  const plan = sp.planTick([s], now, new Set());
  const [out] = sp.applyPatches([s], plan.patches);
  assert.equal(out.lastStatus, 'running');
  assert.equal(out.lastRunAt, now);
  assert.equal(hhmm(out.nextRunAt), '2026-05-11 09:00');
  assert.equal(out.enabled, true);
});

test('missed run: late by less than 24 h runs once; later than that is skipped and recorded as missed', () => {
  tz('UTC');
  const dueAt = at(2026, 5, 10, 9, 0);
  const s = live({ nextRunAt: dueAt });
  // App opened 23 h 59 min late (the next occurrence is already in an hour).
  const late = sp.planTick([s], dueAt + 24 * HOUR - 60_000, new Set());
  assert.deepEqual(late.start, ['s1']);
  assert.deepEqual(late.missed, []);
  // Opened 25 h late.
  const now = dueAt + 25 * HOUR;
  const miss = sp.planTick([s], now, new Set());
  assert.deepEqual(miss.start, []);
  assert.deepEqual(miss.missed, ['s1']);
  const [out] = sp.applyPatches([s], miss.patches);
  assert.equal(out.lastStatus, 'missed');
  assert.equal(hhmm(out.nextRunAt), '2026-05-12 09:00');
  assert.equal(out.lastRunAt, undefined, 'a missed run is not a run');
});

test('several skipped occurrences run only once', () => {
  tz('UTC');
  // Closed for three days: due three days ago, 09:00 -> opening at 08:00 three days later is within... 71 h late -> missed.
  const s = live({ nextRunAt: at(2026, 5, 10, 9) });
  assert.deepEqual(sp.planTick([s], at(2026, 5, 13, 8), new Set()).start, []);
  // Closed overnight: one run, then the next regular slot.
  const plan = sp.planTick([s], at(2026, 5, 10, 22), new Set());
  assert.deepEqual(plan.start, ['s1']);
  assert.equal(hhmm(sp.applyPatches([s], plan.patches)[0].nextRunAt), '2026-05-11 09:00');
});

test('interval catch-up: one run, then a full interval from now', () => {
  tz('UTC');
  const now = at(2026, 5, 10, 15, 0);
  const s = live({ schedule: { kind: 'interval', everyMinutes: 60 }, nextRunAt: now - 5 * HOUR });
  const plan = sp.planTick([s], now, new Set());
  assert.deepEqual(plan.start, ['s1']);
  assert.equal(sp.applyPatches([s], plan.patches)[0].nextRunAt, now + HOUR);
  // The next tick a minute later does nothing.
  const [after] = sp.applyPatches([s], plan.patches);
  assert.deepEqual(sp.planTick([after], now + 60_000, new Set(['s1'])).start, []);
});

test('interval more than a day behind is missed and restarts from now', () => {
  tz('UTC');
  const now = at(2026, 5, 10, 15, 0);
  const s = live({ schedule: { kind: 'interval', everyMinutes: 30 }, nextRunAt: now - 30 * HOUR });
  const plan = sp.planTick([s], now, new Set());
  assert.deepEqual(plan.missed, ['s1']);
  assert.equal(sp.applyPatches([s], plan.patches)[0].nextRunAt, now + 30 * 60_000);
});

test('a missed one-off is recorded and switched off', () => {
  tz('UTC');
  const now = at(2026, 5, 10, 15, 0);
  const s = live({ schedule: { kind: 'once', at: now - 2 * 24 * HOUR }, nextRunAt: now - 2 * 24 * HOUR });
  const plan = sp.planTick([s], now, new Set());
  const [out] = sp.applyPatches([s], plan.patches);
  assert.deepEqual(plan.missed, ['s1']);
  assert.equal(out.enabled, false);
  assert.equal(out.nextRunAt, null);
});

test('a one-off that is slightly late runs once and is then switched off', () => {
  tz('UTC');
  const now = at(2026, 5, 10, 15, 0);
  const s = live({ schedule: { kind: 'once', at: now - 5 * 60_000 }, nextRunAt: now - 5 * 60_000 });
  const plan = sp.planTick([s], now, new Set());
  assert.deepEqual(plan.start, ['s1']);
  const [out] = sp.applyPatches([s], plan.patches);
  assert.equal(out.enabled, false);
  assert.deepEqual(sp.planTick([out], now + 1000, new Set()).start, []);
});

test('no overlap: an occurrence that comes due while the previous run is active is dropped', () => {
  tz('UTC');
  const now = at(2026, 5, 10, 12, 0);
  const s = live({ schedule: { kind: 'interval', everyMinutes: 5 }, nextRunAt: now, lastStatus: 'running' });
  const plan = sp.planTick([s], now, new Set(['s1']));
  assert.deepEqual(plan.start, []);
  assert.deepEqual(plan.missed, []);
  assert.equal(sp.applyPatches([s], plan.patches)[0].nextRunAt, now + 5 * 60_000, 'the skipped slot does not pile up');
});

test('at most two scheduled runs at once; the others stay due', () => {
  tz('UTC');
  const now = at(2026, 5, 10, 12, 0);
  const list = ['a', 'b', 'c'].map((id, i) => live({ id, nextRunAt: now - (3 - i) * 60_000 }));
  const plan = sp.planTick(list, now, new Set());
  assert.deepEqual(plan.start, ['a', 'b'], 'oldest first');
  const after = sp.applyPatches(list, plan.patches);
  assert.equal(after[2].nextRunAt, now - 60_000, 'not advanced, still due');
  assert.deepEqual(sp.planTick(after, now + 1000, new Set(['a'])).start, ['c']);
  assert.deepEqual(sp.planTick(after, now + 1000, new Set(['a', 'b'])).start, []);
});

test('finishPatch records status, error and chat', () => {
  assert.deepEqual(sp.finishPatch('success', 7), { lastStatus: 'success', lastError: undefined, lastChatId: 7 });
  assert.equal(sp.finishPatch('failed', null, 'x'.repeat(500)).lastError.length, 300);
  assert.equal('lastChatId' in sp.finishPatch('failed', null, 'boom'), false);
});

// ---- access, confirmation, validation ----

test('access is capped to the lower of the chosen mode and auto', () => {
  assert.equal(sp.capAccess('readonly'), 'readonly');
  assert.equal(sp.capAccess('auto'), 'auto');
  assert.equal(sp.capAccess('full'), 'auto');
  assert.equal(sp.capAccess(undefined), 'readonly');
  assert.equal(sp.capAccess('root'), 'readonly');
  assert.equal(sp.createSchedule(draft({ access: 'full' }), 'x', 0).access, 'auto');
  assert.equal(sp.editSchedule(item(), draft({ access: 'full' })).access, 'auto');
  const stored = sp.normalizeScheduled([{ ...item(), access: 'full' }]);
  assert.equal(stored[0].access, 'auto', 'hand-edited settings cannot grant full access');
});

test('a new schedule is off; enabling is explicit and recorded', () => {
  tz('UTC');
  const s = sp.createSchedule(draft(), 'x', 5);
  assert.equal(s.enabled, false);
  const on = sp.setEnabled(s, true, at(2026, 5, 10, 8));
  assert.equal(on.enabled, true);
  assert.equal(on.confirmedAt, at(2026, 5, 10, 8));
  assert.equal(hhmm(on.nextRunAt), '2026-05-10 09:00');
  const off = sp.setEnabled(on, false, 0);
  assert.equal(off.enabled, false);
  assert.equal(off.nextRunAt, null);
});

test('stored "enabled" without a confirmation loads as disabled', () => {
  const raw = [{ ...item(), enabled: true }, { ...item({ id: 's2' }), enabled: true, confirmedAt: 5 }];
  const [a, b] = sp.normalizeScheduled(raw);
  assert.equal(a.enabled, false);
  assert.equal(b.enabled, true);
});

test('editing what runs or when switches the schedule off; editing the title does not', () => {
  const on = live({ nextRunAt: 100 });
  assert.equal(sp.editSchedule(on, draft({ title: 'Renamed' })).enabled, true);
  for (const change of [{ prompt: 'Do something else' }, { projectId: 2 }, { model: 'other' }, { providerId: 'q' }, { access: 'readonly' }, { schedule: { kind: 'daily', time: '10:00' } }]) {
    const out = sp.editSchedule(on, draft(change));
    assert.equal(out.enabled, false, JSON.stringify(change));
    assert.equal(out.confirmedAt, undefined);
    assert.equal(out.nextRunAt, null);
  }
});

test('validation: required fields, interval minimum, time format, one-off in the past, limit', () => {
  const now = at(2026, 5, 10, 12);
  const ok = (d, count = 0) => sp.validateDraft(draft(d), now, count);
  assert.deepEqual(ok({}), []);
  assert.deepEqual(ok({ title: '   ' }), ['title']);
  assert.deepEqual(ok({ prompt: '  ' }), ['prompt']);
  assert.deepEqual(ok({ prompt: 'x'.repeat(sp.MAX_PROMPT + 1) }), ['promptLong']);
  assert.deepEqual(ok({ providerId: '' }), ['provider']);
  assert.deepEqual(ok({ schedule: { kind: 'interval', everyMinutes: 4 } }), ['interval']);
  assert.deepEqual(ok({ schedule: { kind: 'interval', everyMinutes: 5 } }), []);
  assert.deepEqual(ok({ schedule: { kind: 'interval', everyMinutes: 7.5 } }), ['interval']);
  assert.deepEqual(ok({ schedule: { kind: 'interval', everyMinutes: sp.MAX_INTERVAL_MINUTES + 1 } }), ['interval']);
  assert.deepEqual(ok({ schedule: { kind: 'daily', time: '25:00' } }), ['time']);
  assert.deepEqual(ok({ schedule: { kind: 'weekdays', time: '9' } }), ['time']);
  assert.deepEqual(ok({ schedule: { kind: 'once', at: now - 1 } }), ['once']);
  assert.deepEqual(ok({ schedule: { kind: 'once', at: now + 1 } }), []);
  assert.deepEqual(ok({}, sp.MAX_SCHEDULES), ['limit']);
  assert.equal(sp.canAddSchedule(19), true);
  assert.equal(sp.canAddSchedule(20), false);
});

test('normalizing stored data: clamps intervals, drops garbage, caps the count', () => {
  const raw = [
    { ...item({ id: 'a' }), schedule: { kind: 'interval', everyMinutes: 1 } },
    { ...item({ id: 'b' }), schedule: { kind: 'daily', time: 'noon' } },
    { ...item({ id: 'c' }), prompt: '   ' },
    { ...item({ id: 'a' }) },
    null,
    'x',
    { ...item({ id: 'd' }), schedule: { kind: 'daily', time: '7:05' }, lastStatus: 'weird', projectId: 'nope' },
  ];
  const out = sp.normalizeScheduled(raw);
  assert.deepEqual(out.map((s) => s.id), ['a', 'd']);
  assert.equal(out[0].schedule.everyMinutes, sp.MIN_INTERVAL_MINUTES);
  assert.equal(out[1].schedule.time, '07:05');
  assert.equal(out[1].lastStatus, undefined);
  assert.equal(out[1].projectId, null);
  const many = Array.from({ length: 30 }, (_, i) => item({ id: `s${i}` }));
  assert.equal(sp.normalizeScheduled(many).length, sp.MAX_SCHEDULES);
  assert.deepEqual(sp.normalizeScheduled('nope'), []);
});

test('a run that was active when the app closed becomes interrupted', () => {
  assert.equal(sp.recoverInterrupted([item({ lastStatus: 'running' })])[0].lastStatus, 'interrupted');
  assert.equal(sp.recoverInterrupted([item({ lastStatus: 'success' })])[0].lastStatus, 'success');
});

test('chat title carries the alarm-clock prefix', () => {
  assert.equal(sp.chatTitle({ title: 'Nightly' }), '⏰ Nightly');
});
