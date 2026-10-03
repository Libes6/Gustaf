import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexArgs, withImagePaths, turnImages } from '../src/providers/cliArgs.ts';
import { claudeArgs } from '../src/providers/claudeCli.ts';
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
test('Codex attaches images as --image= flags before the options that end the list, keeping model and session last',()=>{
 const fresh=codexArgs({access:'auto',model:'m',images:['/a b/1.png','/a b/2.jpg']});
 assert.deepEqual(fresh.filter(a=>a.startsWith('--image')),['--image=/a b/1.png','--image=/a b/2.jpg']);
 assert.equal(fresh.includes('-i'),false);
 // each image flag is followed by another option, so a variadic -i parser can not swallow the prompt
 fresh.forEach((a,i)=>{ if (a.startsWith('--image=')) assert.ok(fresh[i+1].startsWith('-'),'image flag followed by positional'); });
 const resumed=codexArgs({session:'sid',access:'auto',images:['/x/1.png']});
 assert.equal(resumed[1],'resume');
 assert.equal(resumed.at(-1),'sid');
 assert.equal(resumed.includes('--image=/x/1.png'),true);
});
test('image paths are appended to the prompt for CLIs without an image flag',()=>{
 assert.equal(withImagePaths('hello',[]),'hello');
 const p=withImagePaths('hello',['/data/attachments/3/1.png','/data/attachments/3/2.jpg']);
 assert.equal(p,'hello\n\nAttached image: /data/attachments/3/1.png (read it with your file-reading tool)\nAttached image: /data/attachments/3/2.jpg (read it with your file-reading tool)');
});
test('Claude adds the attachment folder with a single =-joined --add-dir before the other options',()=>{
 const args=claudeArgs({access:'auto',model:'sonnet',session:'s',addDir:'/data/attachments/3'});
 assert.equal(args[1],'--add-dir=/data/attachments/3');
 assert.deepEqual(args.slice(-4),['--model','sonnet','--resume','s']);
 assert.equal(claudeArgs({access:'auto'}).some(a=>a.startsWith('--add-dir')),false);
});
const img=(data)=>({type:'image',data}); const user=(...parts)=>({role:'user',parts}); const asst=()=>({role:'assistant',parts:[{type:'text',text:'x'}]});
test('only the new turn images are sent',()=>{
 assert.deepEqual(turnImages([user({type:'text',text:'t'},img('NEW'))],true),['NEW']);
 assert.deepEqual(turnImages([user(img('A')),user(img('B'))],true),['A','B']);
 // replayed history: old images stay out, only the latest user message counts
 assert.deepEqual(turnImages([user(img('OLD')),asst(),user({type:'text',text:'t'},img('NEW'))],false),['NEW']);
 assert.deepEqual(turnImages([user({type:'text',text:'t'})],true),[]);
});

test('branched history without response ids starts a fresh native session and retains recorded image context', async () => {
  const { resumePoint } = await import('../src/providers/cliArgs.ts');
  const copied = [
    { role: 'user', parts: [{ type: 'text', text: 'Inspect attachment' }, { type: 'image', data: 'AA' }], meta: { branchHistory: true } },
    { role: 'assistant', parts: [{ type: 'text', text: 'Recorded result' }], meta: { provider: 'codex' } },
    { role: 'user', parts: [{ type: 'text', text: 'Continue the branch' }] },
  ];
  const point = resumePoint({ messages: copied, system: 'sys' }, 'codex', false);
  assert.equal(point.session, undefined);
  assert.ok(point.prompt.includes('Recorded result'));
  assert.ok(point.prompt.includes('Continue the branch'));
  assert.deepEqual(point.images, ['AA']);
});
