import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cursorAccountEnv, reserveFor } from '../src/providers/cursorAccounts.ts';
const primary = {id:'primary',cli:'cursor-agent',backupProviderId:'reserve'};
const backup = {id:'reserve',cli:'cursor-agent',cliAuth:'key'};
test('separate CLI credentials stay out of provider config; missing key cannot use shared login', () => {
 assert.deepEqual(cursorAccountEnv(backup,' cursor_test '),{CURSOR_API_KEY:'cursor_test'});
 assert.throws(() => cursorAccountEnv(backup,''));
 assert.deepEqual(cursorAccountEnv(primary,'ignored'),{});
 assert.deepEqual(cursorAccountEnv({cli:'codex'},'ignored'),{});
});
test('backup must be distinct, enabled, keyed Cursor CLI and have the same model', () => {
 const models = [{providerId:'reserve',id:'model'}];
 assert.equal(reserveFor(primary,[primary,backup],'model',models),backup);
 assert.equal(reserveFor(primary,[primary,{...backup,disabled:true}],'model',models),undefined);
 assert.equal(reserveFor(primary,[primary,{...backup,cliAuth:undefined}],'model',models),undefined);
 assert.equal(reserveFor(primary,[primary,backup],'other',models),undefined);
 assert.equal(reserveFor({...primary,backupProviderId:'primary'},[primary,backup],'model',models),undefined);
});
