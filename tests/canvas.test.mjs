import test from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'sucrase';
import { parseArtifacts, CANVAS_INSTRUCTIONS } from '../src/canvas/artifacts.ts';
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
