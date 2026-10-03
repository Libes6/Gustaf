import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cursorAccountEnv, reserveFor, profileName, PROFILE_NAME } from '../src/providers/cursorAccounts.ts';
const primary = {id:'primary',cli:'cursor-agent',backupProviderId:'reserve'};
const backup = {id:'reserve',cli:'cursor-agent',cliAuth:'key'};
test('separate CLI credentials stay out of provider config; missing key cannot use shared login', () => {
 assert.deepEqual(cursorAccountEnv(backup,' cursor_test '),{CURSOR_API_KEY:'cursor_test'});
 assert.throws(() => cursorAccountEnv(backup,''));
 assert.deepEqual(cursorAccountEnv(primary,'ignored'),{});
 assert.deepEqual(cursorAccountEnv({cli:'codex'},'ignored'),{});
});
test('profile accounts get an isolated config dir; bad or missing profile is refused', () => {
 const prof = {id:'p',cli:'cursor-agent',cliProfile:'acc-m1x2'};
 assert.deepEqual(cursorAccountEnv(prof,'','/data/cursor-profiles/acc-m1x2'),{CURSOR_CONFIG_DIR:'/data/cursor-profiles/acc-m1x2'});
 assert.throws(() => cursorAccountEnv(prof,''));
 assert.throws(() => cursorAccountEnv({...prof,cliProfile:'../x'},'','/d'));
 // The profile wins over a stale key; an api key is never set for a profile account.
 assert.deepEqual(cursorAccountEnv({...prof,cliAuth:'key'},'k','/d'),{CURSOR_CONFIG_DIR:'/d'});
 assert.deepEqual(cursorAccountEnv({id:'c',cli:'claude',cliProfile:'acc-1'},'','/d'),{});
});
test('generated profile names are valid', () => {
 assert.match(profileName(1759480000000),PROFILE_NAME);
 for (const bad of ['','A','a/b','..','-a','a-','a b']) assert.doesNotMatch(bad,PROFILE_NAME);
});
test('backup must be distinct, enabled, keyed Cursor CLI and have the same model', () => {
 const models = [{providerId:'reserve',id:'model'}];
 assert.equal(reserveFor(primary,[primary,backup],'model',models),backup);
 assert.equal(reserveFor(primary,[primary,{...backup,disabled:true}],'model',models),undefined);
 assert.equal(reserveFor(primary,[primary,{...backup,cliAuth:undefined}],'model',models),undefined);
 assert.equal(reserveFor(primary,[primary,backup],'other',models),undefined);
 assert.equal(reserveFor({...primary,backupProviderId:'primary'},[primary,backup],'model',models),undefined);
});
