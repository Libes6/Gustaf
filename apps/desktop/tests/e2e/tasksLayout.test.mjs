// Layout of the right-hand "Background tasks" column in a real Chrome: the real stylesheets (theme.css, agents.css) with
// the markup ChatView/CanvasWorkspace/AgentsPanel produce, at the app's minimum window width (900 px) and a wide one.
// Checks that the chat shrinks (the column never overlays the composer), that the sidebar makes room on narrow windows,
// that the canvas pane shares what the column leaves, that the column floats over the canvas (not the chat) when there is
// no room for all three, and that the expanded column covers the chat area.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { findChrome } from '../helpers/chrome.mjs';

const chrome = findChrome();
const skip = chrome ? false : 'no local Chrome/Chromium found (set CHROME_BIN to run the end-to-end tests)';
const css = ['theme', 'agents'].map((n) => readFileSync(new URL(`../../src/styles/${n}.css`, import.meta.url), 'utf8')).join('\n');

let browser;
before(async () => { if (!skip) browser = await chromium.launch({ executablePath: chrome, headless: true, chromiumSandbox: !(process.env.CI || process.getuid?.() === 0) }); });
after(async () => { await browser?.close(); });

const page = ({ canvas, expanded }) => `<!doctype html><html data-theme="dark"><head><style>${css}</style></head><body>
<div class="app" id="app">
  <div class="window-header"></div><nav class="rail"></nav><aside class="sidebar"></aside>
  <div class="chat-session" style="display:flex">
    <div class="canvas-workspace${canvas ? ' has-canvas' : ''} has-tasks" id="ws" style="--canvas-width:56%;--canvas-ratio:.56">
      <main class="main" id="chat"><div class="feed" style="flex:1"></div><div class="composer-wrap" id="composer" style="height:90px"></div></main>
      ${canvas ? '<div class="canvas-divider" role="separator"></div><aside class="canvas-panel" id="canvas"></aside>' : ''}
      <aside class="tasks-column${expanded ? ' expanded' : ''}" id="tasks"><header class="tasks-head"><h2>Background tasks</h2></header><div class="tasks-body"></div></aside>
    </div>
  </div>
</div></body></html>`;

async function measure(width, opts) {
  const ctx = await browser.newContext({ viewport: { width, height: 700 } });
  try {
    const p = await ctx.newPage();
    await p.setContent(page(opts));
    return await p.evaluate(() => {
      const r = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
      return { chat: r('chat'), composer: r('composer'), tasks: r('tasks'), canvas: r('canvas'), ws: r('ws'), tasksPosition: getComputedStyle(document.getElementById('tasks')).position, sidebarVisibility: getComputedStyle(document.querySelector('.sidebar')).visibility };
    });
  } finally { await ctx.close(); }
}
const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

test('900 px, column only: the chat shrinks and stays usable, the column does not overlay the composer, the sidebar makes room', { skip }, async () => {
  const m = await measure(900, {});
  assert.ok(m.tasks.width >= 330 && m.tasks.width <= 380, `column width ${m.tasks.width}`);
  assert.equal(m.tasksPosition, 'static');
  assert.ok(m.chat.width >= 450, `chat width ${m.chat.width}`);
  assert.equal(m.sidebarVisibility, 'hidden');
  assert.ok(!overlap(m.tasks, m.composer), 'column overlays the composer');
  assert.ok(m.tasks.height >= m.ws.height - 20, 'full-height column');
  assert.ok(m.tasks.right <= m.ws.right + 0.5);
});

test('900 px with the canvas open: the column floats over the canvas pane, the chat keeps its width', { skip }, async () => {
  const m = await measure(900, { canvas: true });
  assert.equal(m.tasksPosition, 'absolute');
  assert.ok(m.chat.width >= 300, `chat width ${m.chat.width}`);
  assert.ok(!overlap(m.tasks, m.chat), 'column overlays the chat');
  assert.ok(!overlap(m.tasks, m.composer));
  assert.ok(m.tasks.left >= m.canvas.left - 0.5, 'column stays inside the canvas pane');
});

test('1700 px with the canvas open: chat, canvas and column sit side by side without overlap', { skip }, async () => {
  const m = await measure(1700, { canvas: true });
  assert.equal(m.tasksPosition, 'static');
  assert.ok(m.chat.right <= m.canvas.left + 0.5 && m.canvas.right <= m.tasks.left + 0.5, 'order chat, canvas, column');
  assert.ok(m.chat.width >= 400, `chat width ${m.chat.width}`);
  assert.ok(m.canvas.width >= 240);
  assert.ok(m.tasks.right <= m.ws.right + 0.5);
  assert.equal(m.sidebarVisibility, 'visible');
});

test('the expanded column covers the whole chat area', { skip }, async () => {
  const m = await measure(1280, { expanded: true });
  assert.equal(m.tasksPosition, 'absolute');
  assert.ok(m.tasks.left <= m.chat.left + 10 && m.tasks.right >= m.chat.right - 10 && m.tasks.top <= m.ws.top + 10 && m.tasks.bottom >= m.ws.bottom - 10);
});
