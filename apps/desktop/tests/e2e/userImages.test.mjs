// A sent message with pictures in a real Chrome: pictures first (no bubble background or padding around them), the text
// bubble below with only the text, no overflow at 360 px, in both themes. Set E2E_SHOT_DIR to also write screenshots.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { openApp, scenario, shown, skipReason, startSuite } from './harness.mjs';

let suite;
before(async () => { if (!skipReason) suite = await startSuite(); });
after(async () => { await suite?.close(); });

// A solid-colour PNG, built without any image library.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), 8 + data.length);
  return out;
};
function png(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const PICS = [png(640, 480, [230, 120, 60]), png(480, 640, [60, 160, 120]), png(800, 300, [90, 110, 220])];

function seed(b, theme) {
  b.seedReady();
  b.setting('theme', theme);
  const { chatId } = b.seedChat('Pictures', [['assistant', 'placeholder']]);
  b.db.prepare('delete from messages where chat_id = ?').run(chatId);
  const add = (role, parts) => b.db.prepare('insert into messages(chat_id, role, content, created_at) values(?, ?, ?, ?)').run(chatId, role, JSON.stringify({ role, parts }), Date.now());
  const text = (t) => ({ type: 'text', text: t });
  const image = (data) => ({ type: 'image', data });
  add('user', [text('One picture and some text'), image(PICS[0])]);
  add('assistant', [text('Got it.')]);
  add('user', [text('Three pictures at once, with a longer caption that wraps onto a second line on a narrow window'), image(PICS[0]), image(PICS[1]), image(PICS[2])]);
  add('assistant', [text('Seen all three.')]);
  add('user', [image(PICS[2])]);
  add('assistant', [text('A picture only.')]);
  add('user', [text('Text only, as before')]);
  add('assistant', [text('Fine.')]);
}

async function check(page, origin, theme, width, shots) {
  await page.setViewportSize({ width, height: 900 });
  if (width >= 700) {
    await openApp(page, origin);
    await page.getByRole('complementary', { name: 'Chats and projects' }).getByText('Pictures', { exact: true }).first().click();
  } else {
    // The app's own minimum window is wider than 360 px: emulate a 360 px chat column by taking the side columns away.
    await page.addStyleTag({ content: '.app { grid-template-columns: 0 0 1fr !important; } .sidebar, .rail { visibility: hidden; }' });
  }
  await shown(page.getByText('Seen all three.'));
  await page.waitForFunction(() => [...document.querySelectorAll('.msg-user img')].every((i) => i.complete && i.naturalWidth > 0));
  const m = await page.evaluate(() => {
    const feed = document.querySelector('.feed');
    const users = [...document.querySelectorAll('.msg-user')].map((u) => {
      const box = u.querySelector('.msg-images');
      const bubble = u.querySelector('.bubble');
      const bs = box && getComputedStyle(box);
      const rect = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      return {
        images: [...u.querySelectorAll('img')].map(rect),
        box: box && rect(box),
        bubble: bubble && rect(bubble),
        bubbleHasImg: !!bubble?.querySelector('img'),
        boxBg: bs && bs.backgroundColor,
        boxPad: bs && bs.padding,
        boxBorder: bs && bs.borderTopWidth,
        userRight: rect(u).right,
        radius: u.querySelector('img') ? getComputedStyle(u.querySelector('img')).borderTopLeftRadius : null,
      };
    });
    return { users, feedClient: feed.clientWidth, feedScroll: feed.scrollWidth, docScroll: document.documentElement.scrollWidth, innerWidth, feed: (() => { const r = feed.getBoundingClientRect(); return { left: r.left, right: r.right }; })() };
  });
  assert.equal(m.users.length, 4);
  assert.ok(m.feedScroll <= m.feedClient, `feed overflows horizontally at ${width}px (${m.feedScroll} > ${m.feedClient})`);
  assert.ok(m.docScroll <= m.innerWidth, `page overflows horizontally at ${width}px`);
  const [one, three, only, plain] = m.users;
  for (const u of [one, three, only]) {
    assert.equal(u.bubbleHasImg, false, 'no picture inside the bubble');
    assert.equal(u.boxBg, 'rgba(0, 0, 0, 0)', 'no background behind the pictures');
    assert.equal(u.boxPad, '0px', 'no padding around the pictures');
    assert.equal(u.boxBorder, '0px');
    assert.equal(u.radius, '12px');
    for (const r of u.images) assert.ok(r.right <= m.feed.right + 0.5 && r.left >= m.feed.left - 0.5, `picture inside the feed at ${width}px`);
    assert.ok(Math.abs(u.box.right - u.userRight) < 1, 'pictures are right-aligned');
  }
  assert.ok(one.box.bottom <= one.bubble.top, 'picture above the text');
  assert.equal(one.images.length, 1);
  assert.equal(three.images.length, 3);
  assert.ok(three.box.bottom <= three.bubble.top);
  assert.ok(Math.max(...three.images.map((r) => r.right)) <= three.box.right + 0.5);
  if (width < 700) assert.ok(new Set(three.images.map((r) => Math.round(r.top))).size > 1, 'pictures wrap on a narrow window');
  assert.equal(only.bubble, null, 'no empty bubble');
  assert.equal(plain.box, null);
  assert.ok(plain.bubble);
  if (shots) await page.screenshot({ path: join(shots, `user-images-${theme}-${width}.png`) });
}

for (const theme of ['light', 'dark']) {
  test(`sent message with pictures: pictures first, no frame, no overflow (${theme}, wide and 360 px)`, { skip: skipReason }, async () => {
    const shots = process.env.E2E_SHOT_DIR;
    if (shots) mkdirSync(shots, { recursive: true });
    await scenario(suite, `user-images-${theme}`, { setup: (b) => seed(b, theme), colorScheme: theme }, async ({ page, origin }) => {
      await check(page, origin, theme, 1280, shots);
      await check(page, origin, theme, 360, shots);
    });
  });
}

// The old flex layout could shrink widths and stretch heights independently. Measure the
// actual TurnView images against decoded PNG dimensions, rather than only checking overflow.
const MIXED = [png(1000, 250, [230, 120, 60]), png(600, 300, [90, 110, 220]), png(240, 960, [60, 160, 120]), png(500, 500, [160, 90, 180])];
const CANVAS = '```tsx-canvas id="image-check" title="Image layout canvas"\nexport default function Preview() { return <p>Image layout canvas</p>; }\n```';
for (const count of [1, 2, 3, 8]) {
  test(`mixed sent images preserve natural proportions: ${count}, narrow/wide, canvas open/closed`, { skip: skipReason }, async () => {
    await scenario(suite, `image-ratios-${count}`, { setup: (b) => {
      b.seedReady();
      const { chatId, messageIds } = b.seedChat('Image ratios', [['user', 'Pictures'], ['assistant', CANVAS]]);
      const parts = Array.from({ length: count }, (_, i) => ({ type: 'image', data: MIXED[i % MIXED.length] }));
      b.db.prepare('update messages set content = ? where id = ?').run(JSON.stringify({ role: 'user', parts }), messageIds[0]);
    } }, async ({ page, origin }) => {
      await openApp(page, origin);
      await page.getByRole('complementary', { name: 'Chats and projects' }).getByText('Image ratios', { exact: true }).first().click();
      for (const canvas of [false, true]) {
        await page.setViewportSize({ width: 1500, height: 1000 });
        if (canvas) {
          await page.getByRole('button', { name: /Image layout canvas/ }).first().click();
          await shown(page.locator('.canvas-panel'));
        }
        for (const width of [1500, 900]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.waitForFunction(() => [...document.querySelectorAll('.msg-images img')].every((i) => i.complete && i.naturalWidth));
          const layout = await page.locator('.msg-images').evaluate((gallery) => {
            const box = gallery.getBoundingClientRect();
            return { box: { left: box.left, right: box.right }, images: [...gallery.querySelectorAll('img')].map((i) => {
              const r = i.getBoundingClientRect();
              return { width: r.width, height: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom, ratio: i.naturalWidth / i.naturalHeight };
            }) };
          });
          assert.equal(layout.images.length, count);
          for (const image of layout.images) {
            assert.ok(Math.abs(image.width / image.height / image.ratio - 1) < 0.002, `distorted PNG at ${width}px, canvas ${canvas}: ${JSON.stringify(image)}`);
            assert.ok(image.width > 50 && image.height > 30, 'preview remains usable');
            assert.ok(image.width <= 240.5 && image.height <= 320.5, 'preview remains bounded');
            assert.ok(image.left >= layout.box.left - 0.5 && image.right <= layout.box.right + 0.5, 'image fits the gallery');
          }
          for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
            const a = layout.images[i], b = layout.images[j];
            assert.ok(a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5, 'previews do not overlap');
          }
          if (process.env.E2E_SHOT_DIR) {
            mkdirSync(process.env.E2E_SHOT_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.E2E_SHOT_DIR, `image-ratios-${count}-${width}-canvas-${canvas}.png`) });
          }
        }
      }
      const thumb = page.locator('.msg-images img').first();
      await thumb.focus();
      await page.keyboard.press('Enter');
      await shown(page.getByRole('dialog'));
      assert.equal(await page.locator('.image-viewer img').getAttribute('src'), await thumb.getAttribute('src'), 'viewer uses the complete original');
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.ok(await thumb.evaluate((i) => i === document.activeElement), 'viewer restores thumbnail focus');
    });
  });
}

