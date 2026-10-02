import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexArgs } from '../src/providers/cliArgs.ts';
test('new Codex requests retain explicit sandbox permissions', () => {
 assert.deepEqual(codexArgs({access:'readonly'}), ['exec','--json','--skip-git-repo-check','--sandbox','read-only']);
});
test('resume uses supported config override and preserves session, model and access', () => {
 const args = codexArgs({session:'session-id', model:'gpt-model', access:'auto'});
 assert.equal(args.includes('--sandbox'), false);
 assert.equal(args.includes('sandbox_mode="workspace-write"'), true);
 assert.deepEqual(args.slice(-3), ['-m','gpt-model','session-id']);
 assert.equal(codexArgs({session:'session-id', access:'readonly'}).includes('sandbox_mode="read-only"'), true);
 assert.equal(codexArgs({session:'session-id', access:'full'}).includes('--dangerously-bypass-approvals-and-sandbox'), true);
});
