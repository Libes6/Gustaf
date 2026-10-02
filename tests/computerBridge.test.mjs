import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseComputerRequest, replayDesktop, withComputer } from '../src/providers/computerBridge.ts';
const request = '```mcode-computer\n{"actions":[{"type":"screenshot"}]}\n```';
test('desktop protocol accepts requests, rejects unknown actions and excessive wait', () => {
 assert.equal(parseComputerRequest('ordinary reply'), undefined);
 assert.equal(parseComputerRequest(request).computer.actions[0].type, 'screenshot');
 assert.throws(() => parseComputerRequest(request + request));
 assert.throws(() => parseComputerRequest('```mcode-computer\n{"actions":[{"type":"shell"}]}\n```'));
 assert.throws(() => parseComputerRequest('```mcode-computer\n{"actions":[{"type":"wait","ms":999999}]}\n```'));
});
test('adapter bridge forwards screenshot results and preserves selected model', async () => {
 let received;
 const raw = { supportsComputer: false, turn: async t => { received = t; return { parts: [{type:'text',text:request}] }; } };
 const wrapped = withComputer(raw, false);
 const result = await wrapped.turn({model:'chosen-model',system:'system',computer:{width:1440,height:900},messages:[{role:'tool',parts:[{type:'tool_result',id:'x',name:'mcode_computer',output:'OK',image:'png-data'}]}]});
 assert.equal(wrapped.supportsComputer,true);
 assert.equal(received.model,'chosen-model');
 assert.equal(received.computer,undefined);
 assert.equal(received.messages[0].role,'user');
 assert.equal(received.messages[0].parts[1].type,'image');
 assert.equal(result.parts[1].name,'mcode_computer');
});
test('open_app is parsed and validated; names are trimmed', () => {
 const block = (a) => '```mcode-computer\n' + JSON.stringify({ actions: a }) + '\n```';
 assert.deepEqual(parseComputerRequest(block([{type:'open_app',name:' Telegram '}])).computer.actions, [{type:'open_app',name:'Telegram'}]);
 assert.throws(() => parseComputerRequest(block([{type:'open_app',name:'/Applications/Telegram.app'}])), /not a path/);
 assert.throws(() => parseComputerRequest(block([{type:'open_app',name:'-a'}])));
 assert.throws(() => parseComputerRequest(block([{type:'open_app'}])));
});
test('CLI replay attaches only the newest screenshot as an image part', async () => {
 const call = (id) => ({ role:'assistant', meta:{provider:'cli',responseId:'s'+id}, parts:[{type:'text',text:'acting'},{type:'tool_call',id,name:'mcode_computer',args:{actions:[{type:'screenshot'}]}}] });
 const result = (id, image) => ({ role:'tool', parts:[{type:'tool_result',id,name:'mcode_computer',output:'Executed 1 action. Front app: Telegram.',image}] });
 const history = [{role:'user',parts:[{type:'text',text:'open telegram'}]}, call('a'), result('a','old-png'), call('b'), result('b','new-png')];
 const cli = replayDesktop(history, true);
 assert.equal(cli[2].role, 'user');
 assert.ok(!cli[2].parts.some(p => p.type === 'image'), 'the older screenshot is dropped');
 assert.match(cli[2].parts[0].text, /Older screenshot omitted/);
 assert.deepEqual(cli[4].parts.filter(p => p.type === 'image'), [{type:'image',data:'new-png'}]);
 assert.match(cli[4].parts[0].text, /Desktop result: Executed 1 action\. Front app: Telegram\. The resulting screenshot is attached/);
 assert.ok(!JSON.stringify(cli).includes('Inspect this screenshot file'));
 // The CLI adapter's resume logic then forwards exactly that image, resumed or replayed.
 const { turnImages } = await import('../src/providers/cliArgs.ts');
 assert.deepEqual(turnImages(cli.slice(4), true), ['new-png']);
 assert.deepEqual(turnImages(cli, false), ['new-png']);
 // API providers keep every screenshot inline.
 const api = replayDesktop(history, false);
 assert.equal(api[2].parts.filter(p => p.type === 'image').length, 1);
});
