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

test(
  'rail update icon sits above account and performs download, install and restart in order',
  { skip: skipReason },
  async () => {
    const actions = [];
    await scenario(
      suite,
      'rail-update',
      {
        setup(backend) {
          backend.seedReady();
          const invoke = backend.invoke.bind(backend);
          backend.invoke = async (command, args) => {
            if (command === 'updater_configured') return true;
            if (command === 'plugin:app|version') return '0.1.0';
            if (command === 'plugin:updater|check')
              return { rid: 1, currentVersion: '0.1.0', version: '0.1.1', body: 'Test update' };
            if (command === 'plugin:updater|download') {
              actions.push('download');
              return 2;
            }
            if (command === 'plugin:updater|install') {
              actions.push('install');
              return;
            }
            if (command === 'plugin:process|restart') {
              actions.push('restart');
              return;
            }
            return invoke(command, args);
          };
        },
      },
      async ({ page, origin }) => {
        await openApp(page, origin);
        const button = page.getByRole('button', { name: 'Update to 0.1.1 and restart' });
        await shown(button);
        assert.equal(await button.evaluate((el) => el.nextElementSibling?.getAttribute('aria-label')), 'App menu');
        const bounds = await button.boundingBox();
        assert.equal(bounds.width, 32);
        assert.equal(bounds.height, 32);
        await button.focus();
        await page.keyboard.press('Enter');
        await until(() => actions.length === 3, 'update and restart');
        assert.deepEqual(actions, ['download', 'install', 'restart']);
      },
    );
  },
);
