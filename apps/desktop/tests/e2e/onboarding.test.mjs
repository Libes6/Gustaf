// First run: onboarding, adding an OpenAI-compatible provider, sending the first message.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, shown, scenario, skipReason, startSuite } from './harness.mjs';
import { FAKE_BASE_URL } from './fakeBackend.mjs';

let suite;
before(async () => { if (!skipReason) suite = await startSuite(); });
after(async () => { await suite?.close(); });

test('first run: onboarding adds a provider and the first message streams in', { skip: skipReason }, async () => {
  await scenario(suite, 'onboarding-provider-first-message', {
    setup: (b) => b.provider.reply({ text: 'Hello from the fake model.' }),
  }, async ({ page, backend, origin }) => {
    await openApp(page, origin);
    await shown(page.getByRole('heading', { level: 1 }));
    await page.getByRole('button', { name: 'Skip' }).click();

    // Step 2: the "Add provider" wizard (Driver, Identity, Config). "Custom" = any OpenAI-compatible endpoint.
    await page.getByRole('button', { name: 'Custom' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByPlaceholder('https://example.com/v1').fill(FAKE_BASE_URL);
    await page.getByRole('button', { name: 'Test connection' }).click();
    await shown(page.getByText('Connected: 1 model'));
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // Main window with the provider and its model selected.
    const composer = page.getByRole('textbox', { name: 'Ask anything' });
    await shown(composer);
    assert.deepEqual(backend.getSetting('selection'), { providerId: backend.getSetting('providers')[0].id, model: 'fake-model' });
    assert.equal(backend.getSetting('onboarded'), true);

    await composer.fill('Say hello');
    await page.getByRole('button', { name: 'Send' }).click();
    await shown(page.getByText('Hello from the fake model.'));
    const body = backend.provider.chatBodies.at(-1);
    assert.equal(body.model, 'fake-model');
    assert.equal(body.messages.at(-1).content, 'Say hello');
  });
});
