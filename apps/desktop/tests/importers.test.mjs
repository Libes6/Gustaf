// Importers for Claude Code, Codex and ChatGPT histories. All fixtures are synthetic; none is copied from real chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, NO_RESULT, eachLine, pairTools, storedSourceId, toMs } from '../src/lib/importers/common.ts';
import { claudeUserText, parseClaudeSession } from '../src/lib/importers/claudeCode.ts';
import { isInjected, parseCodexSession } from '../src/lib/importers/codex.ts';
import { parseChatGptConversation, threadPath } from '../src/lib/importers/chatgpt.ts';
import { duplicateKeys, importChats } from '../src/lib/importers/run.ts';
import { filterSessions, selectable } from '../src/lib/importers/list.ts';
import { REDACTED } from '../src/lib/exportChats.ts';

const jsonl = (...lines) => lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
const T = (s) => `2026-01-05T09:00:${String(s).padStart(2, '0')}.000Z`;
const FAKE_KEY = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';

// ---------------------------------------------------------------------------------------------------- Claude Code

const claudeUser = (content, extra = {}) => ({
  type: 'user',
  isSidechain: false,
  sessionId: 's-1',
  cwd: '/work/demo',
  timestamp: T(0),
  message: { role: 'user', content },
  ...extra,
});
const claudeAssistant = (blocks, id = 'm1', extra = {}) => ({
  type: 'assistant',
  isSidechain: false,
  sessionId: 's-1',
  timestamp: T(1),
  message: { id, role: 'assistant', model: 'claude-x', content: blocks },
  ...extra,
});

function claudeSession() {
  return jsonl(
    { type: 'queue-operation', operation: 'enqueue', sessionId: 's-1' },
    { type: 'file-history-snapshot', messageId: 'x', snapshot: {} },
    claudeUser('Fix the build', { timestamp: T(0) }),
    claudeAssistant([{ type: 'thinking', thinking: 'hmm', signature: 'sig' }], 'm1', { timestamp: T(1) }),
    claudeAssistant([{ type: 'text', text: 'Let me look.' }], 'm1', { timestamp: T(1) }),
    claudeAssistant(
      [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: `export KEY=${FAKE_KEY} && ls` } }],
      'm1',
      { timestamp: T(2) },
    ),
    claudeAssistant([{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/work/demo/a.ts' } }], 'm1', {
      timestamp: T(2),
    }),
    claudeUser(
      [{ type: 'tool_result', tool_use_id: 'tu1', content: `API_KEY=${FAKE_KEY}\nfile.ts`, is_error: false }],
      { timestamp: T(3) },
    ),
    claudeUser(
      [{ type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'text', text: 'ENOENT' }], is_error: true }],
      { timestamp: T(4) },
    ),
    'this is not json',
    '[1,2,3]',
    claudeUser('sub agent says hi', { isSidechain: true, timestamp: T(5) }),
    claudeUser('meta line', { isMeta: true, timestamp: T(5) }),
    claudeAssistant([{ type: 'text', text: 'Done.' }], 'm2', { timestamp: T(6) }),
    { type: 'custom-title', customTitle: 'Build fix', sessionId: 's-1' },
  );
}

