// Cursor SDK bridge: reads one JSON request from stdin, writes JSON lines to stdout, then exits.
// Stop and follow-up restarts send SIGTERM (src/providers/processHost.ts, SIGKILL after a 2 s grace): the run is
// cancelled, its final `done` line is still written when it comes in time, and the process exits before the grace ends.
import { Agent, Cursor } from '@cursor/sdk';
import readline from 'node:readline';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const EXIT_AFTER_TERM_MS = 1500;
let run;
let terminating = false;
process.on('SIGTERM', () => {
  if (terminating) return;
  terminating = true;
  // Without a run there is nothing to wind down; with one, give cancel() a moment to settle the stream.
  if (!run) process.exit(143);
  if (run.supports('cancel')) run.cancel().catch(() => {});
  setTimeout(() => process.exit(143), EXIT_AFTER_TERM_MS).unref();
});

const line = await new Promise((resolve) => readline.createInterface({ input: process.stdin }).once('line', resolve));
const req = JSON.parse(line);

try {
  if (req.type === 'models') {
    const list = await Cursor.models.list({ apiKey: req.apiKey });
    out({ type: 'models', list: list.map((m) => ({ id: m.id, name: m.displayName, parameters: m.parameters })) });
  } else {
    // settingSources "all": reuse the user's Cursor MCP servers and rules, same as in the IDE.
    const opts = {
      apiKey: req.apiKey,
      model: { id: req.model, ...(req.params?.length ? { params: req.params } : {}) },
      local: { cwd: req.cwd, settingSources: ['all'] },
    };
    await using agent = req.agentId ? await Agent.resume(req.agentId, opts) : await Agent.create(opts);
    out({ type: 'agent', agentId: agent.agentId });
    if (terminating) process.exit(143);
    run = await agent.send(req.prompt);
    if (terminating && run.supports('cancel')) await run.cancel().catch(() => {});
    for await (const ev of run.stream()) {
      if (ev.type === 'assistant') {
        for (const b of ev.message.content) if (b.type === 'text') out({ type: 'text', text: b.text });
      } else if (ev.type === 'tool_call') {
        out({
          type: 'tool',
          // `call_id` is the SDK's id of the call; it stays the same from `running` to `completed` / `error`.
          id: ev.call_id ?? ev.id,
          name: ev.name,
          status: ev.status,
          args: ev.args,
          output: typeof ev.result === 'string' ? ev.result : ev.result == null ? undefined : JSON.stringify(ev.result),
        });
      }
    }
    const result = await run.wait();
    out({ type: 'done', status: result.status, ...(result.error?.message ? { error: result.error.message } : {}) });
  }
} catch (e) {
  out({ type: 'error', message: String(e?.message ?? e) });
}
process.exit(terminating ? 143 : 0);
