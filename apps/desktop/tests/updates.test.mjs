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
