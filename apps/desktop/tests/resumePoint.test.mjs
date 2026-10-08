import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumePoint } from '../src/providers/cliArgs.ts';

const user = (text) => ({ role: 'user', parts: [{ type: 'text', text }] });
const bot = (text, provider, responseId) => ({
  role: 'assistant',
  parts: [{ type: 'text', text }],
  meta: { provider, responseId },
});
const turn = (messages) => ({ system: 'SYS', messages });

test('a provider resumes its own last session with only the new user messages', () => {
  const p = resumePoint(turn([user('one'), bot('r1', 'acc-a', 'sess-a'), user('two')]), 'acc-a', false);
  assert.equal(p.session, 'sess-a');
  assert.equal(p.prompt, 'SYS\n\ntwo');
});

test('after switching to another account the session is not reused: fresh session, whole history as text', () => {
  const p = resumePoint(turn([user('one'), bot('r1', 'acc-a', 'sess-a'), user('two')]), 'acc-b', false);
  assert.equal(p.session, undefined);
  assert.match(p.prompt, /USER:\none/);
  assert.match(p.prompt, /ASSISTANT:\nr1/);
  assert.match(p.prompt, /USER:\ntwo/);
});

test('switching back must not skip what the other account answered in between', () => {
  const messages = [
    user('one'),
    bot('r1', 'acc-a', 'sess-a'),
    user('two'),
    bot('r2', 'acc-b', 'sess-b'),
    user('three'),
  ];
  const back = resumePoint(turn(messages), 'acc-a', false);
  assert.equal(back.session, undefined);
  assert.match(back.prompt, /ASSISTANT:\nr2/);
  // The account that answered last still resumes.
  assert.equal(resumePoint(turn(messages), 'acc-b', false).session, 'sess-b');
});

test('imported or provider-less assistant messages do not break resuming', () => {
  const messages = [
    user('one'),
    bot('r1', 'acc-a', 'sess-a'),
    { role: 'assistant', parts: [{ type: 'text', text: 'imported' }] },
    user('two'),
  ];
  assert.equal(resumePoint(turn(messages), 'acc-a', false).session, 'sess-a');
});

test('the system message is always part of the prompt (resumed sessions may predate it)', () => {
  assert.equal(resumePoint(turn([user('hello')]), 'x', true).prompt, 'SYS\n\nhello');
  assert.equal(resumePoint(turn([user('hello')]), 'x', false).prompt, 'SYS\n\nhello');
  assert.equal(resumePoint(turn([user('one'), bot('r', 'x', 's'), user('two')]), 'x', true).prompt, 'SYS\n\ntwo');
});

test('a reply cut short (Stop or a restart for a follow-up) is handed back to the resumed CLI', () => {
  const cut = {
    ...bot('half of the answer', 'acc-a', 'sess-a'),
    meta: { provider: 'acc-a', responseId: 'sess-a', interrupted: true },
  };
  const p = resumePoint(turn([user('one'), cut, user('also do X')]), 'acc-a', false);
  assert.equal(p.session, 'sess-a');
  assert.equal(
    p.prompt,
    'SYS\n\n[Your previous reply was interrupted. What you had written so far:]\nhalf of the answer\n\nalso do X',
  );
  const whole = resumePoint(turn([user('one'), bot('done', 'acc-a', 'sess-a'), user('next')]), 'acc-a', false);
  assert.equal(whole.prompt, 'SYS\n\nnext', 'a finished reply is not repeated');
});
