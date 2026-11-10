import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, scenario, shown, skipReason, startSuite } from './harness.mjs';
let suite;
before(async () => {
  if (!skipReason) suite = await startSuite();
});
after(async () => {
  await suite?.close();
});
test('right tools shrink the chat, resize and close without covering the composer', { skip: skipReason }, async () => {
  await scenario(
    suite,
    'right-workspace-panel',
    {
      setup(b) {
        b.seedReady();
        const project = b.seedProject('Panel project', '/fake/panel');
        b.seedChat(
          'Panel layout',
          [
            ['user', 'Check tools'],
            ['assistant', 'The conversation stays readable next to the panel.'],
          ],
          project,
        );
      },
    },
    async ({ page, origin }) => {
      await openApp(page, origin);
      await page.getByRole('button', { name: 'Panel layout', exact: true }).first().click();
      const tools = page.locator('.workspace-tools');
      await shown(tools);
      const panel = page.locator('.panel');
      assert.equal(await panel.isVisible(), false);
      await tools.getByRole('button', { name: 'Changes', exact: true }).click();
      await shown(panel);
      for (const width of [900, 1600]) {
        await page.setViewportSize({ width, height: 950 });
        const r = await page.evaluate(() => {
          const box = (selector) => {
            const r = [...document.querySelectorAll(selector)]
              .find((el) => el.getBoundingClientRect().width > 0)
              .getBoundingClientRect();
            return { left: r.left, right: r.right, width: r.width };
          };
          return { panel: box('.panel.open'), chat: box('.chat-content'), composer: box('.composer-wrap') };
        });
        assert.ok(r.chat.right <= r.panel.left && r.composer.right <= r.panel.left, JSON.stringify(r));
        assert.ok(r.chat.width > 160, JSON.stringify(r));
        const separator = panel.getByRole('separator');
        await separator.focus();
        await separator.press('ArrowLeft');
        assert.equal(await separator.getAttribute('aria-valuenow'), width === 900 ? '40' : '42');
      }
      await page.screenshot({ path: '/tmp/gustaf-right-workspace-panel.png' });
      const initialWidth = (await panel.boundingBox()).width;
      await panel.getByRole('button', { name: 'Expand panel', exact: true }).click();
      assert.ok((await panel.boundingBox()).width > initialWidth);
      const composer = await page.locator('.composer-wrap:visible').boundingBox();
      assert.ok(composer.x + composer.width <= (await panel.boundingBox()).x);
      await panel.getByRole('button', { name: 'Restore panel', exact: true }).click();
      assert.ok(Math.abs((await panel.boundingBox()).width - initialWidth) < 1);
      await panel.getByRole('button', { name: 'Close panel', exact: true }).click();
      assert.equal(await panel.isVisible(), false);
      assert.equal(
        await tools
          .getByRole('button', { name: 'Changes', exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await tools.getByRole('button', { name: 'Changes', exact: true }).click();
      await shown(panel);
      await tools.getByRole('button', { name: 'Changes', exact: true }).click();
      assert.equal(await panel.isVisible(), false);
    },
  );
});
