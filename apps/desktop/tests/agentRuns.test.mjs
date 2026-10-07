import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

register('./helpers/hooks.mjs', import.meta.url);
const { state, db } = await import('./helpers/apiStub.mjs');
const m = await import('../src/agent/agentRunsModel.ts');
const t = await import('../src/agent/agentTranscript.ts');
const store = await import('../src/agent/agentRuns.ts');

const dict = Object.fromEntries(
  ['en', 'ru'].map((l) => [l, JSON.parse(readFileSync(new URL(`../src/i18n/${l}.json`, import.meta.url), 'utf8'))]),
);

const run = (over = {}) => ({
  id: 'r1',
  title: 'T',
  type: 'explore',
  providerId: 'p',
  model: 'mod',
  projectRoot: '/proj',
  status: 'completed',
  createdAt: 1000,
  startedAt: 1000,
  endedAt: 5000,
  tokens: 10,
  toolUses: 2,
  currentStep: '',
  transcript: [],
  ...over,
});

test('normalization drops junk, clips fields and bounds the transcript', () => {
  assert.deepEqual(m.normalizeRuns('nope'), []);
  const long = 'x'.repeat(5000);
  const raw = [
    run({
      id: 'ok',
      title: long,
      summary: long,
      transcript: Array.from({ length: 500 }, (_, i) => ({
        at: i,
        kind: 'tool',
        tool: 'read_file',
        text: long,
        result: long,
      })),
    }),
    { id: 'bad-type', type: 'root', status: 'completed' },
    { id: 'bad-status', type: 'plan', status: 'weird' },
    null,
    run({ id: 'steps', transcript: [{ kind: 'bogus' }, { kind: 'text', text: 'hi', at: 1 }, 5] }),
  ];
  const out = m.normalizeRuns(raw);
  assert.deepEqual(
    out.map((r) => r.id),
    ['ok', 'steps'],
  );
  assert.ok(out[0].title.length <= 80);
  assert.ok(out[0].summary.length <= m.MAX_SUMMARY);
  assert.equal(out[0].transcript.length, m.MAX_STEPS_PERSISTED);
  assert.ok(out[0].transcript[0].text.length <= m.MAX_STEP_TEXT);
  assert.deepEqual(
    out[1].transcript.map((s) => s.text),
    ['hi'],
  );
});

test('runs that were active when the app stopped load as interrupted', () => {
  const out = m.normalizeRuns(
    [
      run({ id: 'a', status: 'running', endedAt: undefined, currentStep: 'read_file x' }),
      run({ id: 'b', status: 'queued', endedAt: undefined }),
      run({ id: 'c' }),
    ],
    9000,
  );
  assert.deepEqual(
    out.map((r) => r.status),
    ['interrupted', 'interrupted', 'completed'],
  );
  assert.equal(out[0].endedAt, 9000);
  assert.equal(out[0].currentStep, '');
  assert.equal(out[2].endedAt, 5000);
});

test('the list is bounded: every active run is kept, the oldest finished ones go first', () => {
  const runs = [
    ...Array.from({ length: m.MAX_RUNS + 20 }, (_, i) => run({ id: `d${i}`, createdAt: 100 + i })),
    run({ id: 'live', status: 'running', createdAt: 1, endedAt: undefined }),
  ];
  const out = m.boundRuns(runs);
  assert.equal(out.length, m.MAX_RUNS);
  assert.ok(out.some((r) => r.id === 'live'));
  assert.ok(!out.some((r) => r.id === 'd0'));
  assert.equal(out.find((r) => r.id === `d${m.MAX_RUNS + 19}`) !== undefined, true);
  assert.equal(m.boundRuns(runs, 5).length, 5);
});

test('merging keeps this session in front and wins by id', () => {
  const merged = m.mergeRuns(
    [run({ id: 'old', createdAt: 1 }), run({ id: 'same', title: 'from disk', createdAt: 2 })],
    [run({ id: 'same', title: 'live', createdAt: 3 })],
  );
  assert.deepEqual(
    merged.map((r) => [r.id, r.title]),
    [
      ['same', 'live'],
      ['old', 'T'],
    ],
  );
});

