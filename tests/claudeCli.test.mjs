import { test } from 'node:test';
import assert from 'node:assert/strict';
import {claudeArgs,parseClaudeEvent} from '../src/providers/claudeCli.ts';
test('Claude preserves permission mode, chosen model and resumed session',()=>{
 for (const [access,mode] of [['readonly','plan'],['auto','acceptEdits'],['full','bypassPermissions']]) {
  const args=claudeArgs({access,model:'sonnet',session:'session'});
  assert.equal(args[args.indexOf('--permission-mode')+1],mode);
  assert.deepEqual(args.slice(-4),['--model','sonnet','--resume','session']);
 }
});
test('Claude stream does not duplicate aggregate text and retains real errors',()=>{
 assert.equal(parseClaudeEvent({type:'stream_event',event:{delta:{type:'text_delta',text:'hello'}}}).text,'hello');
 assert.equal(parseClaudeEvent({type:'assistant',session_id:'id',message:{content:[{type:'text',text:'hello'},{type:'tool_use',name:'Read'}]}}).text,undefined);
 assert.equal(parseClaudeEvent({type:'result',session_id:'id',is_error:true,errors:['Not logged in']}).error,'Not logged in');
});
