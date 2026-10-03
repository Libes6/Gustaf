import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpdateController } from '../src/lib/updates.ts';
test('unconfigured updater remains disabled; never pretends to check or install', async () => {
  const c = new UpdateController(); await c.check(); await c.download(); await c.install();
  assert.equal(c.status.kind, 'disabled');
});
test('install requires successful signed download and separate explicit invocation', async () => {
  let installs = 0;
  const c = new UpdateController({ check: async () => ({ version:'2', download:async p => p(12, 12), install:async () => installs++ }) });
  await c.check(); await c.install(); assert.equal(installs, 0);
  await c.download(); assert.equal(c.status.kind, 'downloaded'); assert.equal(installs, 0);
  await c.install(); assert.equal(installs, 1);
});
test('failed verification never permits installation or reports up to date', async () => {
  let installs = 0;
  const c = new UpdateController({ check:async () => ({ version:'2', download:async () => { throw Error('Invalid signature'); }, install:async () => installs++ }) });
  await c.check(); await c.download(); await c.install();
  assert.equal(c.status.kind, 'error'); assert.equal(installs, 0);
  assert.match(c.status.error, /Invalid signature/);
});
test('offline check reports network error; retry can report no newer version', async () => {
  let offline = true;
  const c = new UpdateController({ check: async () => { if (offline) throw Error('network timeout'); return null; } });
  await c.check(); assert.equal(c.status.kind, 'error'); assert.equal(c.status.category, 'network');
  offline = false; await c.check(); assert.equal(c.status.kind, 'current');
});
test('concurrent checks are suppressed and install failure permits a new check', async () => {
  let resolve; let checks = 0;
  const c = new UpdateController({ check: async () => { checks++; await new Promise(r => resolve = r); return { version: '0.2.0', download: async () => {}, install: async () => { throw Error('Permission denied'); } }; } });
  const check = c.check(); await Promise.resolve(); await c.check(); assert.equal(checks, 1);
  resolve(); await check; await c.download(); await c.install(); assert.equal(c.status.kind, 'error');
  const retry = c.check(); await Promise.resolve(); resolve(); await retry; assert.equal(c.status.kind, 'available');
});
test('a new check releases the previous native update resource', async () => {
  let closes = 0;
  const c = new UpdateController({ check: async () => ({ version: '0.2.0', close: async () => { closes++; }, download: async () => {}, install: async () => {} }) });
  await c.check(); await c.download(); await c.check();
  assert.equal(closes, 1); assert.equal(c.status.kind, 'available');
});
