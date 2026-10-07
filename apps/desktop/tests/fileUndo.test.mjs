import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MAX_UNDO_BYTES,
  captureAfter,
  captureBefore,
  cleanRelPath,
  gitBlobId,
  isBlobId,
  parseReviewRoot,
  reviewLocation,
  undoEdit,
} from '../src/lib/fileUndo.ts';

const hasGit = spawnSync('git', ['--version']).status === 0;
const gitTest = (name, fn) => test(name, { skip: !hasGit && 'git is not installed' }, fn);

/** A project folder and a shadow repo set up exactly like src-tauri/src/git.rs does, with the same primitives injected. */
function harness({ reviewDiff } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fileundo-'));
  const root = join(base, 'work');
  const shadow = join(base, 'shadow');
  mkdirSync(root);
  execFileSync('git', ['init', '-q', '--bare', shadow]);
  mkdirSync(join(shadow, 'info'), { recursive: true });
  writeFileSync(join(shadow, 'info/exclude'), '.git/\nnode_modules/\ntarget/\ndist/\n.DS_Store\n');
  const calls = [];
  const git = async (args) => {
    calls.push(args);
    const r = spawnSync('git', [`--git-dir=${shadow}`, `--work-tree=${root}`, ...args], {
      cwd: root,
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(r.stderr.trim() || `git exited with ${r.status}`);
    return r.stdout;
  };
  const inside = (rel) => {
    assert.ok(cleanRelPath(rel) === rel, `path escapes the project: ${rel}`);
    return join(root, rel);
  };
  const deps = {
    git,
    list: async (dir) =>
      readdirSync(join(root, dir), { withFileTypes: true }).map((d) => d.name + (d.isDirectory() ? '/' : '')),
    write: async (path, content) => {
      mkdirSync(dirname(inside(path)), { recursive: true });
      writeFileSync(inside(path), content);
    },
    ...(reviewDiff ? { reviewDiff } : {}),
  };
  const put = (rel, content) => {
    mkdirSync(dirname(inside(rel)), { recursive: true });
    writeFileSync(inside(rel), content);
  };
  const read = (rel) => readFileSync(inside(rel), 'utf8');
  /** What the agent's edit_file/write_file does: snapshot, change the file, seal the record. */
  const edit = async (rel, content, opts = {}) => {
    const snap = await captureBefore(deps, rel);
    assert.ok(snap, `no snapshot for ${rel}`);
    put(rel, content);
    return captureAfter(deps, snap, root, opts.reviewId);
  };
  return {
    base,
    root,
    shadow,
    deps,
    calls,
    put,
    read,
    edit,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

const withHarness = (fn, opts) => async () => {
  const h = harness(opts);
  try {
    await fn(h);
  } finally {
    h.cleanup();
  }
};

test('relative paths are cleaned the way the tools expect', () => {
  assert.equal(cleanRelPath('a/b.txt'), 'a/b.txt');
  assert.equal(cleanRelPath('./a//b.txt'), 'a/b.txt');
  assert.equal(cleanRelPath('a/./b'), 'a/b');
  assert.equal(cleanRelPath('-rf'), '-rf');
  for (const bad of ['', '/', '/etc/passwd', '../x', 'a/../b', '..', '.', './', 'a\0b', null, undefined, 5, {}])
    assert.equal(cleanRelPath(bad), null, String(bad));
});

test('review copies are recognised by their location', () => {
  const ws = '/Users/me/Library/Application Support/app.id/reviews/1759400000000000000-4242/work';
  assert.deepEqual(reviewLocation(ws), {
    id: '1759400000000000000-4242',
    dir: '/Users/me/Library/Application Support/app.id/reviews',
  });
  assert.deepEqual(reviewLocation(ws + '/'), {
    id: '1759400000000000000-4242',
    dir: '/Users/me/Library/Application Support/app.id/reviews',
  });
  assert.equal(reviewLocation('/Users/me/project'), null);
  assert.equal(reviewLocation('/x/reviews/abc/work'), null);
  assert.equal(reviewLocation('/x/reviews/1-2/work/sub'), null);
  assert.equal(reviewLocation('/x/reviews/1-2/baseline'), null);
  const json = JSON.stringify({ id: '1-2', root: '/Users/me/project', workspace: '/w' });
  assert.equal(parseReviewRoot(`     1|${json}\n`), '/Users/me/project');
  assert.equal(parseReviewRoot('garbage'), null);
  assert.equal(parseReviewRoot(''), null);
  assert.equal(parseReviewRoot('     1|{"id":"1"}\n'), null);
});

test('blob ids are git object ids', async () => {
  assert.equal(await gitBlobId(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(await gitBlobId('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(isBlobId('ce013625030ba8dba906f756967f9e9ca394464a'), true);
  for (const bad of [
    '',
    'xyz',
    '--foo',
    'CE013625030BA8DBA906F756967F9E9CA394464A',
    'ce01',
    5,
    null,
    'ce013625030ba8dba906f756967f9e9ca394464a\n',
  ])
    assert.equal(isBlobId(bad), false, String(bad));
  if (hasGit) {
    for (const text of ['héllo wörld ✓\r\nline two', 'no newline', '\n\n', 'a'.repeat(100_000)]) {
      const git = execFileSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim();
      assert.equal(await gitBlobId(text), git);
    }
  }
});

gitTest(
  'an edit can be undone, byte for byte',
  withHarness(async (h) => {
    const original = 'héllo\r\nwörld ✓\r\nno newline at the end';
    h.put('src/a.txt', original);
    const rec = await h.edit('src/a.txt', 'changed\n');
    assert.ok(rec);
    assert.equal(isBlobId(rec.before) && isBlobId(rec.after) && rec.before !== rec.after, true);
    assert.equal(rec.root, h.root);
    assert.equal(rec.path, 'src/a.txt');
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: true });
    assert.equal(h.read('src/a.txt'), original);
  }),
);

gitTest(
  'undo keeps the file permissions and touches nothing else',
  withHarness(async (h) => {
    h.put('run.sh', '#!/bin/sh\necho 1\n');
    if (process.platform !== 'win32') chmodSync(join(h.root, 'run.sh'), 0o755); // POSIX permission bits do not exist on Windows
    h.put('other.txt', 'keep me');
    const rec = await h.edit('run.sh', '#!/bin/sh\necho 2\n');
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: true });
    assert.equal(h.read('run.sh'), '#!/bin/sh\necho 1\n');
    if (process.platform !== 'win32') assert.equal(statSync(join(h.root, 'run.sh')).mode & 0o777, 0o755);
    assert.equal(h.read('other.txt'), 'keep me');
    assert.equal(
      execFileSync('git', [`--git-dir=${h.shadow}`, 'rev-list', '--all', '--count'], { encoding: 'utf8' }).trim(),
      '0',
      'no commits are made',
    );
    assert.equal(
      execFileSync('git', [`--git-dir=${h.shadow}`, 'ls-files'], { encoding: 'utf8' }).trim(),
      '',
      'the index is not used',
    );
  }),
);

gitTest(
  'a file the agent created is removed again, and only that file',
  withHarness(async (h) => {
    h.put('keep.txt', 'keep');
    h.put('dir/other.txt', 'other');
    const rec = await h.edit('dir/new.txt', 'brand new');
    assert.equal(rec.before, null);
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: true });
    assert.equal(existsSync(join(h.root, 'dir/new.txt')), false);
    assert.equal(h.read('dir/other.txt'), 'other');
    assert.equal(h.read('keep.txt'), 'keep');
  }),
);

gitTest(
  'a file created in a new folder is removed; the folder stays',
  withHarness(async (h) => {
    const rec = await h.edit('deep/er/new.txt', 'x');
    assert.equal(rec.before, null);
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: true });
    assert.equal(existsSync(join(h.root, 'deep/er/new.txt')), false);
  }),
);

