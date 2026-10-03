import test from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'sucrase';
import { parseArtifacts, CANVAS_INSTRUCTIONS } from '../src/canvas/artifacts.ts';
import { diffLines, diffFiles, collapseContext } from '../src/canvas/diff.ts';
import { buildCanvasDocument } from '../src/canvas/documentBuilder.ts';
import { parseFiles, loadModules, resolveRelative } from '../src/canvas/modules.ts';

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

const compile = (code) => transform(code, { transforms: ['typescript', 'jsx', 'imports'], production: true, jsxRuntime: 'classic' }).code;
const React = { createElement: (...args) => args };
const load = (code) => loadModules(parseFiles(code).files, compile, { react: React });

test('single-file bodies stay one App.tsx and the multi-file syntax is taught', () => {
  const { files, error } = parseFiles('export default () => null;');
  assert.equal(error, undefined);
  assert.deepEqual(files, [{ name: 'App.tsx', code: 'export default () => null;' }]);
  assert.match(CANVAS_INSTRUCTIONS, /\/\/ file: App\.tsx/);
});
test('multi-file fences are split into files and exposed on the artifact', () => {
  const body = '// file: App.tsx\nimport { n } from "./lib/utils";\nexport default () => n;\n\n// file: lib/utils.ts\nexport const n = 1;\n';
  const artifact = parseArtifacts('```tsx-canvas id="app" title="App"\n' + body + '```')[0].artifact;
  assert.deepEqual(artifact.files.map(f => f.name), ['App.tsx', 'lib/utils.ts']);
  assert.equal(artifact.files[1].code, 'export const n = 1;\n');
  assert.equal(artifact.code, body.replace(/\n$/, ''));
  assert.equal(artifact.filesError, undefined);
});
test('invalid, duplicate and path-escaping file names are reported', () => {
  for (const name of ['', '../x.ts', '/abs.ts', 'a b.ts', 'x.css']) assert.ok(parseFiles(`// file: ${name}\nx`).error, name);
  assert.match(parseFiles('// file: a.ts\n1\n// file: a.ts\n2').error, /Duplicate/);
  const many = Array.from({ length: 30 }, (_, i) => `// file: f${i}.ts\n1`).join('\n');
  assert.match(parseFiles(many).error, /Too many/);
});
test('relative imports resolve with extensions, index files and parent directories', () => {
  const names = ['App.tsx', 'a/b.ts', 'a/index.tsx', 'c.js'];
  assert.equal(resolveRelative('App.tsx', './a/b', names), 'a/b.ts');
  assert.equal(resolveRelative('App.tsx', './a', names), 'a/index.tsx');
  assert.equal(resolveRelative('a/b.ts', '../c', names), 'c.js');
  assert.equal(resolveRelative('a/b.ts', '../c.js', names), 'c.js');
  assert.equal(resolveRelative('a/b.ts', '../../c', names), null);
  assert.equal(resolveRelative('App.tsx', './missing', names), null);
});
test('modules execute across files, share state and only expose react', () => {
  const out = load('// file: App.tsx\nimport * as React from "react";\nimport { double } from "./math";\nimport Label from "./ui/Label";\nexport default function App() { return React.createElement("p", null, Label, double(2)); }\n// file: math.ts\nexport const double = (n: number): number => n * 2;\n// file: ui/Label.tsx\nimport { double } from "../math";\nexport default `x${double(1)}`;');
  assert.deepEqual(out.default(), ['p', null, 'x2', 4]);
});
test('import cycles do not crash or loop', () => {
  const out = load('// file: a.ts\nimport { b } from "./b";\nexport const a = () => "a" + b();\n// file: b.ts\nimport { a } from "./a";\nexport const b = () => "b";\nexport const c = () => a();\nexport default 1;');
  assert.equal(out.a(), 'ab');
});
test('missing files and foreign packages produce clear errors', () => {
  assert.throws(() => load('// file: App.tsx\nimport "./nope";'), /Cannot find module "\.\/nope" imported from App\.tsx\. Files: App\.tsx/);
  assert.throws(() => load('// file: App.tsx\nimport x from "lodash"; x();'), /Unsupported import "lodash" in App\.tsx/);
  assert.throws(() => load('// file: App.tsx\nimport x from "../x"; x();'), /Cannot find module/);
});

