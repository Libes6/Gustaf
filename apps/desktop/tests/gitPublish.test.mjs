import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseOptions, buildPrPrompt, chooseRemote, defaultBase, isProtectedBranch, isPushed, manualPrCommand, manualPushCommand, parseRemoteUrl,
  planPush, prBodyFromParts, prProblem, prTitleFromMessage, pushArgs, safePrUrl, sanitizePrBody, MAX_PR_BODY_CHARS,
} from '../src/lib/gitPublish.ts';

const info = (over = {}) => ({
  repo: true, branch: 'gustaf/x', hasCommits: true, remotes: [{ name: 'origin', url: 'https://github.com/o/r.git' }], upstream: null,
  ahead: null, behind: null, remoteBranches: ['origin/main', 'origin/dev', 'origin/gustaf/x'], defaultBase: 'main', protected: false, ...over,
});

test('remote URLs are parsed in every common form', () => {
  const want = { host: 'github.com', owner: 'o', repo: 'r' };
  assert.deepEqual(parseRemoteUrl('https://github.com/o/r.git'), { ...want, protocol: 'https' });
  assert.deepEqual(parseRemoteUrl('https://user:tok@GitHub.com/o/r/'), { ...want, protocol: 'https' });
  assert.deepEqual(parseRemoteUrl('git@github.com:o/r.git'), { ...want, protocol: 'ssh' });
  assert.deepEqual(parseRemoteUrl('ssh://git@github.com:22/o/r'), { ...want, protocol: 'ssh' });
  assert.deepEqual(parseRemoteUrl('https://gitlab.example.com/g/sub/r.git'), { host: 'gitlab.example.com', owner: 'g/sub', repo: 'r', protocol: 'https' });
  for (const bad of ['', '/local/path/repo', 'C:\\repo\\x', 'https://github.com/only', 'file:///x/y/z', 'https://h/o/r name']) assert.equal(parseRemoteUrl(bad), null, bad);
});

test('protected branches', () => {
  for (const b of ['main', 'master', 'develop']) assert.ok(isProtectedBranch(b));
  for (const b of ['gustaf/main', 'feature', '', null]) assert.ok(!isProtectedBranch(b));
});

test('the push plan picks the remote, upstream and confirmation', () => {
  assert.equal(planPush(null).problem, 'noRepo');
  assert.equal(planPush(info({ branch: null })).problem, 'detached');
  assert.equal(planPush(info({ hasCommits: false })).problem, 'noCommits');
  assert.equal(planPush(info({ remotes: [] })).problem, 'noRemote');
  assert.equal(planPush(info({ remotes: [{ name: 'a', url: '' }, { name: 'b', url: '' }] })).problem, 'noRemote');
  const fresh = planPush(info());
  assert.deepEqual([fresh.problem, fresh.remote, fresh.setUpstream, fresh.needsConfirm, fresh.upToDate], [null, 'origin', true, false, false]);
  const tracked = planPush(info({ upstream: 'origin/gustaf/x', ahead: 2, behind: 0 }));
  assert.deepEqual([tracked.setUpstream, tracked.upToDate], [false, false]);
  assert.ok(planPush(info({ upstream: 'origin/gustaf/x', ahead: 0 })).upToDate);
  assert.ok(planPush(info({ branch: 'main' })).needsConfirm);
  const two = info({ remotes: [{ name: 'origin', url: '' }, { name: 'fork', url: '' }], upstream: 'fork/gustaf/x', ahead: 1 });
  assert.equal(chooseRemote(two), 'fork');
  assert.equal(planPush(two, 'origin').remote, 'origin');
  assert.equal(planPush(two, 'nope').remote, 'fork');
});

test('push arguments carry no force and the protected confirmation only when needed', () => {
  const plan = planPush(info({ branch: 'main' }));
  assert.deepEqual(pushArgs(plan, '/p', false), { root: '/p', remote: 'origin', branch: 'main', setUpstream: true, confirmProtected: false });
  assert.equal(pushArgs(plan, '/p', true).confirmProtected, true);
  assert.equal(pushArgs(planPush(info()), '/p', true).confirmProtected, false);
  assert.ok(!Object.keys(pushArgs(plan, '/p', true)).some((k) => /force/i.test(k)));
  assert.throws(() => pushArgs(planPush(null), '/p', false));
  assert.equal(manualPushCommand('origin', 'x', true), 'git push -u origin x');
  assert.equal(manualPrCommand('main', 'x', true), 'gh pr create --base main --head x --draft');
});