gitTest(
  'a created file in an ignored folder (dist/) and a tracked file can be removed too',
  withHarness(async (h) => {
    const rec = await h.edit('dist/out.js', 'x');
    assert.equal(rec.before, null);
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: true });
    assert.equal(existsSync(join(h.root, 'dist/out.js')), false);
    const rec2 = await h.edit('tracked.txt', 'x');
    await h.deps.git(['add', '-A']); // as a checkpoint of the same folder would
    assert.deepEqual(await undoEdit(h.deps, rec2), { ok: true });
    assert.equal(existsSync(join(h.root, 'tracked.txt')), false);
  }),
);

gitTest(
  'names with spaces, dashes and glob characters are handled literally',
  withHarness(async (h) => {
    for (const name of ['-n', 'a b.txt', '[z].txt', ...(process.platform === 'win32' ? [] : ['a*b', 'x?y'])]) {
      h.put('axb', 'sibling');
      h.put('xxy', 'sibling');
      h.put('z.txt', 'sibling');
      const rec = await h.edit(name, 'agent');
      assert.ok(rec, name);
      assert.deepEqual(await undoEdit(h.deps, rec), { ok: true }, name);
      assert.equal(existsSync(join(h.root, name)), false, name);
      assert.equal(h.read('axb'), 'sibling');
      assert.equal(h.read('xxy'), 'sibling');
      assert.equal(h.read('z.txt'), 'sibling');
      h.put(name, 'before');
      const rec2 = await h.edit(name, 'after');
      assert.deepEqual(await undoEdit(h.deps, rec2), { ok: true }, name);
      assert.equal(h.read(name), 'before', name);
      rmSync(join(h.root, name));
    }
  }),
);

