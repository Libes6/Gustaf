// Names from before the rename to Gustaf that are still read (never written): the `.mcode/` project folder, `mcode-plan`
// and `mcode-computer` blocks, the `mcode_computer` tool name in stored chats and the `mcode-chats` export format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { LEGACY_PROJECT_DIR, PROJECT_DIR, legacyProjectPath, readProjectFile } =
  await import('../src/lib/projectFolder.ts');
const { assembleReviewRules, REVIEW_RULES_PATH } = await import('../src/lib/autoReview.ts');
const { PROJECT_HOOKS_FILE } = await import('../src/agent/hooksCore.ts');
const { PROJECT_DONE_FILE } = await import('../src/agent/verificationCore.ts');
const { PLAN_FENCE, PLAN_PROMPT, extractPlan, serializePlan } = await import('../src/agent/planCore.ts');
const { COMPUTER_PROTOCOL, parseComputerRequest, replayDesktop } = await import('../src/providers/computerBridge.ts');
const { BRIDGE_COMPUTER_TOOL, isBridgeComputerTool } = await import('../src/agent/computerCore.ts');
const { EXPORT_FORMAT, LEGACY_EXPORT_FORMAT, buildBundle, parseBundle } = await import('../src/lib/exportChats.ts');

test('project files live in .gustaf/ and fall back to .mcode/', async () => {
  assert.equal(PROJECT_DIR, '.gustaf');
  for (const p of [PROJECT_HOOKS_FILE, PROJECT_DONE_FILE, REVIEW_RULES_PATH]) assert.ok(p.startsWith('.gustaf/'), p);
  assert.equal(legacyProjectPath('.gustaf/hooks.json'), `${LEGACY_PROJECT_DIR}/hooks.json`);
  assert.equal(legacyProjectPath('src/.gustaf/x'), null);

  const files = (map) => async (path) => {
    if (path in map) return map[path];
    throw new Error(`missing ${path}`);
  };
  assert.deepEqual(
    await readProjectFile(files({ '.gustaf/done.json': 'new', '.mcode/done.json': 'old' }), '.gustaf/done.json'),
    { value: 'new', path: '.gustaf/done.json' },
  );
  assert.deepEqual(await readProjectFile(files({ '.mcode/done.json': 'old' }), '.gustaf/done.json'), {
    value: 'old',
    path: '.mcode/done.json',
  });
  await assert.rejects(readProjectFile(files({}), '.gustaf/done.json'), /missing \.gustaf\/done\.json/);
  await assert.rejects(readProjectFile(files({ '.mcode/other': 'x' }), 'README.md'), /missing README\.md/);

  // Review rules read from the legacy file name that path in the prompt.
  const rules = assembleReviewRules('Check SQL.', undefined, '.mcode/REVIEW.md');
  assert.equal(rules.path, '.mcode/REVIEW.md');
  assert.match(rules.text, /path="\.mcode\/REVIEW\.md"/);
});

test('plan blocks: written as gustaf-plan, mcode-plan still parsed', () => {
  assert.equal(PLAN_FENCE, 'gustaf-plan');
  assert.match(PLAN_PROMPT, /```gustaf-plan/);
  assert.ok(serializePlan({ title: 't', steps: [{ id: '1', text: 'a' }] }).startsWith('```gustaf-plan\n'));
  assert.equal(extractPlan('```mcode-plan\n{"steps":["old"]}\n```').plan.steps[0].text, 'old');
  assert.equal(extractPlan('```gustaf-plan\n{"steps":["new"]}\n```').plan.steps[0].text, 'new');
});

test('desktop bridge: asks for gustaf-computer, accepts mcode-computer and the old tool name', () => {
  assert.match(COMPUTER_PROTOCOL, /gustaf-computer/);
  assert.doesNotMatch(COMPUTER_PROTOCOL, /mcode/);
  const legacy = parseComputerRequest('```mcode-computer\n{"actions":[{"type":"screenshot"}]}\n```');
  assert.equal(legacy.name, BRIDGE_COMPUTER_TOOL);
  assert.equal(BRIDGE_COMPUTER_TOOL, 'gustaf_computer');
  assert.ok(
    isBridgeComputerTool('mcode_computer') &&
      isBridgeComputerTool('gustaf_computer') &&
      !isBridgeComputerTool('computer'),
  );
  // A stored chat from before the rename is still replayed as desktop history.
  const old = [
    {
      role: 'assistant',
      parts: [{ type: 'tool_call', id: 'a', name: 'mcode_computer', args: { actions: [{ type: 'screenshot' }] } }],
    },
  ];
  assert.deepEqual(
    replayDesktop(old, false)[0].parts.map((p) => p.type),
    ['text'],
  );
});

test('chat export: written as gustaf-chats, mcode-chats still imported', () => {
  assert.equal(EXPORT_FORMAT, 'gustaf-chats');
  assert.equal(LEGACY_EXPORT_FORMAT, 'mcode-chats');
  assert.equal(buildBundle([], { now: 0 }).format, 'gustaf-chats');
  const chats = [{ title: 'Old', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }];
  for (const format of ['mcode-chats', 'gustaf-chats']) {
    assert.equal(parseBundle(JSON.stringify({ format, version: 1, app: 'M Code', chats })).chats[0].title, 'Old');
  }
});
