// Cursor SDK bridge: reads one JSON request from stdin, writes JSON lines to stdout, then exits.
import { Agent, Cursor } from "@cursor/sdk";
import readline from "node:readline";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const line = await new Promise((resolve) => readline.createInterface({ input: process.stdin }).once("line", resolve));
const req = JSON.parse(line);

try {
  if (req.type === "models") {
    const list = await Cursor.models.list({ apiKey: req.apiKey });
    out({ type: "models", list: list.map((m) => ({ id: m.id, name: m.displayName })) });
  } else {
    // settingSources "all": reuse the user's Cursor MCP servers and rules, same as in the IDE.
    const opts = { apiKey: req.apiKey, model: { id: req.model }, local: { cwd: req.cwd, settingSources: ["all"] } };
    await using agent = req.agentId ? await Agent.resume(req.agentId, opts) : await Agent.create(opts);
    out({ type: "agent", agentId: agent.agentId });
    const run = await agent.send(req.prompt);
    process.on("SIGTERM", () => run.supports("cancel") && run.cancel());
    for await (const ev of run.stream()) {
      if (ev.type === "assistant") {
        for (const b of ev.message.content) if (b.type === "text") out({ type: "text", text: b.text });
      } else if (ev.type === "tool_call") {
        out({ type: "tool", id: ev.id, name: ev.name, status: ev.status, args: ev.args, output: typeof ev.result === "string" ? ev.result : ev.result == null ? undefined : JSON.stringify(ev.result) });
      }
    }
    const result = await run.wait();
    out({ type: "done", status: result.status });
  }
} catch (e) {
  out({ type: "error", message: String(e?.message ?? e) });
}
process.exit(0);