gitTest(
  'undo is refused when the file is no longer exactly what the agent left',
  withHarness(async (h) => {
    h.put('a.txt', 'one');
    const rec = await h.edit('a.txt', 'two');
    h.put('a.txt', 'two, then the user typed');
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: false, reason: 'changed' });
    assert.equal(h.read('a.txt'), 'two, then the user typed', 'nothing was overwritten');
    rmSync(join(h.root, 'a.txt'));
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: false, reason: 'changed' }, 'a deleted file');
    mkdirSync(join(h.root, 'a.txt'));
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: false, reason: 'changed' }, 'a folder in its place');
    assert.equal(existsSync(join(h.root, 'a.txt')), true);
    const created = await h.edit('b.txt', 'new');
    h.put('b.txt', 'new and more');
    assert.deepEqual(await undoEdit(h.deps, created), { ok: false, reason: 'changed' });
    assert.equal(h.read('b.txt'), 'new and more', 'a created file that was edited since is not deleted');
  }),
);

gitTest(
  'a folder is never removed by undoing a created file',
  withHarness(async (h) => {
    const rec = await h.edit('n.txt', 'x');
    rmSync(join(h.root, 'n.txt'));
    mkdirSync(join(h.root, 'n.txt'));
    writeFileSync(join(h.root, 'n.txt/inner'), 'precious');
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: false, reason: 'changed' });
    assert.equal(h.read('n.txt/inner'), 'precious');
  }),
);

gitTest(
  'edits are undone newest first',
  withHarness(async (h) => {
    h.put('a.txt', 'v0');
    const r1 = await h.edit('a.txt', 'v1');
    const r2 = await h.edit('a.txt', 'v2');
    assert.equal(r2.before, r1.after);
    assert.deepEqual(await undoEdit(h.deps, r1), { ok: false, reason: 'changed' }, 'the older edit cannot go first');
    assert.equal(h.read('a.txt'), 'v2');
    assert.deepEqual(await undoEdit(h.deps, r2), { ok: true });
    assert.equal(h.read('a.txt'), 'v1');
    assert.deepEqual(await undoEdit(h.deps, r1), { ok: true });
    assert.equal(h.read('a.txt'), 'v0');
  }),
);

gitTest(
  'a no-op edit leaves nothing to undo',
  withHarness(async (h) => {
    h.put('a.txt', 'same');
    assert.equal(await h.edit('a.txt', 'same'), undefined);
  }),
);

gitTest(
  'files that are not valid text are not restored (they would be corrupted)',
  withHarness(async (h) => {
    writeFileSync(join(h.root, 'bin.dat'), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]));
    const snap = await captureBefore(h.deps, 'bin.dat');
    assert.ok(snap?.before);
    writeFileSync(join(h.root, 'bin.dat'), 'text now');
    const rec = await captureAfter(h.deps, snap, h.root);
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: false, reason: 'unsupported' });
    assert.equal(h.read('bin.dat'), 'text now');
  }),
);

gitTest(
  'big files are not restored through the app',
  withHarness(async (h) => {
    h.put('big.txt', 'x'.repeat(MAX_UNDO_BYTES + 1));
    const rec = await h.edit('big.txt', 'small');
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: false, reason: 'unsupported' });
    assert.equal(h.read('big.txt'), 'small');
    h.put('ok.txt', 'x'.repeat(MAX_UNDO_BYTES));
    const rec2 = await h.edit('ok.txt', 'small');
    assert.deepEqual(await undoEdit(h.deps, rec2), { ok: true });
  }),
);

gitTest('in a review copy, undo needs the change to be still pending', async () => {
  let pending = 'diff --git a/x b/x\n+changed\n';
  const h = harness({
    reviewDiff: async (id, path) => {
      assert.equal(id, '1759-42');
      assert.equal(path, 'a.txt');
      if (pending === null) throw new Error('review is gone');
      return pending;
    },
  });
  try {
    h.put('a.txt', 'one');
    const rec = await h.edit('a.txt', 'two', { reviewId: '1759-42' });
    assert.equal(rec.reviewId, '1759-42');
    pending = '';
    assert.deepEqual(
      await undoEdit(h.deps, rec),
      { ok: false, reason: 'closed' },
      'accepted or rejected: nothing pending',
    );
    assert.equal(h.read('a.txt'), 'two');
    pending = '  \n';
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: false, reason: 'closed' });
    pending = null;
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: false, reason: 'closed' }, 'the review no longer exists');
    pending = 'diff --git a/x b/x\n+changed\n';
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: true });
    assert.equal(h.read('a.txt'), 'one');
  } finally {
    h.cleanup();
  }
});