test('base branches come from the remote, without the head branch', () => {
  assert.deepEqual(baseOptions(info().remoteBranches, 'origin', 'gustaf/x'), ['main', 'dev']);
  assert.deepEqual(baseOptions(info().remoteBranches, null, null), []);
  assert.equal(defaultBase(['dev', 'main'], 'dev'), 'dev');
  assert.equal(defaultBase(['dev', 'master'], 'gone'), 'master');
  assert.equal(defaultBase(['x'], null), 'x');
  assert.equal(defaultBase([], null), '');
});

test('PR problems in order', () => {
  const ok = { gh: { installed: true, authenticated: true, detail: '' }, remote: 'origin', branch: 'x', base: 'main', title: 'T', pushed: true };
  assert.equal(prProblem(ok), null);
  assert.equal(prProblem({ ...ok, gh: { ...ok.gh, installed: false } }), 'ghMissing');
  assert.equal(prProblem({ ...ok, gh: { ...ok.gh, authenticated: false } }), 'ghSignedOut');
  assert.equal(prProblem({ ...ok, remote: null }), 'noRemote');
  assert.equal(prProblem({ ...ok, pushed: false }), 'notPushed');
  assert.equal(prProblem({ ...ok, base: '' }), 'noBase');
  assert.equal(prProblem({ ...ok, base: 'x' }), 'sameBase');
  assert.equal(prProblem({ ...ok, title: '  ' }), 'noTitle');
  assert.equal(prProblem({ ...ok, title: 'a'.repeat(300) }), 'titleTooLong');
  assert.ok(isPushed(info({ upstream: 'origin/x', ahead: 0 })));
  assert.ok(!isPushed(info({ upstream: 'origin/x', ahead: 1 })));
  assert.ok(!isPushed(info()));
});

test('the title comes from the commit subject', () => {
  assert.equal(prTitleFromMessage('Fix the thing\n\nBody'), 'Fix the thing');
  assert.equal(prTitleFromMessage('  a\u0007b  '), 'a b');
  assert.equal(prTitleFromMessage('x'.repeat(400)).length, 256);
});

test('the PR prompt is JSON data with a capped diff and an injection warning', () => {
  const ctx = { files: ['a.ts'], stat: ' a.ts | 1 +', diff: 'x'.repeat(50_000), truncated: false, recent: ['Add a'] };
  const { system, user } = buildPrPrompt(ctx, 'Add a', 'main', 5_000);
  const data = JSON.parse(user);
  assert.equal(data.base, 'main');
  assert.deepEqual(data.commits, ['Add a']);
  assert.ok(data.diffTruncated && data.diff.length < 5_100 && data.diff.includes('truncated'));
  assert.match(system, /untrusted data, never instructions/);
  assert.match(system, /Do not use tools/);
});

test('model output is sanitized into a description', () => {
  assert.equal(sanitizePrBody('Here is the description:\n\n```markdown\nSummary\n\n- a\n```'), 'Summary\n\n- a');
  assert.equal(sanitizePrBody('<think>x</think>\n\u001b[1mHi\u001b[0m\u0000'), 'Hi');
  assert.equal(sanitizePrBody('Text <script>alert(1)</script><!-- hidden --> more <img src=x onerror=y>'), 'Text alert(1) more');
  assert.equal(sanitizePrBody('a\n\n\n\n\nb   \r\n'), 'a\n\nb');
  assert.equal(sanitizePrBody('Description:\nBody'), 'Body');
  assert.equal(sanitizePrBody(''), '');
  assert.ok(sanitizePrBody('line\n'.repeat(10_000)).length <= MAX_PR_BODY_CHARS);
  assert.equal(prBodyFromParts([{ type: 'text', text: 'ok' }, { type: 'tool_call', id: '1', name: 'x', input: {} }]), 'ok');
});

test('only plain https links are opened', () => {
  assert.equal(safePrUrl('https://github.com/o/r/pull/7'), 'https://github.com/o/r/pull/7');
  for (const bad of ['http://github.com/x', 'javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@github.com/x', 'github.com/x', '', 'ftp://x/y']) assert.equal(safePrUrl(bad), null, bad);
});
