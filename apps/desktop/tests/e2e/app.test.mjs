// Whole-app scenarios: settings pages, chat export/import, theme persistence.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, scenario, shown, skipReason, startSuite, until } from './harness.mjs';

let suite;
before(async () => {
  if (!skipReason) suite = await startSuite();
});
after(async () => {
  await suite?.close();
});

const ready = (b) => b.seedReady();
const openSettings = async (page) => {
  await page.getByRole('button', { name: 'Help' }).click();
  await shown(page.getByRole('navigation', { name: 'Settings' }));
};

test('every settings page opens without console errors', { skip: skipReason }, async () => {
  await scenario(suite, 'settings-pages', { setup: ready }, async ({ page, origin }) => {
    await openApp(page, origin);
    await openSettings(page);
    const nav = page.getByRole('navigation', { name: 'Settings' });
    const pages = await nav.getByRole('group').getByRole('button').allInnerTexts(); // the trailing "Docs" button is an external link, not a page
    assert.ok(pages.length >= 9, `expected the settings navigation to list every page, got ${pages.join(', ')}`);
    const main = page.locator('main.settings-main');
    for (const name of pages) {
      // A button may carry a small suffix (a "docs" link marker); the page title is the leading label.
      await nav.getByRole('button', { name, exact: true }).click();
      await until(async () => name.startsWith(await main.getAttribute('aria-label')), `page "${name}" shown`);
      await shown(main);
    }
  });
});

test('export all chats as JSON, then import the file into an emptied app', { skip: skipReason }, async () => {
  await scenario(
    suite,
    'export-import',
    {
      setup: (b) => {
        b.seedReady();
        b.seedChat('Pasta recipes', [
          ['user', 'How long to boil spaghetti?'],
          ['assistant', 'Nine minutes.'],
        ]);
        b.seedChat('Garden plans', [
          ['user', 'When do I plant tomatoes?'],
          ['assistant', 'After the last frost.'],
        ]);
      },
    },
    async ({ page, backend, origin }) => {
      await openApp(page, origin);
      await openSettings(page);
      await page
        .getByRole('navigation', { name: 'Settings' })
        .getByRole('button', { name: 'Import', exact: true })
        .click();
      await page.getByRole('button', { name: 'JSON', exact: true }).click();
      await shown(page.getByRole('status').filter({ hasText: 'Saved: /exports/gustaf-export.json' }));
      const exported = backend.files.get('/exports/gustaf-export.json');
      assert.ok(exported, 'the export was written through fs_write');
      assert.match(exported, /Nine minutes\./);
      assert.match(exported, /After the last frost\./);

      // Empty the database, reload the app and import the file again.
      backend.db.exec('delete from chats');
      await page.reload();
      await page.locator('.app').waitFor();
      await openSettings(page);
      await page
        .getByRole('navigation', { name: 'Settings' })
        .getByRole('button', { name: 'Import', exact: true })
        .click();
      await page
        .locator('input[type=file][accept*="json"]')
        .setInputFiles({ name: 'gustaf-export.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
      await shown(page.getByRole('status').filter({ hasText: 'Chats imported: 2, already present: 0.' }));
      const titles = backend.rows('select title from chats order by title').map((r) => r.title);
      assert.deepEqual(titles, ['Garden plans', 'Pasta recipes']);
      assert.equal(backend.rows('select count(*) as n from messages')[0].n, 4);

      // Importing the same file again skips what is already there.
      await page
        .locator('input[type=file][accept*="json"]')
        .setInputFiles({ name: 'gustaf-export.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
      await shown(page.getByRole('status').filter({ hasText: 'Chats imported: 0, already present: 2.' }));
    },
  );
});

test('theme switch applies at once and persists across a reload', { skip: skipReason }, async () => {
  // The OS scheme is dark, the app default is dark: choosing Light must be what makes the page light.
  await scenario(suite, 'theme-persists', { setup: ready, colorScheme: 'dark' }, async ({ page, backend, origin }) => {
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    const waitForTheme = (want) => until(async () => (await theme()) === want, `${want} theme applied`);
    await openApp(page, origin);
    await waitForTheme('dark');
    await openSettings(page);
    await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }).click();
    await waitForTheme('light');
    await until(() => backend.getSetting('theme') === 'light', 'theme saved to settings');

    await page.reload();
    await page.locator('.app').waitFor();
    await waitForTheme('light');

    // The stored setting alone (empty localStorage, as in a fresh webview profile) restores it too.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.locator('.app').waitFor();
    await waitForTheme('light');

    await openSettings(page);
    await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click();
    await waitForTheme('dark');
    await until(() => backend.getSetting('theme') === 'dark', 'dark theme saved');
  });
});
