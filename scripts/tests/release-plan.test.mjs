import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { plan } from '../release-plan.mjs';
import { root, versionFiles } from '../version.mjs';

const push = { event: 'push', ref: 'refs/heads/main', repository: 'Libes6/Gustaf', version: '1.2.3', tagExists: false, onMain: true };

test('new version pushed to main builds and drafts its tag', () => {
  assert.deepEqual(plan(push), { build: true, release: true, tag: 'v1.2.3', version: '1.2.3', reason: 'New version: building and drafting release v1.2.3.' });
});
test('existing tag skips build and release without failing', () => {
  const d = plan({ ...push, tagExists: true });
  assert.equal(d.build, false);
  assert.equal(d.release, false);
  assert.match(d.reason, /v1\.2\.3 already exists/);
});
test('manual run builds artifacts only, on any branch, whether or not the tag exists', () => {
  for (const extra of [{}, { ref: 'refs/heads/dev', onMain: false, tagExists: true, repository: 'fork/Gustaf' }]) {
    const d = plan({ ...push, ...extra, event: 'workflow_dispatch' });
    assert.equal(d.build, true);
    assert.equal(d.release, false);
    assert.equal(d.tag, '');
  }
});
test('refuses other branches, tags, forks, commits not on main, other events and bad versions', () => {
  for (const bad of [{ ref: 'refs/heads/dev' }, { ref: 'refs/tags/v1.2.3' }, { ref: 'refs/heads/main-x' }, { repository: 'someone/Gustaf' }, { onMain: false }, { event: 'pull_request' }, { version: '1.2' }, { version: '1.2.3-beta' }]) {
    assert.throws(() => plan({ ...push, ...bad }), undefined, JSON.stringify(bad));
  }
  // A refusal wins over "tag exists": a non-main push never silently succeeds.
  assert.throws(() => plan({ ...push, ref: 'refs/heads/dev', tagExists: true }));
});

test('CLI reads tag and main ancestry from origin and writes step outputs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gustaf-plan-'));
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    const origin = path.join(tmp, 'origin.git'), work = path.join(tmp, 'work');
    g(tmp, 'init', '--bare', origin);
    g(tmp, 'clone', origin, work);
    g(work, 'commit', '--allow-empty', '-m', 'one');
    g(work, 'push', 'origin', 'HEAD:refs/heads/main');
    const mainSha = g(work, 'rev-parse', 'HEAD');
    g(work, 'checkout', '-b', 'side');
    g(work, 'commit', '--allow-empty', '-m', 'side only');
    const sideSha = g(work, 'rev-parse', 'HEAD');
    let n = 0;
    const run = sha => {
      const out = path.join(tmp, `out-${n++}`);
      const r = spawnSync(process.execPath, [path.join(root, 'scripts/release-plan.mjs')], { cwd: work, encoding: 'utf8',
        env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'Libes6/Gustaf', GITHUB_SHA: sha, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: '' } });
      return { status: r.status, stdout: r.stdout + r.stderr, out: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '' };
    };
    const tag = 'v' + versionFiles().version;
    let r = run(mainSha);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.out, `build=true\nrelease=true\ntag=${tag}\nversion=${tag.slice(1)}\n`);
    r = run(sideSha);
    assert.equal(r.status, 1);
    assert.equal(r.out, '');
    assert.match(r.stdout, /::error .*not on origin\/main/);
    g(work, 'push', 'origin', `${mainSha}:refs/tags/${tag}`);
    r = run(mainSha);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.out, /^build=false\nrelease=false\n/);
    assert.match(r.stdout, /::notice .*already exists/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
