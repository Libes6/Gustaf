import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { manifest, targets } from '../release-manifest.mjs';
import { root, versionFiles, nextVersion } from '../version.mjs';
test('stable SemVer bumps and rejects invalid or non-increasing versions', () => {
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  for (const v of ['1.2.3', '1.1.9', '01.2.4', '1.3.0-beta', 'wrong']) assert.throws(() => nextVersion('1.2.3', v));
});
test('bump writes exactly the app version entries and validates tag in isolated checkout', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gustaf-version-'));
  try {
    const { files } = versionFiles();
    for (const f of [...files, 'scripts/version.mjs']) {
      fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(tmp, f));
    }
    execFileSync(process.execPath, [path.join(tmp, 'scripts/version.mjs'), 'minor']);
    assert.equal(versionFiles(tmp).version, '0.2.0');
    execFileSync(process.execPath, [path.join(tmp, 'scripts/version.mjs'), '--check', 'v0.2.0']);
    assert.throws(() => execFileSync(process.execPath, [path.join(tmp, 'scripts/version.mjs'), '--check', 'v0.3.0'], { stdio: 'pipe' }));
    const cargo = fs.readFileSync(path.join(tmp, files[5]), 'utf8');
    assert.match(cargo, /name = "gustaf"\nversion = "0.2.0"/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
const assets = Object.fromEntries(targets.map(p => [p, { name: p + (p.startsWith('darwin') ? '.app.tar.gz' : p.endsWith('-msi') ? '.msi' : p.startsWith('windows') ? '.exe' : '.AppImage'), size: 10, signature: 'c2lnbmF0dXJl' }]));
test('complete manifest pins payload URLs to release tag and installer type', () => {
  const m = manifest('1.2.3', assets, 'Release notes');
  assert.equal(m.notes, 'Release notes');
  assert.equal(Object.keys(m.platforms).length, 5);
  for (const value of Object.values(m.platforms)) assert.match(value.url, /^https:\/\/github.com\/Libes6\/Gustaf\/releases\/download\/v1.2.3\//);
  assert.match(m.platforms['windows-x86_64-msi'].url, /\.msi$/);
});
test('partial, unsigned, empty, or wrong-format manifest is never publishable', () => {
  for (const replacement of [undefined, { ...assets['linux-x86_64'], signature: '' }, { ...assets['linux-x86_64'], size: 0 }, { ...assets['linux-x86_64'], name: 'file.deb' }]) assert.throws(() => manifest('1.2.3', { ...assets, 'linux-x86_64': replacement }));
});
test('manifest CLI assembles staged platform directories and fails on missing signature', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gustaf-manifest-'));
  try {
    for (const [target, asset] of Object.entries(assets)) {
      const dir = path.join(tmp, target.endsWith('-msi') ? 'windows-x86_64' : target);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, asset.name), 'payload');
      fs.writeFileSync(path.join(dir, asset.name + '.sig'), asset.signature);
    }
    const notes = path.join(tmp, 'notes.md'); fs.writeFileSync(notes, 'Reviewed notes');
    const command = [path.join(root, 'scripts/release-manifest.mjs'), tmp, '1.2.3', notes];
    execFileSync(process.execPath, command);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'latest.json'))).notes, 'Reviewed notes');
    fs.unlinkSync(path.join(tmp, 'linux-x86_64', assets['linux-x86_64'].name + '.sig'));
    assert.throws(() => execFileSync(process.execPath, command, { stdio: 'pipe' }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('asset staging excludes internal package archives while retaining installers and matching signatures', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gustaf-stage-'));
  try {
    const bundle = path.join(tmp, 'apps/desktop/src-tauri/target/release/bundle');
    fs.mkdirSync(bundle, { recursive: true });
    for (const name of ['Gustaf.app.tar.gz', 'Gustaf.app.tar.gz.sig', 'Gustaf.dmg', 'Gustaf.deb', 'Gustaf.deb.sig', 'control.tar.gz', 'data.tar.gz', 'unrelated.sig']) fs.writeFileSync(path.join(bundle, name), 'fixture');
    const host = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}`;
    execFileSync(process.execPath, [path.join(root, 'scripts/stage-release.mjs'), host], { cwd: tmp });
    const names = fs.readdirSync(path.join(tmp, 'release-assets'));
    assert.equal(names.length, 5);
    assert.ok(names.includes(host + '-Gustaf.app.tar.gz.sig'));
    assert.ok(!names.some(name => /control|data|unrelated/.test(name)));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