test('claude: maps user, assistant, tool_use and tool_result; skips noise', () => {
  const chat = parseClaudeSession(claudeSession());
  assert.equal(chat.source, 'claude-code');
  assert.equal(chat.sourceId, 's-1');
  assert.equal(chat.title, 'Build fix');
  assert.deepEqual(chat.project, { name: 'demo', path: '/work/demo' });
  assert.equal(chat.createdAt, Date.parse(T(0)));
  assert.equal(chat.updatedAt, Date.parse(T(6)));
  assert.equal(chat.skippedLines, 2);
  assert.deepEqual(
    chat.messages.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  const [user, asst, tool, last] = chat.messages;
  assert.deepEqual(user.parts, [{ type: 'text', text: 'Fix the build' }]);
  assert.equal(user.createdAt, Date.parse(T(0)));
  // three streamed lines of one turn (thinking is dropped) became one message
  assert.deepEqual(
    asst.parts.map((p) => p.type),
    ['text', 'tool_call', 'tool_call'],
  );
  assert.equal(asst.meta.model, 'claude-x');
  assert.equal(asst.meta.imported, 'claude-code');
  assert.deepEqual(
    tool.parts.map((p) => [p.id, p.name, p.isError ?? false]),
    [
      ['tu1', 'Bash', false],
      ['tu2', 'Read', true],
    ],
  );
  assert.equal(tool.parts[1].output, 'ENOENT');
  assert.deepEqual(last.parts, [{ type: 'text', text: 'Done.' }]);
});

test('claude: secrets in tool arguments and output are scrubbed', () => {
  const chat = parseClaudeSession(claudeSession());
  const json = JSON.stringify(chat.messages);
  assert.ok(!json.includes(FAKE_KEY));
  assert.ok(json.includes(REDACTED));
});

test('claude: calls without results get a placeholder, orphan results are dropped', () => {
  const chat = parseClaudeSession(
    jsonl(
      claudeUser('go'),
      claudeAssistant([{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }]),
      claudeUser('next question', { timestamp: T(3) }),
      claudeUser([{ type: 'tool_result', tool_use_id: 'ghost', content: 'orphan' }], { timestamp: T(4) }),
      claudeAssistant([{ type: 'text', text: 'ok' }], 'm9', { timestamp: T(5) }),
    ),
  );
  assert.deepEqual(
    chat.messages.map((m) => m.role),
    ['user', 'assistant', 'tool', 'user', 'assistant'],
  );
  assert.equal(chat.messages[2].parts[0].output, NO_RESULT);
  assert.equal(chat.messages[2].parts[0].isError, true);
  assert.ok(!JSON.stringify(chat.messages).includes('orphan'));
});

test('claude: slash commands and harness wrappers', () => {
  assert.equal(claudeUserText('<command-name>/clear</command-name>\n<command-args></command-args>'), '/clear');
  assert.equal(claudeUserText('<command-name>/review</command-name><command-args>main</command-args>'), '/review main');
  assert.equal(claudeUserText('<system-reminder>be nice</system-reminder>'), '');
  assert.equal(claudeUserText('<local-command-stdout>out</local-command-stdout>'), '');
  assert.equal(claudeUserText('real text <system-reminder>x</system-reminder>'), 'real text');
});

test('claude: title falls back to ai-title, summary, first prompt; missing id uses fallback', () => {
  const body = [claudeUser('  Explain   this\nfunction please ', { sessionId: undefined })];
  assert.equal(parseClaudeSession(jsonl(...body), 'file-id').title, 'Explain this function please');
  assert.equal(parseClaudeSession(jsonl(...body, { type: 'summary', summary: 'Sum' }), 'f').title, 'Sum');
  assert.equal(
    parseClaudeSession(jsonl(...body, { type: 'summary', summary: 'Sum' }, { type: 'ai-title', aiTitle: 'AI' }), 'f')
      .title,
    'AI',
  );
  assert.equal(parseClaudeSession(jsonl(...body)), null); // no session id anywhere
});

test('claude: empty and unusable files give null', () => {
  assert.equal(parseClaudeSession(''), null);
  assert.equal(parseClaudeSession('garbage\n{"type":"queue-operation"}\n', 'x'), null);
  assert.equal(parseClaudeSession(jsonl(claudeUser('only side chain', { isSidechain: true })), 'x'), null);
});

test('claude: huge lines are skipped, long text is clipped, message count is capped', () => {
  const huge = JSON.stringify(claudeUser('x'.repeat(LIMITS.line + 10)));
  const long = claudeAssistant([{ type: 'text', text: 'y'.repeat(LIMITS.text + 500) }], 'mm', { timestamp: T(2) });
  const chat = parseClaudeSession(jsonl(claudeUser('first'), huge, long));
  assert.equal(chat.skippedLines, 1);
  assert.equal(chat.messages.length, 2);
  const text = chat.messages[1].parts[0].text;
  assert.ok(text.length < LIMITS.text + 100 && text.includes('[truncated 500 characters]'));

  const many = [];
  for (let i = 0; i < LIMITS.messages + 50; i++) many.push(claudeUser(`q${i}`, { timestamp: T(i % 60) }));
  const capped = parseClaudeSession(jsonl(...many));
  assert.equal(capped.messages.length, LIMITS.messages);
  assert.equal(capped.clipped, true);
});

test('claude: images become a placeholder, tool output is clipped', () => {
  const chat = parseClaudeSession(
    jsonl(
      claudeUser([
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', data: 'AAAA' } },
      ]),
      claudeAssistant([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]),
      claudeUser([{ type: 'tool_result', tool_use_id: 't', content: 'z'.repeat(LIMITS.output + 10) }], {
        timestamp: T(3),
      }),
    ),
  );
  assert.deepEqual(
    chat.messages[0].parts.map((p) => p.text),
    ['look', '[image omitted]'],
  );
  assert.ok(chat.messages[2].parts[0].output.includes('[truncated 10 characters]'));
});

// ---------------------------------------------------------------------------------------------------- Codex

const cx = (type, payload, s = 0) => ({ timestamp: T(s), type, payload });
const cxMsg = (role, text, s) =>
  cx(
    'response_item',
    { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
    s,
  );

function codexSession() {
  return jsonl(
    cx('session_meta', { id: 'cx-1', cwd: '/work/api', timestamp: T(0), source: 'cli', originator: 'codex_exec' }),
    cx('turn_context', { model: 'gpt-x', cwd: '/work/api' }, 0),
    cxMsg('developer', 'system prompt that must not be imported', 0),
    cxMsg('user', '<environment_context>\n<cwd>/work/api</cwd>\n</environment_context>', 1),
    cxMsg('user', '# AGENTS.md instructions for /work/api\nbe terse', 1),
    cxMsg('user', 'Add a unit test', 2),
    cx('event_msg', { type: 'user_message', message: 'Add a unit test' }, 2),
    cx('response_item', { type: 'reasoning', summary: [], encrypted_content: 'zzz' }, 3),
    cxMsg('assistant', 'Running the tests first.', 3),
    cx(
      'response_item',
      {
        type: 'function_call',
        name: 'shell',
        arguments: JSON.stringify({ command: ['bash', '-lc', `echo ${FAKE_KEY}`] }),
        call_id: 'c1',
      },
      4,
    ),
    cx('response_item', { type: 'custom_tool_call', name: 'exec', input: 'ls -la', call_id: 'c2' }, 4),
    cx(
      'response_item',
      {
        type: 'function_call_output',
        call_id: 'c1',
        output: JSON.stringify({ output: 'ok\n', metadata: { exit_code: 0 } }),
      },
      5,
    ),
    cx(
      'response_item',
      {
        type: 'custom_tool_call_output',
        call_id: 'c2',
        output: [
          { type: 'text', text: 'a.ts' },
          { type: 'text', text: 'b.ts' },
        ],
      },
      5,
    ),
    '{"truncated json',
    cx('event_msg', { type: 'agent_message', message: 'dup' }, 6),
    cxMsg('assistant', 'Test added.', 7),
  );
}

test('codex: maps messages and tool items; skips injected context and duplicates', () => {
  const chat = parseCodexSession(codexSession());
  assert.equal(chat.source, 'codex');
  assert.equal(chat.sourceId, 'cx-1');
  assert.equal(chat.title, 'Add a unit test');
  assert.deepEqual(chat.project, { name: 'api', path: '/work/api' });
  assert.equal(chat.createdAt, Date.parse(T(0)));
  assert.equal(chat.updatedAt, Date.parse(T(7)));
  assert.equal(chat.skippedLines, 1);
  assert.deepEqual(
    chat.messages.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  const [user, asst, tool, last] = chat.messages;
  assert.equal(user.parts[0].text, 'Add a unit test');
  assert.deepEqual(
    asst.parts.map((p) => p.type),
    ['text', 'tool_call', 'tool_call'],
  );
  assert.equal(asst.meta.model, 'gpt-x');
  assert.deepEqual(asst.parts[2].args, { input: 'ls -la' });
  assert.deepEqual(
    tool.parts.map((p) => [p.id, p.name, p.output]),
    [
      ['c1', 'shell', 'ok\n'],
      ['c2', 'exec', 'a.ts\nb.ts'],
    ],
  );
  assert.equal(last.parts[0].text, 'Test added.');
  assert.ok(!JSON.stringify(chat).includes(FAKE_KEY));
  assert.ok(!JSON.stringify(chat).includes('system prompt'));
});

test('codex: sub-agent threads, legacy layout and unusable files', () => {
  assert.equal(
    parseCodexSession(
      jsonl(cx('session_meta', { id: 'sub', source: { subagent: { other: 'guardian' } } }), cxMsg('user', 'hi', 1)),
    ),
    null,
  );
  assert.equal(
    parseCodexSession(jsonl(cx('session_meta', { id: 'sub', parent_thread_id: 'p' }), cxMsg('user', 'hi', 1))),
    null,
  );
  const legacy = parseCodexSession(
    jsonl(
      { id: 'old-1', timestamp: T(0), instructions: 'x' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old question' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old answer' }] },
      { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'k' },
      { type: 'function_call_output', call_id: 'k', output: 'plain' },
    ),
  );
  assert.equal(legacy.sourceId, 'old-1');
  assert.deepEqual(
    legacy.messages.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  );
  assert.equal(parseCodexSession('not json'), null);
  assert.equal(
    parseCodexSession(
      jsonl(cx('session_meta', { id: 'e' }), cxMsg('user', '<environment_context>x</environment_context>')),
    ),
    null,
  );
  assert.equal(parseCodexSession(jsonl(cxMsg('user', 'no id'))), null);
  assert.equal(parseCodexSession(jsonl(cxMsg('user', 'no id')), 'from-file').sourceId, 'from-file');
});

test('codex: injected-context detection and non-JSON tool arguments', () => {
  assert.ok(isInjected('  <environment_context>x'));
  assert.ok(isInjected('<user_instructions>x'));
  assert.ok(!isInjected('please read <environment_context> in the docs'));
  const chat = parseCodexSession(
    jsonl(
      cx('session_meta', { id: 'z' }),
      cxMsg('user', 'go', 1),
      cx('response_item', { type: 'function_call', name: 'f', arguments: 'not json', call_id: 'q' }, 2),
      cx('response_item', { type: 'function_call_output', call_id: 'q', output: '{not really json' }, 3),
    ),
  );
  assert.deepEqual(chat.messages[1].parts[0].args, { arguments: 'not json' });
  assert.equal(chat.messages[2].parts[0].output, '{not really json');
});

test('codex: huge line skipped and parallel calls share one tool message', () => {
  const huge = JSON.stringify(cxMsg('user', 'x'.repeat(LIMITS.line + 5), 1));
  const chat = parseCodexSession(
    jsonl(
      cx('session_meta', { id: 'h' }),
      cxMsg('user', 'go', 1),
      huge,
      cx('response_item', { type: 'function_call', name: 'a', arguments: '{}', call_id: '1' }, 2),
      cx('response_item', { type: 'function_call', name: 'b', arguments: '{}', call_id: '2' }, 2),
      cx('response_item', { type: 'function_call_output', call_id: '2', output: 'two' }, 3),
      cx('response_item', { type: 'function_call_output', call_id: '1', output: 'one' }, 3),
    ),
  );
  assert.equal(chat.skippedLines, 1);
  assert.deepEqual(
    chat.messages.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  );
  assert.deepEqual(
    chat.messages[2].parts.map((p) => p.output),
    ['one', 'two'],
  ); // call order, not output order
});

// ---------------------------------------------------------------------------------------------------- ChatGPT

const gptMsg = (id, role, parts, over = {}) => ({
  id,
  parent: over.parent ?? null,
  children: over.children ?? [],
  message:
    role === null
      ? null
      : {
          id,
          author: { role },
          create_time: over.t ?? 1767603600,
          recipient: over.recipient ?? 'all',
          content: over.content ?? { content_type: 'text', parts },
          metadata: over.metadata ?? {},
        },
});

function branchingConversation(extra = {}) {
  // root -> sys -> u1 -> (a1 old answer | a2 regenerated) ; a2 -> u2 -> a3.   Shown branch: a3.
  const mapping = {
    root: gptMsg('root', null, [], { children: ['sys'] }),
    sys: gptMsg('sys', 'system', [''], {
      parent: 'root',
      children: ['u1'],
      metadata: { is_visually_hidden_from_conversation: true },
    }),
    u1: gptMsg('u1', 'user', ['Hello there'], { parent: 'sys', children: ['a1', 'a2'], t: 1767603601 }),
    a1: gptMsg('a1', 'assistant', ['OLD ANSWER'], { parent: 'u1', t: 1767603602 }),
    a2: gptMsg('a2', 'assistant', ['New answer citeturn0search0 here'], {
      parent: 'u1',
      children: ['u2'],
      t: 1767603603,
      metadata: { model_slug: 'gpt-x' },
    }),
    u2: gptMsg('u2', 'user', ['Thanks'], { parent: 'a2', children: ['a3'], t: 1767603604 }),
    a3: gptMsg('a3', 'assistant', ['You are welcome'], { parent: 'u2', t: 1767603605 }),
  };
  return {
    id: 'conv-1',
    title: 'Greeting',
    create_time: 1767603600.5,
    update_time: 1767603700,
    mapping,
    current_node: 'a3',
    ...extra,
  };
}

test('chatgpt: follows current_node through the mapping tree and ignores other branches', () => {
  const chat = parseChatGptConversation(branchingConversation());
  assert.equal(chat.source, 'chatgpt');
  assert.equal(chat.sourceId, 'conv-1');
  assert.equal(chat.title, 'Greeting');
  assert.equal(chat.project, null);
  assert.equal(chat.createdAt, 1767603600500);
  assert.equal(chat.updatedAt, 1767603700000);
  assert.deepEqual(
    chat.messages.map((m) => [m.role, m.parts[0].text]),
    [
      ['user', 'Hello there'],
      ['assistant', 'New answer  here'],
      ['user', 'Thanks'],
      ['assistant', 'You are welcome'],
    ],
  );
  assert.equal(chat.messages[1].meta.model, 'gpt-x');
  assert.equal(chat.messages[0].createdAt, 1767603601000);
  assert.ok(!JSON.stringify(chat).includes('OLD ANSWER'));
});

test('chatgpt: without current_node the last child of every fork is followed', () => {
  const chat = parseChatGptConversation(branchingConversation({ current_node: undefined }));
  assert.deepEqual(
    chat.messages.map((m) => m.parts[0].text),
    ['Hello there', 'New answer  here', 'Thanks', 'You are welcome'],
  );
  const unknown = parseChatGptConversation(branchingConversation({ current_node: 'does-not-exist' }));
  assert.equal(unknown.messages.length, 4);
});

test('chatgpt: tree walk survives cycles, dangling parents and prototype keys', () => {
  const loop = { a: { parent: 'b', children: ['b'] }, b: { parent: 'a', children: ['a'] } };
  assert.deepEqual(threadPath(loop, 'a').sort(), ['a', 'b']);
  assert.deepEqual(threadPath({ x: { parent: 'ghost' } }, 'x'), ['x']);
  assert.deepEqual(threadPath({ x: { parent: null } }, 'constructor'), ['x']);
  assert.deepEqual(threadPath({}, undefined), []);
  const chat = parseChatGptConversation({
    id: 'c',
    title: 'Loop',
    mapping: {
      a: gptMsg('a', 'user', ['q'], { parent: 'b', children: ['b'] }),
      b: gptMsg('b', 'assistant', ['r'], { parent: 'a', children: ['a'] }),
    },
    current_node: 'b',
  });
  assert.equal(chat.messages.length, 2);
});

test('chatgpt: code to a tool and its output become tool_call and tool_result; hidden and system content is dropped', () => {
  const mapping = {
    u: gptMsg('u', 'user', ['plot it'], { children: ['c'] }),
    c: gptMsg('c', 'assistant', null, {
      parent: 'u',
      children: ['o'],
      recipient: 'python',
      content: { content_type: 'code', language: 'python', text: `print("${FAKE_KEY}")` },
    }),
    o: gptMsg('o', 'tool', null, {
      parent: 'c',
      children: ['th'],
      content: { content_type: 'execution_output', text: 'done' },
    }),
    th: gptMsg('th', 'assistant', null, {
      parent: 'o',
      children: ['r'],
      content: { content_type: 'thoughts', thoughts: [] },
    }),
    r: gptMsg('r', 'assistant', null, {
      parent: 'th',
      children: ['i'],
      content: {
        content_type: 'multimodal_text',
        parts: ['Here it is', { content_type: 'image_asset_pointer', asset_pointer: 'file-service://x' }],
      },
    }),
    i: gptMsg('i', 'user', ['hidden'], { parent: 'r', metadata: { is_visually_hidden_from_conversation: true } }),
  };
  const chat = parseChatGptConversation({ id: 'c2', mapping, current_node: 'i' });
  assert.deepEqual(
    chat.messages.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  assert.deepEqual(
    chat.messages[1].parts.map((p) => [p.type, p.name]),
    [['tool_call', 'python']],
  );
  assert.equal(chat.messages[2].parts[0].output, 'done');
  assert.equal(chat.messages[2].parts[0].id, chat.messages[1].parts[0].id);
  assert.equal(chat.messages[3].parts[0].text, 'Here it is\n[image omitted]');
  assert.equal(chat.title, 'plot it'); // no title in the export: first prompt
  assert.ok(!JSON.stringify(chat).includes(FAKE_KEY));
});

test('chatgpt: accepts a JSON string, rejects malformed or foreign shapes', () => {
  assert.equal(parseChatGptConversation(JSON.stringify(branchingConversation())).messages.length, 4);
  assert.equal(parseChatGptConversation('{broken'), null);
  assert.equal(parseChatGptConversation(null), null);
  assert.equal(parseChatGptConversation([]), null);
  assert.equal(parseChatGptConversation({ id: 'x', mapping: 'no' }), null);
  assert.equal(parseChatGptConversation({ id: 'x', mapping: {} }), null);
  assert.equal(parseChatGptConversation({ mapping: { a: gptMsg('a', 'user', ['q']) } }), null);
  assert.equal(
    parseChatGptConversation({ conversation_id: 'alt', mapping: { a: gptMsg('a', 'user', ['q']) }, current_node: 'a' })
      .sourceId,
    'alt',
  );
});

// ---------------------------------------------------------------------------------------------------- shared

test('common: eachLine skips blank and oversized lines, strips a BOM', () => {
  const seen = [];
  let skipped = 0;
  eachLine(
    '﻿one\n\n  two  \r\n' + 'x'.repeat(50) + '\nthree',
    (l) => seen.push(l),
    () => skipped++,
    20,
  );
  assert.deepEqual(seen, ['one', 'two', 'three']);
  assert.equal(skipped, 1);
});

test('common: timestamps', () => {
  assert.equal(toMs('2026-01-05T09:00:00.000Z'), 1767603600000);
  assert.equal(toMs(1767603600.5, 'seconds'), 1767603600500);
  assert.equal(toMs('garbage'), undefined);
  assert.equal(toMs(0), undefined);
  assert.equal(toMs(-5, 'seconds'), undefined);
  assert.equal(toMs(NaN), undefined);
});

test('common: pairTools keeps order and fills missing results', () => {
  const call = (id) => ({ type: 'tool_call', id, name: 'n', args: {} });
  const res = (id) => ({ type: 'tool_result', id, name: 'n', output: id });
  const out = pairTools([
    { role: 'assistant', parts: [call('1'), call('2')], createdAt: 1 },
    { role: 'tool', parts: [res('2')], createdAt: 2 },
    { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
  ]);
  assert.deepEqual(
    out.map((m) => m.role),
    ['assistant', 'tool', 'user'],
  );
  assert.deepEqual(
    out[1].parts.map((p) => [p.id, p.output]),
    [
      ['1', NO_RESULT],
      ['2', '2'],
    ],
  );
  assert.equal(out[1].createdAt, 2);
});

// ---------------------------------------------------------------------------------------------------- storing

function fakeStore(existing = [], opts = {}) {
  const log = { projects: [], chats: [], messages: [], finished: [], discarded: [] };
  const taken = new Set(existing.map((c) => c.source_id).filter(Boolean));
  let nextId = 1;
  return {
    log,
    async existing() {
      return existing;
    },
    async project(name, path) {
      log.projects.push([name, path]);
      return 7;
    },
    async createChat(projectId, title, sourceId, createdAt) {
      if (taken.has(sourceId)) return null;
      taken.add(sourceId);
      const id = nextId++;
      log.chats.push({ id, projectId, title, sourceId, createdAt });
      return id;
    },
    async addMessage(chatId, msg, createdAt) {
      if (opts.failOn && log.messages.length === opts.failOn) throw new Error('disk full');
      log.messages.push({ chatId, role: msg.role, createdAt });
    },
    async finish(chatId, times) {
      log.finished.push({ chatId, ...times });
    },
    async discard(chatId) {
      log.discarded.push(chatId);
    },
  };
}

const chatsOf = () => [
  parseClaudeSession(claudeSession()),
  parseCodexSession(codexSession()),
  parseChatGptConversation(branchingConversation()),
];
const itemsOf = (chats) => chats.map((c) => ({ source: c.source, sourceId: c.sourceId }));

test('run: imports with preserved timestamps, project matching and namespaced source ids', async () => {
  const chats = chatsOf();
  const store = fakeStore();
  const progress = [];
  const r = await importChats(
    itemsOf(chats),
    async (i) => chats[i],
    store,
    (d, n) => progress.push([d, n]),
  );
  assert.deepEqual(r, { imported: 3, skipped: 0, messages: 4 + 4 + 4, failed: 0 });
  assert.deepEqual(
    store.log.chats.map((c) => c.sourceId),
    ['claude-code:s-1', 'codex:cx-1', 'chatgpt:conv-1'],
  );
  assert.deepEqual(
    store.log.chats.map((c) => c.projectId),
    [7, 7, null],
  );
  assert.deepEqual(store.log.projects, [
    ['demo', '/work/demo'],
    ['api', '/work/api'],
  ]); // names and paths are only passed for matching
  assert.equal(store.log.chats[0].createdAt, Date.parse(T(0)));
  assert.equal(store.log.messages[0].createdAt, Date.parse(T(0)));
  assert.deepEqual(store.log.finished[2], { chatId: 3, createdAt: 1767603600500, updatedAt: 1767603700000 });
  assert.deepEqual(progress[0], [0, 3]);
  assert.deepEqual(progress.at(-1), [3, 3]);
});

test('run: duplicates by source id or by title and creation time are skipped', async () => {
  const chats = chatsOf();
  const store = fakeStore([
    { title: 'x', created_at: 1, source_id: 'claude-code:s-1' },
    { title: 'Greeting', created_at: 1767603600500, source_id: null }, // same title + time, imported through a JSON file
  ]);
  let loads = 0;
  const r = await importChats(itemsOf(chats), async (i) => (loads++, chats[i]), store);
  assert.deepEqual(r, { imported: 1, skipped: 2, messages: 4, failed: 0 });
  assert.equal(loads, 2); // the known session id is not even read again
  assert.deepEqual(
    store.log.chats.map((c) => c.sourceId),
    ['codex:cx-1'],
  );
  // importing the same selection twice in one run is also harmless
  const again = fakeStore();
  const r2 = await importChats(itemsOf([chats[0], chats[0]]), async () => chats[0], again);
  assert.deepEqual([r2.imported, r2.skipped], [1, 1]);
});

test('run: unreadable chats count as failed and do not stop the rest; a failed insert is rolled back', async () => {
  const chats = chatsOf();
  const store = fakeStore();
  const r = await importChats(
    itemsOf(chats),
    async (i) => {
      if (i === 0) throw new Error('unreadable');
      return i === 1 ? null : chats[i];
    },
    store,
  );
  assert.deepEqual([r.imported, r.failed], [1, 2]);

  const broken = fakeStore([], { failOn: 2 });
  await assert.rejects(
    importChats(itemsOf(chats), async (i) => chats[i], broken),
    /disk full/,
  );
  assert.deepEqual(broken.log.discarded, [1]);
  assert.equal(broken.log.finished.length, 0);
});

test('run: duplicateKeys and storedSourceId', () => {
  assert.equal(storedSourceId('codex', 'a'), 'codex:a');
  const k = duplicateKeys([{ title: 't', created_at: 5, source_id: 'chatgpt:z' }]);
  assert.ok(k.ids.has('chatgpt:z') && k.times.has('5\u0000t'));
});

test('list: search matches title, folder and id; select-all skips imported', () => {
  const list = [
    { id: 'a1', title: 'Fix login bug', projectPath: '/Users/me/web-app' },
    { id: 'b2', title: 'Refactor', projectPath: '/Users/me/api' },
    { id: 'c3', title: '', projectPath: null },
  ];
  assert.equal(filterSessions(list, '').length, 3);
  assert.deepEqual(
    filterSessions(list, 'LOGIN').map((s) => s.id),
    ['a1'],
  );
  assert.deepEqual(
    filterSessions(list, 'me api').map((s) => s.id),
    ['b2'],
  );
  assert.deepEqual(
    filterSessions(list, 'c3').map((s) => s.id),
    ['c3'],
  );
  assert.deepEqual(filterSessions(list, 'nothing at all'), []);
  assert.deepEqual(
    selectable(list, new Set(['a1'])).map((s) => s.id),
    ['b2', 'c3'],
  );
});
