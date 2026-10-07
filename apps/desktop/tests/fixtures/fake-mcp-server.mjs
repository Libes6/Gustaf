#!/usr/bin/env node
// Tiny MCP server over stdio (newline-delimited JSON-RPC) used by the Rust tests in src-tauri/src/mcp.rs.
// Tools: echo {text} → text; sleep → never answers (timeouts); crash → exits; change → sends tools/list_changed;
// env {name} → value of an environment variable; big → a response larger than the client's cap; slow {ms} → answers
// after a delay (cancellation tests: the late answer must be dropped); changeall → announces tool, resource and prompt
// list changes. `notifications/cancelled` is noted on stderr as `cancelled <id>`.
// Flags: --exit-after-init (exits right after the handshake), --no-init (never answers initialize).
import { createInterface } from 'node:readline';

const flags = new Set(process.argv.slice(2));
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const tools = [
  {
    name: 'echo',
    description: 'Echo text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  { name: 'sleep', description: 'Never answers', inputSchema: { type: 'object' } },
  { name: 'crash', description: 'Exits the process', inputSchema: { type: 'object' } },
  { name: 'change', description: 'Announces a tool list change', inputSchema: { type: 'object' } },
  {
    name: 'env',
    description: 'Reads an environment variable',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  },
  {
    name: 'slow',
    description: 'Answers after ms',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
  },
  {
    name: 'changeall',
    description: 'Announces tool, resource and prompt list changes',
    inputSchema: { type: 'object' },
  },
  { name: 'big', description: 'Returns a huge response', inputSchema: { type: 'object' } },
];

process.stderr.write(`fake server started pid=${process.pid}\n`);
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(`bad json: ${line.slice(0, 80)}\n`);
    return;
  }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    if (flags.has('--no-init')) return;
    send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fake', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/cancelled') {
    process.stderr.write(`cancelled ${params?.requestId}\n`);
    return;
  }
  if (method === 'notifications/initialized') {
    if (flags.has('--exit-after-init')) process.exit(3);
    return;
  }
  if (method === 'tools/list') return send({ id, result: { tools } });
  if (method === 'tools/call') {
    const args = params?.arguments ?? {};
    switch (params?.name) {
      case 'echo':
        return send({ id, result: { content: [{ type: 'text', text: String(args.text ?? '') }] } });
      case 'sleep':
        return;
      case 'crash':
        process.stderr.write('crashing on purpose\n');
        process.exit(1);
        return;
      case 'change':
        send({ method: 'notifications/tools/list_changed' });
        return send({ id, result: { content: [{ type: 'text', text: 'changed' }] } });
      case 'slow':
        setTimeout(
          () => send({ id, result: { content: [{ type: 'text', text: 'late answer' }] } }),
          Number(args.ms ?? 300),
        );
        return;
      case 'changeall':
        send({ method: 'notifications/tools/list_changed' });
        send({ method: 'notifications/resources/list_changed' });
        send({ method: 'notifications/prompts/list_changed' });
        return send({ id, result: { content: [{ type: 'text', text: 'changed' }] } });
      case 'env':
        return send({ id, result: { content: [{ type: 'text', text: String(process.env[args.name] ?? '') }] } });
      case 'big':
        return send({ id, result: { content: [{ type: 'text', text: 'x'.repeat(17 * 1024 * 1024) }] } });
      default:
        return send({ id, result: { content: [{ type: 'text', text: 'unknown tool' }], isError: true } });
    }
  }
  if (method === 'ping') return send({ id, result: {} });
  if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
});
rl.on('close', () => process.exit(0));
