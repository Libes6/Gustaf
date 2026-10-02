import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArtifacts } from '../src/canvas/artifacts.ts';

test('extracts complete artifacts and surrounding prose', () => {
  const segments = parseArtifacts('Before\n```tsx-canvas id="calc" title="Calculator"\nexport default () => <div />;\n```\nAfter');
  assert.deepEqual(segments.map(s => s.type), ['text', 'canvas', 'text']);
  assert.equal(segments[1].artifact.id, 'calc');
  assert.equal(segments[1].artifact.title, 'Calculator');
  assert.equal(segments[1].artifact.complete, true);
});
test('streaming artifacts cannot run until the matching closing fence arrives', () => {
  const artifact = parseArtifacts('````tsx-canvas id="a"\nconst s = "```";\n```')[0].artifact;
  assert.equal(artifact.complete, false);
});
test('ordinary code and nested examples stay Markdown', () => {
  for (const text of ['```tsx\nexport default () => null;\n```', '````text\n```tsx-canvas\nexample\n```\n````']) {
    assert.deepEqual(parseArtifacts(text), [{type: 'text', text}]);
  }
});
test('multiple versions preserve ids, Unicode titles, code and CRLF', () => {
  const segments = parseArtifacts('```tsx-canvas id="a" title="Счётчик"\r\nfirst\r\n```\r\n```tsx-canvas id="a"\nsecond\n```');
  const artifacts = segments.filter(s => s.type === 'canvas').map(s => s.artifact);
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0].title, 'Счётчик');
  assert.equal(artifacts[0].id, artifacts[1].id);
  assert.ok(artifacts.every(a => a.complete));
});
