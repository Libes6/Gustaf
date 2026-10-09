// A synthetic ACP agent for tests: speaks the message shapes of the public Agent Client Protocol spec
// (agentclientprotocol.com) as T3 Code's registry fixtures and the Antigravity adapter use them. SYNTHETIC: nothing here was
// recorded from Google's proprietary `agy_acp_server`. The agent is a `Duplex` (providers/acp/rpc.ts) whose "process"
// answers requests through a script; tests drive extra traffic with `emit`, `request` (agent -> client) and `exit`.
export const MODEL_OPTION = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'agy-fast',
  options: [
    { value: 'agy-fast', name: 'Fast' },
    { value: 'agy-pro', name: 'Pro' },
  ],
};
export const THOUGHT_OPTION = {
  id: 'thought',
  name: 'Thinking',
  category: 'thought_level',
  type: 'select',
  currentValue: 'low',
  options: [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
  ],
};

export function fakeAgent(script = {}) {
  let listener;
  const queued = [];
  let close;
  const closed = new Promise((r) => (close = r));
  let nextAgentId = 1;
  const waiting = new Map();
  const a = {
    /** Every message the client wrote, parsed. */
    written: [],
    gone: false,
    stops: 0,
    err: '',
    sessionCounter: 0,
    pendingPrompt: undefined,
    closed,
    methods: () => a.written.filter((m) => m.method).map((m) => m.method),
    calls: (method) => a.written.filter((m) => m.method === method),
    exited: () => a.gone,
    stderr: () => a.err,
    onMessage(cb) {
      listener = cb;
      for (const m of queued.splice(0)) cb(m);
    },
    /** Delivers an agent -> client message (asynchronously, like a pipe). */
    emit(m) {
      const msg = typeof m === 'string' ? m : m;
      queueMicrotask(() => (listener ? listener(msg) : queued.push(msg)));
    },
    update(sessionId, update) {
      a.emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
    },
    text(sessionId, text) {
      a.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    },
    /** An agent -> client request; resolves with the client's response. */
    request(method, params) {
      const id = `a${nextAgentId++}`;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        a.emit({ jsonrpc: '2.0', id, method, params });
      });
    },
    exit(code = 0) {
      if (a.gone) return;
      a.gone = true;
      close(code);
    },
    async stop() {
      a.stops++;
      a.exit(null);
    },
    async write(line) {
      const m = JSON.parse(line);
      a.written.push(m);
      if (m.method === undefined && m.id !== undefined) {
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
        return;
      }
      const reply = (result) => a.emit({ jsonrpc: '2.0', id: m.id, result });
      const fail = (code, message) => a.emit({ jsonrpc: '2.0', id: m.id, error: { code, message } });
      if (m.id === undefined) {
        script.onNotification?.(m, a);
        if (m.method === 'session/cancel') {
          a.cancelled = true;
          a.pendingPrompt?.(m.params.sessionId);
        }
        return;
      }
      const custom = script.onRequest?.(m, { reply, fail, agent: a });
      if (custom === 'silent' || custom === 'handled') return;
      switch (m.method) {
        case 'initialize':
          return reply(
            script.initialize ?? {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: false,
                promptCapabilities: { image: true },
                sessionCapabilities: { resume: {} },
              },
              authMethods: [{ id: 'oauth-personal', name: 'Google account' }],
              agentInfo: { name: 'fake-agy', title: 'Fake Antigravity', version: '1.3.0' },
            },
          );
        case 'authenticate':
          return reply({});
        case 'session/new':
          a.sessionCounter++;
          return reply({
            sessionId: `s${a.sessionCounter}`,
            configOptions: script.configOptions ?? [MODEL_OPTION, THOUGHT_OPTION],
          });
        case 'session/resume':
        case 'session/load':
          return reply({ configOptions: script.configOptions ?? [MODEL_OPTION, THOUGHT_OPTION] });
        case 'session/set_config_option':
          return reply({ configOptions: [] });
        case 'session/prompt': {
          if (script.onPrompt) {
            const r = script.onPrompt(m.params, a);
            // A prompt that waits for a cancel returns a promise that `session/cancel` resolves.
            Promise.resolve(r).then((res) => (res === undefined ? undefined : reply(res)));
            return;
          }
          a.text(m.params.sessionId, 'ok');
          return reply({ stopReason: 'end_turn' });
        }
        default:
          return fail(-32601, `unknown method ${m.method}`);
      }
    },
  };
  return a;
}

/** A prompt that streams `chunks`, then waits until the client cancels it. */
export function hangingPrompt(chunks = []) {
  return (params, agent) =>
    new Promise((resolve) => {
      for (const c of chunks) agent.text(params.sessionId, c);
      agent.pendingPrompt = () => resolve({ stopReason: 'cancelled' });
    });
}
