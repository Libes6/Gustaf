import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseComputerRequest, withComputer } from '../src/providers/computerBridge.ts';
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
