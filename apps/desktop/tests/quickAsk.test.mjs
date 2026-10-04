// Quick ask window: pure logic (lib/quickAsk.ts). The window itself, the shortcut registration and the placement
// are Rust (src-tauri/src/quick_ask.rs, its own unit tests) and need a real desktop session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INITIAL_QUICK_ASK, DEFAULT_ACCELERATOR, DEFAULT_QUICK_ASK, MAX_CLIPBOARD_CHARS, QUICK_ASK_SYSTEM,
  acceleratorOf, buildChatPayload, buildUserText, canKeep, clipboardPreview, displayAccelerator, keyName, limitClipboard, normalizeQuickAsk,
  pickDefaultModel, quickAskErrorKey, quickAskReducer, quickAskTitle, recordAccelerator, usableModels, validateAccelerator,
} from '../src/lib/quickAsk.ts';

const model = { providerId: 'p1', model: 'gpt-x' };
const run = (...actions) => actions.reduce(quickAskReducer, INITIAL_QUICK_ASK);
const send = { type: 'send', question: ' What is a monad? ', model };
const key = (code, mods = {}) => ({ key: code, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

// ---- state machine ----------------------------------------------------------------------------------------------------

test('idle -> streaming -> done keeps the streamed answer and the usage', () => {
  const usage = { input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 0 };
  let s = run(send);
  assert.equal(s.phase, 'streaming');
  assert.equal(s.question, 'What is a monad?');
  assert.deepEqual(s.model, model);
  s = run(send, { type: 'delta', text: 'A ' }, { type: 'delta', text: 'monad' }, { type: 'finish', usage });
  assert.equal(s.phase, 'done');
  assert.equal(s.answer, 'A monad');
  assert.deepEqual(s.usage, usage);
  assert.ok(canKeep(s));
});

test('an empty question does not start anything; a second send while streaming is ignored', () => {
  assert.equal(run({ type: 'send', question: '   ', model }), INITIAL_QUICK_ASK);
  const streaming = run(send, { type: 'delta', text: 'partial' });
  assert.equal(quickAskReducer(streaming, { type: 'send', question: 'another', model }), streaming);
});

test('failure ends in error and cannot be saved', () => {
  const s = run(send, { type: 'delta', text: 'half' }, { type: 'fail', message: 'HTTP 401' });
  assert.equal(s.phase, 'error');
  assert.equal(s.error, 'HTTP 401');
  assert.equal(canKeep(s), false);
  assert.equal(buildChatPayload(s), null);
});

test('stop keeps what arrived; late chunks, finish and failure after stop are ignored', () => {
  const stopped = run(send, { type: 'delta', text: 'so far' }, { type: 'stop' });
  assert.equal(stopped.phase, 'stopped');
  assert.equal(stopped.answer, 'so far');
  assert.ok(canKeep(stopped));
  for (const late of [{ type: 'delta', text: ' more' }, { type: 'finish' }, { type: 'fail', message: 'aborted' }, { type: 'stop' }]) assert.equal(quickAskReducer(stopped, late), stopped);
});

test('a new question after a settled exchange starts clean; reset returns to idle', () => {
  const done = run(send, { type: 'delta', text: 'old' }, { type: 'finish' });
  const next = quickAskReducer(done, { type: 'send', question: 'next', model });
  assert.equal(next.phase, 'streaming');
  assert.equal(next.answer, '');
  assert.equal(next.usage, undefined);
  assert.equal(quickAskReducer(next, { type: 'reset' }), INITIAL_QUICK_ASK);
});

test('an answer-less stop or finish cannot be opened in Gustaf', () => {
  assert.equal(canKeep(run(send, { type: 'stop' })), false);
  assert.equal(canKeep(run(send, { type: 'finish' })), false);
  assert.equal(canKeep(run(send)), false);
  assert.equal(canKeep(INITIAL_QUICK_ASK), false);
});

// ---- open in Gustaf ---------------------------------------------------------------------------------------------------

test('open-in-Gustaf payload: a normal two-message chat with the text as sent, model meta and usage', () => {
  const usage = { input: 3, output: 4, cached: 0, cacheWrite: 0, reasoning: 0 };
  const s = run({ ...send, clipboard: 'let x = 1;' }, { type: 'delta', text: '**Answer**' }, { type: 'finish', usage });
  const payload = buildChatPayload(s);
  assert.equal(payload.title, 'What is a monad?');
  assert.deepEqual(payload.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(payload.messages[0].parts[0].text, 'What is a monad?\n\nClipboard text:\n```\nlet x = 1;\n```');
  assert.equal(payload.messages[0].meta, undefined);
  assert.deepEqual(payload.messages[1].parts, [{ type: 'text', text: '**Answer**' }]);
  assert.deepEqual(payload.messages[1].meta, { provider: 'p1', model: 'gpt-x', usage });
});

test('open-in-Gustaf payload of a stopped answer has no usage', () => {
  const payload = buildChatPayload(run(send, { type: 'delta', text: 'cut off' }, { type: 'stop' }));
  assert.deepEqual(payload.messages[1].meta, { provider: 'p1', model: 'gpt-x' });
});

test('chat title: first non-empty line, collapsed, cut at 60 characters', () => {
  assert.equal(quickAskTitle('\n\n  hello   there \nsecond'), 'hello there');
  assert.equal(quickAskTitle(''), 'Quick ask');
  const long = quickAskTitle('x'.repeat(100));
  assert.equal(long.length, 60);
  assert.ok(long.endsWith('…'));
});

// ---- clipboard --------------------------------------------------------------------------------------------------------

test('clipboard text is appended in a fence that cannot be closed from inside; blank clipboard adds nothing', () => {
  assert.equal(buildUserText('q'), 'q');
  assert.equal(buildUserText('q', '   \n'), 'q');
  assert.equal(buildUserText('q', null), 'q');
  const text = buildUserText('q', 'a ```js\ncode\n``` b\n\n');
  const fence = /\n(`{3,})\n/.exec(text)[1];
  assert.ok(fence.length >= 4, 'fence is longer than the longest backtick run in the clipboard');
  assert.ok(text.endsWith(`a \`\`\`js\ncode\n\`\`\` b\n${fence}`));
});

test('clipboard is normalised, limited, and previewed', () => {
  assert.deepEqual(limitClipboard('a\r\nb'), { text: 'a\nb', truncated: false, chars: 3 });
  const big = limitClipboard('x'.repeat(MAX_CLIPBOARD_CHARS + 50));
  assert.equal(big.text.length, MAX_CLIPBOARD_CHARS);
  assert.equal(big.truncated, true);
  assert.equal(big.chars, MAX_CLIPBOARD_CHARS + 50);
  assert.equal(clipboardPreview('short'), 'short');
  assert.equal(clipboardPreview('y'.repeat(500), 10), 'yyyyyyyyyy…');
});

test('the system prompt says: quick ask, no tools', () => {
  assert.match(QUICK_ASK_SYSTEM, /quick-ask/);
  assert.match(QUICK_ASK_SYSTEM, /no tools/);
});

// ---- models -----------------------------------------------------------------------------------------------------------

const providers = [
  { id: 'a', kind: 'openai', name: 'OpenAI' },
  { id: 'c', kind: 'cli', name: 'Claude CLI' },
  { id: 'u', kind: 'cursor', name: 'Cursor' },
  { id: 'd', kind: 'ollama', name: 'Ollama', disabled: true },
  { id: 'o', kind: 'ollama', name: 'Local' },
];
const m = (providerId, id) => ({ providerId, id, name: id });
const all = [m('a', 'gpt-1'), m('a', 'gpt-2'), m('c', 'sonnet'), m('u', 'auto'), m('d', 'llama'), m('o', 'qwen')];

test('usable models exclude CLI-native, disabled and hidden ones', () => {
  assert.deepEqual(usableModels(providers, all, ['a\ngpt-2']).map((x) => x.id), ['gpt-1', 'qwen']);
});

test('default model: the app selection when usable, else the first usable one (flagged)', () => {
  const usable = usableModels(providers, all);
  assert.deepEqual(pickDefaultModel({ providerId: 'a', model: 'gpt-2' }, usable), { model: usable[1], fellBack: false });
  assert.deepEqual(pickDefaultModel({ providerId: 'c', model: 'sonnet' }, usable), { model: usable[0], fellBack: true });
  assert.deepEqual(pickDefaultModel(null, usable), { model: usable[0], fellBack: false });
  assert.deepEqual(pickDefaultModel(null, []), { model: null, fellBack: false });
});

// ---- settings and accelerators ----------------------------------------------------------------------------------------

test('the setting is off by default and normalises corrupt values', () => {
  assert.deepEqual(DEFAULT_QUICK_ASK, { enabled: false, accelerator: null, hideOnBlur: true });
  assert.deepEqual(normalizeQuickAsk(undefined), DEFAULT_QUICK_ASK);
  assert.deepEqual(normalizeQuickAsk('x'), DEFAULT_QUICK_ASK);
  assert.deepEqual(normalizeQuickAsk({ enabled: 'yes', accelerator: 7, hideOnBlur: 'no' }), DEFAULT_QUICK_ASK);
  assert.deepEqual(normalizeQuickAsk({ enabled: true, accelerator: ' Alt+K ', hideOnBlur: false }), { enabled: true, accelerator: 'Alt+K', hideOnBlur: false });
  assert.equal(acceleratorOf(DEFAULT_QUICK_ASK, 'windows'), 'Control+Alt+Space');
  assert.equal(acceleratorOf({ ...DEFAULT_QUICK_ASK, accelerator: 'Alt+K' }, 'macos'), 'Alt+K');
});

test('default accelerators match the Rust side (default_accelerator_for)', () => {
  const rust = readFileSync(new URL('../src-tauri/src/quick_ask.rs', import.meta.url), 'utf8');
  const body = /pub fn default_accelerator_for[\s\S]*?\n}\n/.exec(rust)[0];
  assert.ok(body.includes(`"macos" => "${DEFAULT_ACCELERATOR.macos}"`));
  assert.ok(body.includes(`_ => "${DEFAULT_ACCELERATOR.windows}"`));
  assert.equal(DEFAULT_ACCELERATOR.windows, DEFAULT_ACCELERATOR.linux);
  for (const [p, a] of Object.entries(DEFAULT_ACCELERATOR)) assert.equal(validateAccelerator(a, p, ['CommandOrControl+Shift+Escape']), null, p);
});

test('key names for the global-shortcut plugin', () => {
  assert.equal(keyName('KeyK'), 'K');
  assert.equal(keyName('Digit7'), '7');
  assert.equal(keyName('F12'), 'F12');
  assert.equal(keyName('F25'), null);
  assert.equal(keyName('Space'), 'Space');
  assert.equal(keyName('ArrowUp'), 'ArrowUp');
  assert.equal(keyName('NumpadAdd'), null);
  assert.equal(keyName(undefined), null);
});

test('recording: modifiers first (waiting), then a canonical accelerator', () => {
  assert.deepEqual(recordAccelerator(key('ControlLeft', { ctrlKey: true }), 'windows'), { ok: false, error: 'waiting' });
  assert.deepEqual(recordAccelerator(key('Space', { ctrlKey: true, altKey: true }), 'windows'), { ok: true, accelerator: 'Control+Alt+Space' });
  assert.deepEqual(recordAccelerator(key('KeyK', { metaKey: true, shiftKey: true, altKey: true }), 'macos'), { ok: true, accelerator: 'Alt+Shift+Command+K' });
  assert.deepEqual(recordAccelerator(key('KeyK', { metaKey: true }), 'linux'), { ok: true, accelerator: 'Super+K' });
});

test('recording rejects bare keys, Shift-only, unsupported keys, OS-reserved and clashing combinations', () => {
  assert.deepEqual(recordAccelerator(key('Space'), 'macos'), { ok: false, error: 'needsModifier' });
  assert.deepEqual(recordAccelerator(key('KeyA', { shiftKey: true }), 'macos'), { ok: false, error: 'needsModifier' });
  assert.deepEqual(recordAccelerator(key('NumpadAdd', { ctrlKey: true }), 'windows'), { ok: false, error: 'unsupportedKey' });
  assert.deepEqual(recordAccelerator(key('Space', { metaKey: true }), 'macos'), { ok: false, error: 'reserved' });
  assert.deepEqual(recordAccelerator(key('Tab', { altKey: true }), 'windows'), { ok: false, error: 'reserved' });
  // the stop-agent shortcut is CommandOrControl+Shift+Escape
  assert.deepEqual(recordAccelerator(key('Escape', { metaKey: true, shiftKey: true }), 'macos', ['CommandOrControl+Shift+Escape']), { ok: false, error: 'conflict' });
  assert.deepEqual(recordAccelerator(key('Escape', { ctrlKey: true, shiftKey: true }), 'linux', ['CommandOrControl+Shift+Escape']), { ok: false, error: 'conflict' });
});

test('validateAccelerator on stored strings', () => {
  assert.equal(validateAccelerator('Control+Alt+Space', 'linux'), null);
  assert.equal(validateAccelerator('CommandOrControl+K', 'macos'), null);
  assert.equal(validateAccelerator('Space', 'linux'), 'needsModifier');
  assert.equal(validateAccelerator('Control+Alt', 'linux'), 'modifierOnly');
  assert.equal(validateAccelerator('Control+Option+Space', 'macos'), null);
});

test('display: macOS symbols, Ctrl/Alt/Win names elsewhere', () => {
  assert.equal(displayAccelerator('Command+Shift+Alt+Space', 'macos'), '⌘⇧⌥Space');
  assert.equal(displayAccelerator('Control+Alt+Space', 'macos'), '⌃⌥Space');
  assert.equal(displayAccelerator('Control+Alt+Space', 'windows'), 'Ctrl+Alt+Space');
  assert.equal(displayAccelerator('Super+ArrowUp', 'linux'), 'Win+Up');
});

test('registration errors map to a notice key', () => {
  assert.equal(quickAskErrorKey('shortcut_unavailable: already registered'), 'quickAskErrTaken');
  assert.equal(quickAskErrorKey('invalid_shortcut: x'), 'quickAskErrInvalid');
  assert.equal(quickAskErrorKey('needs_modifier: x'), 'quickAskErrModifier');
  assert.equal(quickAskErrorKey('window_error: x'), 'quickAskErrOther');
  assert.equal(quickAskErrorKey('something else'), 'quickAskErrOther');
});