test('rows of agent_runs map to runs and back', () => {
  const r = run({
    id: 'x',
    chatId: 7,
    error: 'boom',
    summary: 'sum',
    changed: ['a.ts'],
    warnings: ['w'],
    status: 'budget',
    report: 'full report',
  });
  const p = m.runParams(r);
  assert.equal(p.length, 17);
  const row = {
    id: p[0],
    chat_id: p[1],
    title: p[2],
    type: p[3],
    model: p[4],
    status: p[5],
    started_at: p[6],
    ended_at: p[7],
    tokens: p[8],
    tool_uses: p[9],
    error: p[10],
    summary: p[11],
    provider_id: p[12],
    project_root: p[13],
    created_at: p[14],
    changed_json: p[15],
    warnings_json: p[16],
  };
  const back = m.runFromRow(row);
  const { report, ...rest } = r;
  assert.deepEqual(back, { ...rest, summary: report, transcript: [] });
  assert.equal(m.runFromRow({ ...row, status: 'weird' }), null);
  assert.equal(m.runFromRow({ ...row, type: 'root' }), null);
  assert.equal(m.runParams(run({}))[11], null, 'no report in memory keeps the stored one');
  assert.equal(m.runParams(run({ report: 'x'.repeat(20_000) }))[11].length, m.MAX_REPORT_STORED);
  assert.equal(
    m.appendStep(
      Array.from({ length: m.MAX_STEPS_IN_MEMORY }, (_, i) => ({ at: i, kind: 'note', text: '' })),
      { at: 999, kind: 'note', text: '' },
    ).length,
    m.MAX_STEPS_IN_MEMORY,
  );
});

test('elapsed time and token formatting', () => {
  const t = (key, vars) => dict.en[key].replace('{n}', vars.n);
  assert.equal(m.elapsed({ status: 'running', startedAt: 1000 }, 66_000, t), '1 min 5 s');
  assert.equal(m.elapsed({ status: 'running', startedAt: 1000 }, 16_000, t), '15 s');
  assert.equal(m.elapsed({ status: 'completed', startedAt: 0 + 1, endedAt: 3_700_001 }, 9e9, t), '1 h 1 min');
  assert.equal(m.elapsed({ status: 'queued', startedAt: 0 }, 5000, t), '');
  // A running timer keeps ticking past the hour mark; agents started at different times differ.
  const at = (s0, now) => m.elapsed({ status: 'running', startedAt: s0 }, now, t);
  assert.equal(at(1, 59_001), '59 s');
  assert.equal(at(1, 60_001), '1 min 0 s');
  assert.equal(at(1, 3_599_001), '59 min 59 s');
  assert.equal(at(1, 3_600_001), '1 h 0 min 0 s');
  assert.equal(at(1, 3_612_001), '1 h 0 min 12 s');
  assert.equal(at(1, 3_613_001), '1 h 0 min 13 s');
  assert.equal(at(1, 3 * 3_600_000 + 61_000), '3 h 1 min 0 s');
  assert.notEqual(at(1, 3_700_000), at(30_001, 3_700_000));
  assert.equal(m.elapsed({ status: 'completed', startedAt: 1, endedAt: 3_612_001 }, 9e9, t), '1 h 0 min');
  assert.equal(m.formatTokens(999), '999');
  assert.equal(m.formatTokens(1500), '1.5k');
  assert.equal(m.formatTokens(25_000), '25k');
  assert.equal(m.formatTokens(2_500_000), '2.5M');
  assert.equal(m.runTokens({ input: 3, output: 4 }), 7);
  assert.equal(m.runTokens(undefined), 0);
});

const table = (sql, ...params) =>
  db
    .raw()
    .prepare(sql)
    .all(...params);

