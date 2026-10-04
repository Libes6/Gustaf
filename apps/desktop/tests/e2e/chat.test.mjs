// Chat scenarios on a ready app (onboarding skipped by seeding the settings): streaming and the live token meter,
// per-message actions, projects, Cmd+K search with jump-to-message.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gone, openApp, scenario, shown, skipReason, startSuite, until } from './harness.mjs';

let suite;
before(async () => { if (!skipReason) suite = await startSuite(); });
after(async () => { await suite?.close(); });

const ready = (b) => b.seedReady();
const messagesOf = (backend, chatId) => backend.rows('select role, content from messages where chat_id = ? order by id', chatId)
  .map((r) => ({ role: r.role, text: JSON.parse(r.content).parts.filter((p) => p.type === 'text').map((p) => p.text).join('') }));

async function ask(page, text) {
  const composer = page.getByRole('textbox', { name: 'Ask anything' });
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('streamed answer: the live token meter shows while streaming and goes away at the end', { skip: skipReason }, async () => {
  await scenario(suite, 'streaming-token-meter', { setup: ready }, async ({ page, backend, origin }) => {
    const stream = backend.provider.reply({ text: 'alpha beta gamma delta', hold: true });
    await openApp(page, origin);
    await ask(page, 'count');
    // The stream is held after its first chunk: partial text and the meter are on screen.
    await shown(page.getByText('alpha', { exact: false }));
    const meter = page.locator('.live-meter');
    await shown(meter);
    assert.match(await meter.innerText(), /tokens/);
    assert.equal(await page.getByText('delta').count(), 0, 'the rest of the answer has not arrived yet');
    stream.release();
    await shown(page.getByText('alpha beta gamma delta'));
    await gone(meter);
    // The finished reply is stored with the provider's usage.
    const [chat] = backend.rows('select id from chats');
    assert.deepEqual(messagesOf(backend, chat.id).map((m) => m.role), ['user', 'assistant']);
  });
});

test('message actions: edit and resend replaces the exchange, delete removes it', { skip: skipReason }, async () => {
  await scenario(suite, 'message-actions', { setup: ready }, async ({ page, backend, origin }) => {
    backend.provider.reply({ text: 'First answer' });
    backend.provider.reply({ text: 'Second answer' });
    await openApp(page, origin);
    await ask(page, 'original question');
    await shown(page.getByText('First answer'));
    const [{ id: chatId }] = backend.rows('select id from chats');

    await page.getByTitle('Edit and resend').click();
    await page.getByRole('textbox', { name: 'Edit' }).fill('edited question');
    await page.getByRole('button', { name: 'Resend' }).click();
    await shown(page.getByText('Second answer'));
    assert.equal(await page.getByText('First answer').count(), 0, 'the old reply is gone');
    assert.deepEqual(messagesOf(backend, chatId), [
      { role: 'user', text: 'edited question' },
      { role: 'assistant', text: 'Second answer' },
    ]);
    // The provider saw the edited text, not the original.
    assert.equal(backend.provider.chatBodies.at(-1).messages.at(-1).content, 'edited question');

    // Delete needs a second click to confirm; both the question and its reply go.
    const del = page.getByTitle('Delete this message and its reply').first();
    await del.click();
    await page.getByTitle('Click again to delete').first().click();
    await gone(page.getByText('Second answer'));
    await until(() => messagesOf(backend, chatId).length === 0, 'messages deleted from the database');
  });
});

test('projects: create a project and chat inside it', { skip: skipReason }, async () => {
  await scenario(suite, 'create-project', { setup: ready }, async ({ page, backend, origin }) => {
    backend.provider.reply({ text: 'Project reply' });
    await openApp(page, origin);
    await page.getByRole('navigation').getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create project' });
    await dialog.getByRole('textbox', { name: 'Project name' }).fill('Apollo');
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await gone(dialog);
    await shown(page.getByRole('complementary', { name: 'Chats and projects' }).getByText('Apollo'));
    const [project] = backend.rows('select id, name from projects');
    assert.equal(project.name, 'Apollo');

    // The new chat opens inside the project.
    await ask(page, 'hello project');
    await shown(page.getByText('Project reply'));
    const [chat] = backend.rows('select project_id from chats');
    assert.equal(chat.project_id, project.id);
  });
});

test('platform search shortcut finds a message in another chat and jumps to it', { skip: skipReason }, async () => {
  await scenario(suite, 'search-jump', {
    setup: (b) => {
      b.seedReady();
      b.seedChat('Pasta recipes', [['user', 'How long to boil spaghetti?'], ['assistant', 'Boil spaghetti for nine minutes in salted water.']]);
      b.seedChat('Garden plans', [['user', 'When do I plant tomatoes?'], ['assistant', 'Plant tomatoes after the last frost.']]);
    },
  }, async ({ page, backend, origin }) => {
    await openApp(page, origin);
    await shown(page.getByRole('complementary', { name: 'Chats and projects' }).getByText('Garden plans'));
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const palette = page.getByRole('dialog', { name: 'Search all chats' });
    await shown(palette);
    await palette.getByRole('combobox', { name: 'Search messages in all chats…' }).fill('spaghetti');
    const hits = palette.getByRole('listbox').getByRole('option');
    await shown(hits.first());
    assert.equal(await hits.count(), 2, 'both the question and the answer mention spaghetti');
    await hits.filter({ hasText: 'nine minutes' }).click();
    await gone(palette);
    // The chat opens and the matched message is highlighted.
    await shown(page.locator('.hit-flash').filter({ hasText: 'nine minutes' }));
    assert.ok(await page.getByText('Boil spaghetti for nine minutes').isVisible());
  });
});

const openChat = async (page, title) => page.getByRole('complementary', { name: 'Chats and projects' }).getByText(title, { exact: true }).first().click();
const PROJECT = '/fake/projects/shop';
const withProject = (b) => {
  b.seedReady();
  const project = b.seedProject('Shop', PROJECT);
  b.seedChat('Deploy chat', [['user', 'earlier message'], ['assistant', 'earlier reply']], project);
};

test('approval card: a shell command waits for Allow and then runs', { skip: skipReason }, async () => {
  await scenario(suite, 'approval-allow', { setup: withProject }, async ({ page, backend, origin }) => {
    backend.provider.reply({ toolCalls: [{ name: 'run_command', args: { command: 'npm install left-pad' } }] });
    backend.provider.reply({ text: 'Installed it.' });
    await openApp(page, origin);
    await openChat(page, 'Deploy chat');
    await ask(page, 'install left-pad');
    const card = page.getByRole('alertdialog', { name: 'Run this command?' });
    await shown(card);
    assert.match(await card.innerText(), /npm install left-pad/);
    assert.deepEqual(backend.shellCommands, [], 'nothing runs before the answer');
    await card.getByRole('button', { name: /^Allow/ }).click();
    await shown(page.getByText('Installed it.'));
    await gone(card);
    assert.deepEqual(backend.shellCommands, ['npm install left-pad']);
  });
});

test('approval card: Deny keeps the command from running and tells the model', { skip: skipReason }, async () => {
  await scenario(suite, 'approval-deny', { setup: withProject }, async ({ page, backend, origin }) => {
    backend.provider.reply({ toolCalls: [{ name: 'run_command', args: { command: 'npm install left-pad' } }] });
    backend.provider.reply({ text: 'Understood, not installing.' });
    await openApp(page, origin);
    await openChat(page, 'Deploy chat');
    await ask(page, 'install left-pad');
    const card = page.getByRole('alertdialog', { name: 'Run this command?' });
    await shown(card);
    await card.getByRole('button', { name: /^Deny/ }).click();
    await shown(page.getByText('Understood, not installing.'));
    assert.deepEqual(backend.shellCommands, []);
    const toolMessage = backend.provider.chatBodies.at(-1).messages.findLast((m) => m.role === 'tool');
    assert.match(toolMessage.content, /declined/i);
  });
});

const CANVAS_FENCE = '```tsx-canvas id="hello" title="Hello card"\nexport default function Hello() { return <h1>Canvas says hi</h1>; }\n```';

test('canvas: a tsx-canvas fence becomes a card that renders in its sandboxed iframe', { skip: skipReason }, async () => {
  await scenario(suite, 'canvas-card', { setup: ready }, async ({ page, backend, origin }) => {
    backend.provider.reply({ text: `Here you go.\n\n${CANVAS_FENCE}\n` });
    await openApp(page, origin);
    await ask(page, 'make a hello card');
    const card = page.getByRole('button', { name: /Hello card/ });
    await shown(card);
    await card.click();
    const frameEl = page.locator('iframe[title="Hello card"]');
    await shown(frameEl);
    assert.equal(await frameEl.getAttribute('sandbox'), 'allow-scripts');
    await shown(page.frameLocator('iframe[title="Hello card"]').getByRole('heading', { name: 'Canvas says hi' }));
    await page.getByRole('button', { name: 'Code' }).click();
    await shown(page.locator('.canvas-source').getByText('Canvas says hi'));
  });
});