gitTest(
  'a review id that cannot be checked is refused',
  withHarness(async (h) => {
    h.put('a.txt', 'one');
    const rec = await h.edit('a.txt', 'two', { reviewId: '1-2' });
    assert.deepEqual(await undoEdit(h.deps, rec), { ok: false, reason: 'unsupported' }, 'no way to ask the review');
    const h2 = harness({ reviewDiff: async () => 'diff' });
    try {
      h2.put('a.txt', 'one');
      const bad = { ...(await h2.edit('a.txt', 'two')), reviewId: '../../etc' };
      assert.deepEqual(await undoEdit(h2.deps, bad), { ok: false, reason: 'unsupported' });
      assert.equal(h2.read('a.txt'), 'two');
    } finally {
      h2.cleanup();
    }
  }),
);

gitTest(
  'tampered or corrupt records are refused before git runs',
  withHarness(async (h) => {
    h.put('a.txt', 'one');
    const rec = await h.edit('a.txt', 'two');
    h.calls.length = 0;
    for (const bad of [
      { ...rec, before: '--output=/tmp/x' },
      { ...rec, before: 'zz' },
      { ...rec, after: '--foo' },
      { ...rec, after: null },
      { ...rec, path: '../a.txt' },
      { ...rec, path: '/etc/passwd' },
      { ...rec, path: './a.txt' },
      { ...rec, path: '' },
    ])
      assert.deepEqual(await undoEdit(h.deps, bad), { ok: false, reason: 'unsupported' }, JSON.stringify(bad));
    assert.deepEqual(h.calls, [], 'git was never invoked');
    assert.equal(h.read('a.txt'), 'two');
  }),
);

gitTest(
  'paths the tools would reject are never snapshotted',
  withHarness(async (h) => {
    for (const bad of ['../x', '/etc/hosts', '', 'a/../../x', null, 42])
      assert.equal(await captureBefore(h.deps, bad), undefined, String(bad));
    assert.deepEqual(h.calls, []);
  }),
);

test('a missing file counts as "did not exist" only when the listing proves it', async () => {
  const unreadable = async () => {
    throw new Error('could not open');
  };
  const deps = (names) => ({
    git: unreadable,
    list:
      names instanceof Error
        ? async () => {
            throw names;
          }
        : async () => names,
    write: async () => {},
  });
  assert.deepEqual(await captureBefore(deps(['other.txt', 'dir/']), 'new.txt'), { path: 'new.txt', before: null });
  assert.deepEqual(
    await captureBefore(deps(new Error('No such file or directory (os error 2)')), 'missing/new.txt'),
    { path: 'missing/new.txt', before: null },
    'the folder is missing too',
  );
  assert.equal(
    await captureBefore(deps(new Error('timed out')), 'new.txt'),
    undefined,
    'a failed listing proves nothing',
  );
  assert.equal(await captureBefore(deps(new Error('Permission denied (os error 13)')), 'new.txt'), undefined);
  assert.equal(await captureBefore(deps(['new.txt']), 'new.txt'), undefined, 'it exists but could not be read');
  assert.equal(
    await captureBefore(deps(['New.TXT']), 'new.txt'),
    undefined,
    'a case-insensitive volume: the same file under another spelling',
  );
  assert.equal(await captureBefore(deps(['new.txt/']), 'new.txt'), undefined, 'a folder of that name');
  assert.equal(
    await captureBefore(
      { git: async () => 'not a blob id\n', list: async () => [], write: async () => {} },
      'a.txt',
    ).then((s) => s?.before),
    null,
    'garbage from git is treated like an unreadable file',
  );
});

test('capture helpers never throw', async () => {
  const boom = async () => {
    throw new Error('boom');
  };
  const deps = { git: boom, list: boom, write: boom };
  assert.equal(await captureBefore(deps, 'a.txt'), undefined, 'when nothing can be asked, nothing is offered');
  assert.equal(await captureAfter(deps, { path: 'a.txt', before: null }, '/r'), undefined);
  assert.deepEqual(await undoEdit(deps, { root: '/r', path: 'a.txt', before: null, after: 'a'.repeat(40) }), {
    ok: false,
    reason: 'changed',
  });
  assert.deepEqual(
    await undoEdit(
      { ...deps, git: async () => 'a'.repeat(40) + '\n' },
      { root: '/r', path: 'a.txt', before: 'b'.repeat(40), after: 'a'.repeat(40) },
    ),
    { ok: false, reason: 'unsupported' },
    'git answers nonsense for the size',
  );
  const weird = {
    git: async () => {
      throw new Error('x');
    },
    list: async () => {
      throw 5;
    },
    write: async () => {},
  };
  assert.equal(await captureBefore(weird, 'a.txt'), undefined);
});
