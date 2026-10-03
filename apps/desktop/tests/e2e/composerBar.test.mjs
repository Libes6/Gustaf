// Composer bottom bar in a real Chrome with the real theme.css: with a long model name the bar must not overflow
// horizontally; the model label is ellipsized, its chevron stays visible, and the mic and send buttons keep their
// size and stay inside the composer box (not clipped, not pressed to the edge). The bar holds the slim control set
// (add, mode, access, workspace, context ring, model, reasoning, mic, send); 360 px is the narrowest window.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { findChrome } from '../helpers/chrome.mjs';

const chrome = findChrome();
const skip = chrome ? false : 'no local Chrome/Chromium found (set CHROME_BIN to run the end-to-end tests)';
const css = readFileSync(new URL('../../src/styles/theme.css', import.meta.url), 'utf8');

let browser;
before(async () => { if (!skip) browser = await chromium.launch({ executablePath: chrome, headless: true, chromiumSandbox: !(process.env.CI || process.getuid?.() === 0) }); });
after(async () => { await browser?.close(); });

const svg = '<svg width="14" height="14"></svg>';
const html = (model, canvas) => `<!doctype html><html data-theme="dark"><head><style>${css}</style></head><body>
<div class="canvas-workspace${canvas ? ' has-canvas' : ''}"><main class="main"><div class="composer-wrap"><div class="composer" id="box">
<textarea></textarea>
<div class="composer-bar" id="bar">
<button class="icon-btn">+</button><span class="composer-mode">Agent</span>
<button class="chip">${svg} Full access</button><button class="chip">${svg} Workspace</button>
<span class="grow"></span><button class="chip ctx">12k / 200k</button>
<div class="composer-model" style="position:relative"><button class="chip" id="model">${svg} <span class="chip-label" id="label">${model}</span> <svg class="chev" id="chev" width="13" height="13"></svg></button></div>
<button class="chip">${svg} high</button>
<div class="composer-actions"><div style="position:relative;display:flex"><button class="icon-btn" id="mic">m</button></div>
<button class="send" id="send">s</button></div>
</div></div></div></main></div></body></html>`;

async function measure(width, model, canvas) {
  const ctx = await browser.newContext({ viewport: { width, height: 700 } });
  try {
    const p = await ctx.newPage();
    await p.setContent(html(model, canvas));
    return await p.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const bar = document.getElementById('bar');
      const chips = [...bar.children].map((c) => c.getBoundingClientRect());
      return { chips, box: r('box'), bar: r('bar'), model: r('model'), chev: r('chev'), mic: r('mic'), send: r('send'), scrollW: bar.scrollWidth, clientW: bar.clientWidth };
    });
  } finally { await ctx.close(); }
}

for (const [width, canvas] of [[900, false], [900, true], [600, false], [1400, false], [360, false]]) {
  for (const model of ['GPT-6.1-Sol', 'A-very-long-model-name-that-keeps-going-and-going-for-ever-and-ever-preview-2026']) {
    test(`composer bar fits at ${width}px${canvas ? ' with canvas' : ''}, model "${model.slice(0, 12)}"`, { skip }, async () => {
      const m = await measure(width, model, canvas);
      assert.ok(m.scrollW <= m.clientW + 1, `bar overflows horizontally: ${m.scrollW} > ${m.clientW}`);
      assert.ok(m.model.right <= m.box.right - 1, 'model chip clipped on the right');
      assert.ok(m.chev.width > 0 && m.chev.right <= m.model.right + 0.5 && m.chev.left >= m.model.left, 'chevron not inside the chip');
      assert.ok(m.mic.width >= 26 && m.send.width >= 30, `mic/send shrank: ${m.mic.width}/${m.send.width}`);
      assert.ok(m.send.right <= m.box.right - 8, `send is pressed to the edge: ${m.box.right - m.send.right}px`);
      assert.ok(m.mic.right <= m.send.left, 'mic overlaps send');
      // No empty gap where the removed chips were: the bar is as tall as its rows of controls, nothing taller.
      const rows = new Set(m.chips.map((c) => Math.round((c.top + c.bottom) / 2 / 10))).size;
      assert.ok(m.bar.height <= rows * 34 + (rows - 1) * 4 + 2, `bar has an empty gap: ${m.bar.height}px for ${rows} row(s)`);
      if (width >= 900 && model.length < 20) assert.equal(rows, 1, 'the slim bar fits one row on a wide window');
    });
  }
}
