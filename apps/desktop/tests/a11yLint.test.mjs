// Practical accessibility lint over src/**/*.tsx (a regression guard, not a JSX parser):
//  - every <button> needs visible text, aria-label/aria-labelledby or title
//  - a non-interactive element with onClick needs a role plus tabIndex and a key handler (or should be a <button>)
//  - <input>/<select>/<textarea> need aria-label, aria-labelledby, an id (for a <label htmlFor>), or sit inside a <label>
// Known exceptions go to ALLOW below as "file:line-independent snippet" strings; keep it empty when possible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
/** `relative/file.tsx` -> substrings of the opening tag that are allowed to break a rule. */
const ALLOW = {};

function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((d) =>
      d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith('.tsx') ? [path.join(dir, d.name)] : [],
    );
}

/** Reads one JSX opening tag starting at `<`: attribute text (braces and quotes respected) and the index after `>`. */
export function readTag(src, start) {
  let depth = 0,
    quote = '',
    i = start + 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = '';
    } else if (c === '"' || c === "'" || (c === '`' && depth > 0)) {
      quote = c;
    } else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) break;
  }
  const raw = src.slice(start, i + 1);
  return { raw, end: i + 1, selfClosing: raw.endsWith('/>') };
}

const hasAttr = (tag, names) =>
  names.some((n) => new RegExp(`(^|\\s)${n}(=|\\s|/|>)`).test(tag)) || /\{\s*\.\.\./.test(tag);

/** True when the children of a button carry text a screen reader can use. */
export function hasTextContent(children) {
  let s = children;
  s = s.replace(/<[A-Z][\w.]*(?:\s(?:[^<>{}]|\{[^{}]*\})*)?\/>/g, ''); // icon components
  s = s.replace(/\{\s*[\w.?]*[iI]con\s*\}/g, ''); // {icon}
  s = s.replace(/<[^>]*>/g, ''); // remaining tags
  return /[\p{L}\p{N}]/u.test(s);
}

export function lint(file, src) {
  const rel = path.relative(SRC, file);
  const allowed = (tag) => (ALLOW[rel] ?? []).some((a) => tag.includes(a));
  const problems = [];
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  const re = /<(button|div|span|li|a|p|section|header|article|label|input|select|textarea)(?=[\s/>])/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const { raw, end, selfClosing } = readTag(src, m.index);
    if (allowed(raw)) continue;
    const where = `${rel}:${lineOf(m.index)}`;
    if (name === 'button') {
      const close = src.indexOf('</button>', end);
      const children = selfClosing || close < 0 ? '' : src.slice(end, close);
      if (!hasAttr(raw, ['aria-label', 'aria-labelledby', 'title']) && !hasTextContent(children))
        problems.push(`${where} <button> has no accessible name`);
    } else if (['div', 'span', 'li', 'p', 'section', 'header', 'article'].includes(name)) {
      if (/(^|\s)onClick=/.test(raw)) {
        if (!hasAttr(raw, ['role'])) problems.push(`${where} <${name}> with onClick needs a role (or use <button>)`);
        else if (
          !/role="(option|presentation|none)"/.test(raw) &&
          (!hasAttr(raw, ['tabIndex']) || !hasAttr(raw, ['onKeyDown']))
        )
          problems.push(`${where} <${name} role> with onClick needs tabIndex and onKeyDown`);
      }
    } else if (name === 'input' || name === 'select' || name === 'textarea') {
      const type = /type="(\w+)"/.exec(raw)?.[1];
      if (type === 'hidden' || type === 'file') continue;
      const before = src.slice(Math.max(0, m.index - 400), m.index);
      const inLabel = before.lastIndexOf('<label') > before.lastIndexOf('</label>');
      if (!inLabel && !hasAttr(raw, ['aria-label', 'aria-labelledby', 'id']))
        problems.push(`${where} <${name}> has no label`);
    }
  }
  return problems;
}

test('src/**/*.tsx: buttons, clickable elements and form fields are accessible', () => {
  const problems = files(SRC).flatMap((f) => lint(f, fs.readFileSync(f, 'utf8')));
  assert.deepEqual(problems, [], `Accessibility lint found ${problems.length} problem(s):\n${problems.join('\n')}`);
});

test('lint helpers: tag reader and text detection', () => {
  const src = '<button onClick={() => a > b} title="x">';
  assert.equal(readTag(src, 0).raw, src);
  assert.ok(hasTextContent(' <X size={14} /> {t("save")} '));
  assert.ok(hasTextContent('<span className="a">Go</span>'));
  assert.ok(!hasTextContent(' <X size={14} /> '));
  assert.ok(!hasTextContent('{it.icon}'));
  assert.deepEqual(
    lint(
      path.join(SRC, 'x.tsx'),
      '<div onClick={f}>a</div>\n<button><X size={1}/></button>\n<button aria-label="a"><X/></button>',
    ).length,
    2,
  );
});