const rebuild = (lines, side) => lines.filter(l => l.kind === 'same' || l.kind === side).map(l => l.text).join('\n');
test('line diff marks additions, deletions and numbers both sides', () => {
  const lines = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.deepEqual(lines.map(l => `${l.kind[0]}:${l.text}`), ['s:a', 'd:b', 'a:B', 's:c', 'a:d']);
  assert.deepEqual(lines.filter(l => l.kind === 'same').map(l => [l.oldNo, l.newNo]), [[1, 1], [3, 3]]);
  assert.equal(lines.find(l => l.kind === 'add').oldNo, undefined);
  assert.equal(lines.find(l => l.kind === 'del').newNo, undefined);
});
test('line diff handles empty sides, identical text and CRLF', () => {
  assert.deepEqual(diffLines('', ''), []);
  assert.deepEqual(diffLines('', 'x').map(l => l.kind), ['add']);
  assert.deepEqual(diffLines('x', '').map(l => l.kind), ['del']);
  assert.ok(diffLines('a\r\nb', 'a\nb').every(l => l.kind === 'same'));
});
test('line diff reconstructs both sides for random edits and stays minimal', () => {
  let seed = 7;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: rnd(25) }, () => 'l' + rnd(6));
    const b = Array.from({ length: rnd(25) }, () => 'l' + rnd(6));
    const lines = diffLines(a.join('\n'), b.join('\n'));
    assert.equal(rebuild(lines, 'del'), a.join('\n'));
    assert.equal(rebuild(lines, 'add'), b.join('\n'));
  }
  const edits = diffLines('1\n2\n3\n4\n5\n6\n7', '1\n2\n4\n5\n6\n6.5\n7').filter(l => l.kind !== 'same').length;
  assert.equal(edits, 2);
});
test('very different large files fall back to a replacement without hanging', () => {
  const a = Array.from({ length: 3000 }, (_, i) => 'a' + i).join('\n');
  const b = Array.from({ length: 3000 }, (_, i) => 'b' + i).join('\n');
  const lines = diffLines(a, b);
  assert.equal(lines.filter(l => l.kind === 'del').length, 3000);
  assert.equal(lines.filter(l => l.kind === 'add').length, 3000);
});
test('file diff reports added, removed, modified and unchanged files', () => {
  const diffs = diffFiles(
    [{ name: 'App.tsx', code: 'a\n' }, { name: 'old.ts', code: 'x\n' }, { name: 'same.ts', code: 's\n' }],
    [{ name: 'App.tsx', code: 'b\n' }, { name: 'same.ts', code: 's\n' }, { name: 'new.ts', code: 'n\n' }]);
  assert.deepEqual(diffs.map(d => `${d.name}:${d.status}`), ['App.tsx:modified', 'same.ts:unchanged', 'new.ts:added', 'old.ts:removed']);
  assert.deepEqual([diffs[0].added, diffs[0].removed], [1, 1]);
});
test('context collapsing keeps neighbours of changes and counts skipped lines', () => {
  const body = Array.from({ length: 20 }, (_, i) => 'l' + i);
  const changed = body.slice(); changed[10] = 'X';
  const rows = collapseContext(diffLines(body.join('\n'), changed.join('\n')), 2);
  assert.deepEqual(rows[0], { kind: 'skip', count: 8 });
  assert.equal(rows.filter(r => r.kind !== 'skip').length, 6);
  assert.deepEqual(rows.at(-1), { kind: 'skip', count: 7 });
  assert.deepEqual(collapseContext(diffLines('a', 'a')), [{ kind: 'skip', count: 1 }]);
});

const RUNTIME = 'console.log("runtime", "</script><script>evil()</script><!-- x");';
const exportHtml = (code, title) => buildCanvasDocument(code, RUNTIME, { title, nonce: 'n0nce' });
test('HTML export is self-contained: CSP meta, inline runtime, no external references', () => {
  const html = exportHtml('// file: App.tsx\nimport { x } from "./x";\nexport default () => x;\n// file: x.ts\nexport const x = "</script><img src=https://evil.example/x>";', 'Мой <график> & "co"');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-n0nce' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">/);
  assert.match(html, /<title>Мой &lt;график&gt; &amp; &quot;co&quot;<\/title>/);
  assert.match(html, /<script nonce="n0nce">console\.log\("runtime"/);
  // Outside the two inline scripts nothing can load anything: no link/img/iframe/src/href/@import/url().
  const shell = html.replace(/<script\b[^>]*>[^]*?<\/script>/g, '');
  assert.doesNotMatch(shell, /<link\b|<iframe\b|<img\b|\bsrc=|\bhref=|@import|url\(/i);
  assert.equal(html.match(/<script\b/g).length, 2);
  assert.equal(html.match(/<\/script>/g).length, 2);
  assert.doesNotMatch(html, /<!--/);
});
test('HTML export embeds every file of the artifact and the payload cannot close its script tag', () => {
  const code = '// file: App.tsx\nexport default () => <b/>;\n// file: lib/a.ts\nexport const a = 1;';
  const html = exportHtml(code);
  const payload = /<script id="canvas-source" type="application\/json">([^]*?)<\/script>/.exec(html)[1];
  assert.equal(JSON.parse(payload).code, code);
  assert.doesNotMatch(payload, /</);
  assert.doesNotMatch(html, /<title>/);
});
test('each export gets a fresh CSP nonce unless one is given', () => {
  const nonce = (html) => /'nonce-([0-9a-f]+)'/.exec(html)[1];
  assert.notEqual(nonce(buildCanvasDocument('x', RUNTIME)), nonce(buildCanvasDocument('x', RUNTIME)));
});
