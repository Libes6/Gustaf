// The harness itself: a scenario must fail when the page logs a console error, breaks the CSP or throws.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, scenario, skipReason, startSuite } from './harness.mjs';

let suite;
before(async () => {
  if (!skipReason) suite = await startSuite();
});
after(async () => {
  await suite?.close();
});

const failing = (name, run, pattern) =>
  test(`guard: ${name}`, { skip: skipReason }, async () => {
    await assert.rejects(
      scenario(suite, name, { setup: (b) => b.seedReady(), artifacts: false }, async ({ page, origin }) => {
        await openApp(page, origin);
        await run(page);
      }),
      pattern,
    );
  });

failing(
  'a console error fails the scenario',
  (page) => page.evaluate(() => console.error('boom')),
  /console\.error: boom/,
);
failing(
  'an uncaught exception fails the scenario',
  async (page) => {
    const thrown = page.waitForEvent('pageerror');
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('late failure');
      });
    });
    await thrown;
  },
  /uncaught: Error: late failure/,
);
failing(
  'a CSP violation fails the scenario',
  (page) =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          document.addEventListener('securitypolicyviolation', () => resolve(), { once: true });
          const s = document.createElement('script');
          s.textContent = 'window.__ran = true';
          document.head.append(s);
        }),
    ),
  /violates the following Content Security Policy/,
);
