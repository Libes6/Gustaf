import { invoke } from '@tauri-apps/api/core';
import type { Adapter, Msg, Part } from './types';

export const COMPUTER_PROTOCOL = `M Code provides desktop control independently of the model/provider.
To use it, output exactly one fenced mcode-computer block containing JSON {"actions":[...]} and stop. M Code executes it and returns a fresh screenshot or an error. Never claim an action succeeded before receiving its result. Start with {"type":"screenshot"}. Coordinates use the returned screenshot pixels.
Actions: screenshot; click/double_click/move {x,y}; scroll {x,y,scroll_x,scroll_y}; keypress {keys:["cmd","space"]}; type {text}; wait {ms}; drag {path:[{x,y},...]}. Use small batches. Do not use shell/MCP to bypass M Code desktop permissions. If you cannot inspect the screenshot, say so and do not guess coordinates.`;

export function parseComputerRequest(text: string): Part | undefined {
  const blocks = [...text.matchAll(/```mcode-computer\s*\n([\s\S]*?)```/g)];
  if (!blocks.length) return;
  if (blocks.length !== 1) throw new Error('Use one computer action block per turn.');
  const args = JSON.parse(blocks[0][1]);
  if (!Array.isArray(args.actions) || !args.actions.length || args.actions.length > 10) throw new Error('Computer request requires 1–10 actions.');
  const allowed = new Set(['screenshot','click','double_click','move','scroll','keypress','type','wait','drag']);
  for (const a of args.actions) {
    if (!allowed.has(a.type)) throw new Error('Unknown computer action.');
    if (['click','double_click','move','scroll'].includes(a.type) && (!Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x < 0 || a.y < 0)) throw new Error('Action requires valid screenshot coordinates.');
    if (a.type === 'keypress' && (!Array.isArray(a.keys) || !a.keys.length || a.keys.some((k: unknown) => typeof k !== 'string'))) throw new Error('Keypress requires key names.');
    if (a.type === 'type' && typeof a.text !== 'string') throw new Error('Typing requires text.');
    if (a.type === 'drag' && (!Array.isArray(a.path) || !a.path.length || a.path.some((p: any) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0))) throw new Error('Drag requires valid coordinates.');
    if (a.type === 'wait' && (!Number.isFinite(a.ms) || a.ms < 0 || a.ms > 5000)) throw new Error('Wait must be between 0 and 5000 ms.');
  }
  return { type: 'tool_call', id: crypto.randomUUID(), name: 'mcode_computer', args, computer: { actions: args.actions } };
}

/** Provider-neutral desktop protocol, including agents with no function-call API. */
export function withComputer(adapter: Adapter, cli: boolean): Adapter {
  return { ...adapter, supportsComputer: true, async turn(t) {
    if (!t.computer) return adapter.turn(t);
    const messages: Msg[] = [];
    for (const m of t.messages) {
      const desktop = m.parts.some(p => (p.type === 'tool_call' || p.type === 'tool_result') && p.name === 'mcode_computer');
      if (!desktop) { messages.push(m); continue; }
      const parts: Part[] = [];
      for (const p of m.parts) {
        if (p.type === 'text') parts.push(p);
        if (p.type === 'tool_call') parts.push({ type: 'text', text: `Desktop request: ${JSON.stringify(p.args)}` });
        if (p.type === 'tool_result') {
          parts.push({ type: 'text', text: `Desktop result: ${p.output}` });
          if (p.image) {
            if (cli) {
              const path = await invoke<string>('cu_save_shot', { png: p.image });
              parts.push({ type: 'text', text: `Inspect this screenshot file before acting: ${path}` });
            } else parts.push({ type: 'image', data: p.image });
          }
        }
      }
      messages.push({ role: m.role === 'tool' ? 'user' : 'assistant', parts, meta: m.meta });
    }
    const system = `${t.system}\n${COMPUTER_PROTOCOL}\nScreenshot dimensions: ${t.computer.width} × ${t.computer.height}.`;
    const out = await adapter.turn({ ...t, system, messages, computer: undefined });
    const text = out.parts.filter(p => p.type === 'text').map(p => p.text).join('');
    const call = parseComputerRequest(text);
    return call ? { ...out, parts: [...out.parts, call] } : out;
  } };
}
