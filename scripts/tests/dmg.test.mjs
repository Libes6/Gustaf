import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dmgPaths, buildEnvironment, mergeConfig, notarizationArgs } from '../tauri.mjs';

test('only successful build output identifies exact app/dmg/all architecture artifacts', () => {
  assert.deepEqual(dmgPaths('Bundled /tmp/Gustaf.app (app)'), []);
  for (const arch of ['aarch64', 'x64', 'universal']) {
    const path = `/tmp/target/${arch}/release/bundle/dmg/Gustaf_0.1.0_${arch}.dmg`;
    assert.deepEqual(dmgPaths(`Bundling Gustaf (${path})\nBundled /tmp/Gustaf.app (app)\nBundling Gustaf (${path})`), [path]);
  }
});
test('mac build suppresses Finder for every bundle/config selection without changing arguments', () => {
  for (const args of [['build'], ['build','--bundles','app'], ['build','--bundles','dmg'], ['build','--bundles','all'], ['build','--config','mac.json']]) {
    assert.equal(buildEnvironment('darwin', args, { APPLE_ID: 'user', TAURI_SIGNING_PRIVATE_KEY: 'key' }).CI, 'true');
    assert.equal(buildEnvironment('darwin', args, { TAURI_SIGNING_PRIVATE_KEY: 'key' }).TAURI_SIGNING_PRIVATE_KEY, 'key');
  }
  assert.deepEqual(buildEnvironment('linux', ['build'], { CI: 'true' }), { CI: 'true' });
  assert.deepEqual(buildEnvironment('darwin', ['dev'], {}), {});
});
test('config targets, overrides, product name and updater settings are preserved', () => {
  const resolved = mergeConfig({ productName:'Gustaf', bundle:{ targets:'all', macOS:{dmg:{background:'dmg/background.png'}}}},
    {productName:'Gustaf Preview', bundle:{targets:['app','dmg'],createUpdaterArtifacts:true},plugins:{updater:{pubkey:'public'}}});
  assert.equal(resolved.productName, 'Gustaf Preview');
  assert.deepEqual(resolved.bundle.targets,['app','dmg']);
  assert.equal(resolved.bundle.macOS.dmg.background,'dmg/background.png');
  assert.equal(resolved.bundle.createUpdaterArtifacts,true);
});
test('signed final DMG notarization accepts complete credentials only', () => {
  assert.equal(notarizationArgs({APPLE_ID:'user'}),null);
  assert.deepEqual(notarizationArgs({APPLE_ID:'user',APPLE_PASSWORD:'password',APPLE_TEAM_ID:'team'}),
    ['--apple-id','user','--password','password','--team-id','team']);
  assert.deepEqual(notarizationArgs({APPLE_API_KEY:'key',APPLE_API_ISSUER:'issuer',APPLE_API_KEY_PATH:'/tmp/key.p8'}),
    ['--key','/tmp/key.p8','--key-id','key','--issuer','issuer']);
});