test('composer keeps mixed thumbnail content visible and opens the full original', { skip: skipReason }, async () => {
  await scenario(suite, 'composer-image-ratios', { setup: (b) => b.seedReady() }, async ({ page, origin }) => {
    await openApp(page, origin);
    await page.getByRole('textbox', { name: 'Ask anything' }).evaluate((textarea, pics) => {
      const transfer = new DataTransfer();
      for (let i = 0; i < pics.length; i++) {
        const bytes = Uint8Array.from(atob(pics[i]), (c) => c.charCodeAt(0));
        transfer.items.add(new File([bytes], `image-${i}.png`, { type: 'image/png' }));
      }
      textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, MIXED);
    await page.waitForFunction(() => document.querySelectorAll('.attach img').length === 4 && [...document.querySelectorAll('.attach img')].every((i) => i.complete && i.naturalWidth));
    const thumbs = await page.locator('.attach img').evaluateAll((images) => images.map((image) => {
      const r = image.getBoundingClientRect();
      return { fit: getComputedStyle(image).objectFit, width: r.width, height: r.height };
    }));
    assert.ok(thumbs.every((i) => i.fit === 'contain' && i.width === 48 && i.height === 48), 'bounded thumbnails contain the entire image');
    await page.locator('.attach img').first().click();
    await shown(page.getByRole('dialog'));
    assert.equal(await page.locator('.image-viewer img').getAttribute('src'), await page.locator('.attach img').first().getAttribute('src'));
    await page.keyboard.press('Escape');
  });
});
