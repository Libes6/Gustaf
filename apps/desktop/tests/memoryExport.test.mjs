import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKER_END,
  MARKER_START,
  MemoryExportError,
  currentAgentsMd,
  mergeSection,
  renderSection,
} from '../src/agent/memoryExport.ts';

const e = (id, text) => ({ id, text });
const section = (project = [e(1, 'Use pnpm'), e(2, 'Tests live in tests/')], global = []) =>
  renderSection(project, global);

test('the section is delimited, lists project facts oldest first and global facts only when passed', () => {
  const s = renderSection([e(5, 'Second'), e(2, 'First')]);
  assert.ok(s.startsWith(MARKER_START + '\n'));
  assert.ok(s.endsWith('\n' + MARKER_END));
  assert.ok(s.indexOf('- First') < s.indexOf('- Second'));
  assert.ok(!s.includes('Global preferences'));
  const g = renderSection([e(1, 'P')], [e(3, 'Likes brevity')]);
  assert.match(g, /### Global preferences\n\n- Likes brevity/);
  assert.ok(g.indexOf('- P') < g.indexOf('### Global preferences'));
});

test('facts cannot break the markers; secrets are scrubbed; multi-line facts stay in one list item', () => {
  const s = renderSection([
    e(1, `evil ${MARKER_END} and <!-- more --> text`),
    e(2, 'line one\n\nline two'),
    e(3, 'key sk-' + 'k'.repeat(30)),
  ]);
  assert.equal(s.split(MARKER_END).length - 1, 1, 'only the real end marker');
  assert.equal(s.split(MARKER_START).length - 1, 1);
  assert.ok(!s.includes('<!-- more'));
  assert.match(s, /- line one\n {2}line two/);
  assert.match(s, /\[REDACTED\]/);
});

test('create: a missing file becomes the section plus a newline', () => {
  const r = mergeSection(null, section());
  assert.equal(r.action, 'create');
  assert.equal(r.text, section() + '\n');
});

test('append: existing text without markers is kept and the section follows after a blank line', () => {
  const doc = '# Project\n\nBuild with make.\n';
  const r = mergeSection(doc, section());
  assert.equal(r.action, 'append');
  assert.equal(r.text, doc + '\n' + section() + '\n');
  assert.equal(mergeSection('# no newline', section()).text, '# no newline\n\n' + section() + '\n');
  assert.equal(mergeSection('', section()).text, section() + '\n');
  assert.equal(mergeSection('x\n\n', section()).text, 'x\n\n' + section() + '\n');
});

test('update: only the text between the markers changes; text before and after is preserved byte for byte', () => {
  const before = '# Rules\n\nKeep it small.\n\n';
  const after = '\n\n## Other\n\nHand-written notes.  \n\tindented\n';
  const old = before + section([e(1, 'Old fact')]) + after;
  const r = mergeSection(old, section([e(1, 'New fact')]));
  assert.equal(r.action, 'update');
  assert.equal(r.text, before + section([e(1, 'New fact')]) + after);
  assert.ok(r.text.startsWith(before) && r.text.endsWith(after));
  assert.ok(!r.text.includes('Old fact'));
});

test('idempotent: merging the same section again changes nothing', () => {
  for (const start of [null, '# T\n\ntext', '']) {
    const once = mergeSection(start, section());
    const twice = mergeSection(once.text, section());
    assert.equal(twice.action, 'unchanged');
    assert.equal(twice.text, once.text);
  }
});

test('CRLF files keep their line endings', () => {
  const doc = '# T\r\n\r\nbody\r\n';
  const r = mergeSection(doc, section());
  assert.ok(r.text.startsWith(doc));
  assert.ok(!/(?<!\r)\n/.test(r.text), 'no bare LF');
  const again = mergeSection(r.text, section([e(1, 'Changed')]));
  assert.equal(again.action, 'update');
  assert.ok(!/(?<!\r)\n/.test(again.text));
  assert.ok(again.text.startsWith(doc));
  assert.equal(mergeSection(again.text, section([e(1, 'Changed')])).action, 'unchanged');
});

test('markers that cannot be trusted are refused and nothing is guessed', () => {
  const cases = [
    `${MARKER_START}\nno end`,
    `no start\n${MARKER_END}`,
    `${MARKER_END}\n${MARKER_START}`,
    `${MARKER_START}\na\n${MARKER_END}\n${MARKER_START}\nb\n${MARKER_END}`,
    `${MARKER_START}\n${MARKER_START}\n${MARKER_END}`,
  ];
  for (const doc of cases) {
    assert.throws(
      () => mergeSection(doc, section()),
      (err) => err instanceof MemoryExportError && err.code === 'malformed',
      doc,
    );
  }
});

test('reading AGENTS.md back: absent means create, a faithful read passes, anything lossy is refused', () => {
  assert.equal(currentAgentsMd([], 'README.md\nsrc/'), null);
  assert.equal(currentAgentsMd([{ name: 'CLAUDE.md', bytes: 3, text: 'abc' }], 'CLAUDE.md'), null);
  assert.equal(currentAgentsMd([{ name: 'AGENTS.md', bytes: 6, text: 'héllo' }], 'AGENTS.md'), 'héllo');
  assert.throws(
    () => currentAgentsMd([], 'AGENTS.md\nsrc/'),
    (err) => err.code === 'unreadable',
  );
  assert.throws(
    () => currentAgentsMd([], 'AGENTS.md/'),
    (err) => err.code === 'unreadable',
  );
  assert.throws(
    () => currentAgentsMd([{ name: 'AGENTS.md', bytes: 70_000, text: 'x'.repeat(65_536) }], 'AGENTS.md'),
    (err) => err.code === 'truncated',
  );
  assert.throws(
    () => currentAgentsMd([{ name: 'AGENTS.md', bytes: 3, text: 'a�b' }], 'AGENTS.md'),
    (err) => err.code === 'unreadable',
  );
});