test('store: runs and messages are written to SQLite; a restart marks unfinished runs interrupted', async () => {
  state.reset();
  store.resetAgentRuns();
  const id = store.createRun(
    { title: 'Live', type: 'general', providerId: 'p', model: 'm', projectRoot: '/proj' },
    () => {},
  );
  store.updateRun(id, { status: 'running', startedAt: Date.now() });
  store.recordMessage(id, 'user', [{ type: 'text', text: 'do it' }], 1);
  store.recordMessage(
    id,
    'assistant',
    [
      { type: 'text', text: 'reading' },
      { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a.ts' } },
    ],
    2,
  );
  store.recordMessage(id, 'tool', [{ type: 'tool_result', id: 'c1', name: 'read_file', output: 'file text' }], 3);
  store.recordStep(
    id,
    { at: 4, kind: 'note', text: 'a note', error: true },
    { tokens: 7, toolUses: 1 },
    'read_file a.ts',
  );
  const done = store.createRun(
    { title: 'Done', type: 'explore', providerId: 'p', model: 'm', projectRoot: '/proj' },
    () => {},
  );
  store.updateRun(done, { status: 'completed', endedAt: Date.now(), report: 'the report' });
  await store.settleAgentRunWrites();
  assert.deepEqual(
    table('select title from agent_runs order by title').map((r) => r.title),
    ['Done', 'Live'],
  );
  assert.equal(table("select tokens from agent_runs where title = 'Live'")[0].tokens, 7);
  assert.deepEqual(
    table('select seq, role from agent_messages where run_id = ? order by seq', id).map((r) => `${r.seq}:${r.role}`),
    ['0:user', '1:assistant', '2:tool', '3:note'],
  );
  assert.equal(table("select report from agent_runs where title = 'Done'")[0].report, 'the report');
  assert.deepEqual(state.dbErrors, []);

  // The transcript is read lazily from the table.
  const steps = await store.loadRunSteps(id);
  assert.deepEqual(
    steps.map((s) => [s.kind, s.tool, s.text, s.result]),
    [
      ['note', undefined, 'do it', undefined],
      ['text', undefined, 'reading', undefined],
      ['tool', 'read_file', 'a.ts', 'file text'],
      ['note', undefined, 'a note', undefined],
    ],
  );

  // "Restart": memory is gone, only the database remains.
  store.resetAgentRuns();
  await store.loadAgentRuns();
  const runs = store.getRuns();
  assert.equal(runs.find((r) => r.title === 'Live').status, 'interrupted');
  assert.ok(runs.find((r) => r.title === 'Live').endedAt);
  assert.equal(runs.find((r) => r.title === 'Done').status, 'completed');
  assert.equal(runs.find((r) => r.title === 'Done').summary, 'the report');
  assert.deepEqual(runs.find((r) => r.title === 'Live').transcript, [], 'steps are not kept in memory for loaded runs');
  // the interrupted state is written to the table, so a second restart sees the same
  assert.equal(table("select status from agent_runs where title = 'Live'")[0].status, 'interrupted');
  assert.equal((await store.loadRunSteps(id)).length, 4);
});

test('store: a run created before the stored ones are loaded is not marked interrupted', async () => {
  state.reset();
  store.resetAgentRuns();
  db.raw()
    .prepare("insert into agent_runs(id, title, type, status, created_at) values('old', 'Old', 'plan', 'running', 1)")
    .run();
  const id = store.createRun({ title: 'Now', type: 'plan', providerId: 'p', model: 'm', projectRoot: '/p' }, () => {});
  store.updateRun(id, { status: 'running', startedAt: 5 });
  await store.loadAgentRuns();
  const byTitle = Object.fromEntries(store.getRuns().map((r) => [r.title, r.status]));
  assert.deepEqual(byTitle, { Now: 'running', Old: 'interrupted' });
});

test('store: the old agentRuns setting is migrated once into the tables', async () => {
  state.reset();
  store.resetAgentRuns();
  const legacy = [
    run({
      id: 'l1',
      title: 'Legacy',
      summary: 'old report',
      transcript: [
        { at: 5, kind: 'tool', tool: 'search', text: 'x', result: 'r' },
        { at: 6, kind: 'text', text: 'said' },
      ],
    }),
    run({ id: 'l2', status: 'running', endedAt: undefined, createdAt: 2000 }),
  ];
  state.settings.set('agentRuns', JSON.stringify(legacy));
  await store.loadAgentRuns();
  assert.deepEqual(
    store.getRuns().map((r) => [r.id, r.status]),
    [
      ['l2', 'interrupted'],
      ['l1', 'completed'],
    ],
  );
  assert.deepEqual(JSON.parse(state.settings.get('agentRuns')), []);
  assert.equal(state.settings.get('agentRunsMigrated'), 'true');
  assert.equal(table("select report from agent_runs where id = 'l1'")[0].report, 'old report');
  assert.deepEqual(
    (await store.loadRunSteps('l1')).map((s) => [s.kind, s.tool, s.text, s.result]),
    [
      ['tool', 'search', 'x', 'r'],
      ['text', undefined, 'said', undefined],
    ],
  );
  // A second start neither duplicates nor resurrects anything.
  state.settings.set('agentRuns', JSON.stringify(legacy));
  store.resetAgentRuns();
  await store.loadAgentRuns();
  assert.equal(table('select count(*) as n from agent_runs')[0].n, 2);
  assert.equal(table('select count(*) as n from agent_messages')[0].n, 2);
  assert.deepEqual(state.dbErrors, []);
});

test('store: retention keeps the newest finished runs (and every active one); messages go with their run', async () => {
  state.reset();
  store.resetAgentRuns();
  const insert = db
    .raw()
    .prepare("insert into agent_runs(id, title, type, status, created_at) values(?, 't', 'plan', ?, ?)");
  for (let i = 0; i < m.MAX_RUNS + 30; i++) insert.run(`r${i}`, 'completed', 100 + i);
  insert.run('active', 'running', 1);
  db.raw()
    .prepare(
      "insert into agent_messages(run_id, seq, role, parts_json) values('r0', 0, 'user', '[]'), ('r229', 0, 'user', '[]')",
    )
    .run();
  store.createRun({ title: 'New', type: 'plan', providerId: 'p', model: 'm', projectRoot: '/p' }, () => {}); // pruning runs on creation
  await store.settleAgentRunWrites();
  const ids = table('select id from agent_runs').map((r) => r.id);
  assert.equal(ids.filter((i) => i.startsWith('r')).length, m.MAX_RUNS);
  assert.ok(ids.includes('active') && !ids.includes('r0') && ids.includes('r229'));
  assert.deepEqual(
    table('select run_id from agent_messages').map((r) => r.run_id),
    ['r229'],
  );
});

test('store: at most MAX_MESSAGES_PER_RUN messages are kept per run; removeFinished deletes rows', async () => {
  state.reset();
  store.resetAgentRuns();
  const id = store.createRun(
    { title: 'Chatty', type: 'plan', providerId: 'p', model: 'm', projectRoot: '/p' },
    () => {},
  );
  for (let i = 0; i < t.MAX_MESSAGES_PER_RUN + 5; i++)
    store.recordMessage(id, 'assistant', [{ type: 'text', text: 'x' }], i);
  await store.settleAgentRunWrites();
  assert.equal(table('select count(*) as n from agent_messages')[0].n, t.MAX_MESSAGES_PER_RUN);
  store.updateRun(id, { status: 'completed', endedAt: 1 });
  store.removeFinished();
  await store.settleAgentRunWrites();
  assert.equal(table('select count(*) as n from agent_runs')[0].n, 0);
  assert.equal(table('select count(*) as n from agent_messages')[0].n, 0, 'cascade');
});

test('store: stopRun calls the stopper of an active run only; removeFinished keeps active runs', async () => {
  state.reset();
  store.resetAgentRuns();
  let stopped = 0;
  const a = store.createRun(
    { title: 'A', type: 'plan', providerId: 'p', model: 'm', projectRoot: '/p1' },
    () => stopped++,
  );
  const b = store.createRun({ title: 'B', type: 'plan', providerId: 'p', model: 'm', projectRoot: '/p2' }, () => {});
  store.updateRun(b, { status: 'failed', endedAt: 1 });
  store.stopRun(a);
  store.stopRun(b); // finished: its stopper is gone
  assert.equal(stopped, 1);
  store.removeFinished();
  assert.deepEqual(
    store.getRuns().map((r) => r.title),
    ['A'],
  );
});
