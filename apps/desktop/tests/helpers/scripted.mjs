// A scripted model for tests of the real agent loop: each entry of `script` is the reply of one model turn
// ({ parts, usage }) or a function (turn input) => reply that may call input.onText / input.onActivity or throw.
// `seen.turns` records what the model was given (access, offered tools, system prompt, messages).
let n = 0;
export const call = (name, args) => ({ type: 'tool_call', id: `c${n++}`, name, args });
export const usage = { input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 0 };
export const say = (text) => ({ parts: [{ type: 'text', text }], usage });
export const use = (...calls) => ({ parts: calls, usage });

export function scriptedAdapter(script, seen = { turns: [] }) {
  let i = 0;
  const adapter = {
    supportsComputer: true,
    supportsReasoning: () => false,
    listModels: async () => [],
    turn: async (input) => {
      seen.turns.push({
        access: input.access,
        tools: input.tools.map((t) => t.name),
        system: input.system,
        messages: [...input.messages],
      });
      const next = script[i++] ?? say('done');
      return typeof next === 'function' ? next(input) : next;
    },
  };
  return { adapter, seen };
}
