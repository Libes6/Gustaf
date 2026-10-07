// Agent settings: normalization, model choice per type and allow-list, budget defaults and overrides, token ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const s = await import('../src/agent/agentSettings.ts');
const { DEFAULT_BUDGETS, HARD_CAPS, resolveBudget } = await import('../src/agent/subagentCore.ts');
const runs = await import('../src/agent/agentRunsModel.ts');
const { withExtraTokens } = await import('../src/lib/budgets.ts');

const parent = { providerId: 'p', model: 'big' };
const cheap = { providerId: 'p', model: 'small' };
const other = { providerId: 'q', model: 'mid' };

test('normalizeAgentSettings drops junk and keeps valid values', () => {
  assert.deepEqual(s.normalizeAgentSettings(undefined), s.DEFAULT_AGENT_SETTINGS);
  const n = s.normalizeAgentSettings({
    models: { explore: cheap, plan: { providerId: '', model: 'x' }, bogus: other },
    allowedModels: [other, other, { providerId: 'q' }, cheap],
    budgets: { general: { maxSteps: 12.7, maxToolCalls: -1, maxMs: 'x', maxTokens: 1e12 }, review: {} },
    cheapModel: cheap,
    cancelDependents: false,
    notifications: 0,
  });
  assert.deepEqual(n.models, { explore: cheap });
  assert.deepEqual(n.allowedModels, [other, cheap]);
  assert.deepEqual(n.budgets, { general: { maxSteps: 12, maxTokens: HARD_CAPS.maxTokens } });
  assert.deepEqual(n.cheapModel, cheap);
  assert.equal(n.cancelDependents, false);
  assert.equal(n.notifications, true, 'only an explicit false turns notifications off');
});

test('selectModel: explicit request from the allow-list, else the type default, else the parent', () => {
  const st = s.normalizeAgentSettings({ models: { explore: cheap }, allowedModels: [other] });
  assert.deepEqual(s.selectModel('explore', st, parent), { ok: true, ref: cheap, source: 'type' });
  assert.deepEqual(s.selectModel('general', st, parent), { ok: true, ref: parent, source: 'parent' });
  assert.deepEqual(s.selectModel('general', st, parent, 'q/mid'), { ok: true, ref: other, source: 'requested' });
  assert.deepEqual(
    s.selectModel('general', st, parent, 'mid'),
    { ok: true, ref: other, source: 'requested' },
    'unambiguous model id',
  );
  assert.deepEqual(
    s.selectModel('general', st, parent, 'small'),
    { ok: true, ref: cheap, source: 'requested' },
    'type defaults are allowed',
  );
  assert.deepEqual(s.selectModel('explore', st, parent, 'p/big'), { ok: true, ref: parent, source: 'parent' });
  const denied = s.selectModel('general', st, parent, 'x/huge');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /not allowed.*p\/big, p\/small, q\/mid/);
  assert.deepEqual(
    s.selectModel('general', st, parent, '  '),
    { ok: true, ref: parent, source: 'parent' },
    'blank = no request',
  );
  // Ambiguous bare id is refused.
  const amb = s.normalizeAgentSettings({
    allowedModels: [
      { providerId: 'a', model: 'm' },
      { providerId: 'b', model: 'm' },
    ],
  });
  assert.equal(s.matchModelArg('m', s.allowedRefs(amb, parent)), null);
  assert.equal(s.selectModel('explore', amb, parent, 'm').ok, false);
});

test('cheapModelFor uses the configured model only when usable', () => {
  const st = s.normalizeAgentSettings({ cheapModel: cheap });
  assert.deepEqual(
    s.cheapModelFor(st, parent, () => true),
    cheap,
  );
  assert.deepEqual(
    s.cheapModelFor(st, parent, () => false),
    parent,
  );
  assert.deepEqual(
    s.cheapModelFor(s.DEFAULT_AGENT_SETTINGS, parent, () => true),
    parent,
  );
});

test('budget defaults per type, user overrides per field, hard caps', () => {
  const st = s.normalizeAgentSettings({ budgets: { explore: { maxToolCalls: 5 }, general: { maxMs: 1e12 } } });
  assert.deepEqual(resolveBudget('explore', st.budgets), { ...DEFAULT_BUDGETS.explore, maxToolCalls: 5 });
  assert.equal(resolveBudget('general', st.budgets).maxMs, HARD_CAPS.maxMs);
  assert.deepEqual(resolveBudget('plan', st.budgets), DEFAULT_BUDGETS.plan);
  assert.equal(s.budgetValue('maxSteps', 0), undefined);
});

test('token ledger: per day and chat, bounded, and added to budget totals', () => {
  let l = runs.EMPTY_LEDGER;
  l = runs.addToLedger(l, '2026-10-01', 7, 100);
  l = runs.addToLedger(l, '2026-10-01', undefined, 50);
  l = runs.addToLedger(l, '2026-10-02', 7, 0);
  assert.equal(runs.ledgerDay(l, '2026-10-01'), 150);
  assert.equal(runs.ledgerChat(l, 7), 100);
  assert.equal(runs.ledgerChat(l, null), 0);
  for (let d = 1; d <= 40; d++) l = runs.addToLedger(l, `2026-11-${String(d).padStart(2, '0')}`, d, 1);
  assert.equal(Object.keys(l.days).length, runs.MAX_LEDGER_DAYS);
  assert.equal(runs.ledgerDay(l, '2026-10-01'), 0, 'oldest day dropped');
  for (let c = 0; c < runs.MAX_LEDGER_CHATS + 5; c++) l = runs.addToLedger(l, '2026-12-01', 1000 + c, 1);
  l = runs.addToLedger(l, '2026-12-01', 1000, 1); // fell off, starts again as the most recent
  assert.equal(Object.keys(l.chats).length, runs.MAX_LEDGER_CHATS);
  assert.equal(runs.ledgerChat(l, 1000), 1);
  assert.equal(runs.ledgerChat(l, 1001 + runs.MAX_LEDGER_CHATS), 1);
  assert.deepEqual(runs.normalizeLedger(JSON.parse(JSON.stringify(l))), l);
  assert.deepEqual(runs.normalizeLedger({ days: { bad: 1, '2026-01-01': -3 }, chats: { 5: 2 } }), {
    days: {},
    chats: {},
  });

  assert.equal(withExtraTokens(undefined, 10), undefined, 'unreadable stays unreadable');
  assert.deepEqual(withExtraTokens({ tokens: 5, counted: 1, missing: 0 }, 10), { tokens: 15, counted: 2, missing: 0 });
  assert.deepEqual(withExtraTokens({ tokens: 5, counted: 1, missing: 2 }, 0), { tokens: 5, counted: 1, missing: 2 });
});
