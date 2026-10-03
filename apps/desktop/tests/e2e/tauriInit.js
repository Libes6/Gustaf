// Runs in the page before any app code (Playwright addInitScript): a fake Tauri runtime whose `invoke` forwards to the
// Node-side FakeBackend through the `__e2e_invoke` binding. The @tauri-apps/api modules only need these globals.
(() => {
  const callbacks = new Map();
  let next = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    callbacks,
    transformCallback(cb, once) {
      const id = next++;
      callbacks.set(id, (data) => { if (once) callbacks.delete(id); return cb && cb(data); });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    runCallback(id, data) { callbacks.get(id)?.(data); },
    convertFileSrc: (p) => p,
    invoke: (cmd, args) => window.__e2e_invoke(cmd, args === undefined ? null : args),
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
})();
