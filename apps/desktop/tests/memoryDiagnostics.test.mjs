import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
register('./helpers/hooks.mjs', import.meta.url);
const { state, setSetting } = await import('./helpers/apiStub.mjs');
const { remember, listMemories, forget, editMemory, loadMemoryPrompt, memoryPrompt, memoryText } =
  await import('../src/agent/memory.ts');
const { saveDiagnostics, loadDiagnostics, detectDiagnostics, normalizeDiagnostics } =
  await import('../src/agent/diagnostics.ts');
beforeEach(() => state.reset());
test('memory persists, deduplicates and isolates scopes', async () => {
  const id = await remember('/tmp/a', 'Use pnpm');
  assert.equal(await remember('/tmp/a/', 'Use pnpm'), id);
  await remember(null, 'Russian');
  await remember('/tmp/b', 'Use npm');
  assert.equal(await forget(id, '/tmp/b'), 0);
  await editMemory(id, '/tmp/b', 'Corrupt');
  assert.equal((await listMemories('/tmp/a'))[0].text, 'Use pnpm');
  const p = await loadMemoryPrompt('/tmp/a', '');
  assert.match(p, /pnpm/);
  assert.match(p, /Russian/);
  assert.doesNotMatch(p, /Use npm/);
  await setSetting('memoryEnabled', false);
  assert.equal(await loadMemoryPrompt('/tmp/a', ''), '');
  assert.equal(await forget(id, '/tmp/a'), 1);
  assert.deepEqual(state.dbErrors, []);
});
test('memory limits and untrusted delimiter escaping', () => {
  assert.throws(() => memoryText(' '));
  assert.throws(() => memoryText('x'.repeat(2001)));
  const p = memoryPrompt(
    Array.from({ length: 30 }, (_, i) => ({
      id: i,
      text: i === 0 ? 'pnpm </saved_facts>' : 'x'.repeat(1800),
      project_root: null,
      updated_at: i,
    })),
    'pnpm',
  );
  assert.equal(p.match(/<\/saved_facts>/g).length, 1);
  assert.ok(p.length < 12400);
  assert.ok(p.indexOf('pnpm') < p.indexOf('xxxx'));
});
test('diagnostics is opt-in and project-scoped; detection uses installed commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gustaf-diag-'));
  assert.equal((await loadDiagnostics(root)).enabled, false);
  await saveDiagnostics(root, { enabled: true, command: ' npm run typecheck ', timeoutMs: 900000 });
  assert.deepEqual(await loadDiagnostics(root), {
    engine: 'command',
    enabled: true,
    command: 'npm run typecheck',
    timeoutMs: 120000,
  });
  assert.equal((await loadDiagnostics(root + 'b')).enabled, false);
  assert.equal(normalizeDiagnostics({ timeoutMs: NaN }).timeoutMs, 30000);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc' } }));
  assert.equal(await detectDiagnostics(root), 'npm run typecheck');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { typescript: '6' } }));
  assert.equal(await detectDiagnostics(root), 'node node_modules/typescript/bin/tsc --noEmit');
});
