import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";
import * as NodeVM from "node:vm";

const source = NodeFS.readFileSync(new URL("../src-tauri/src/bridge.rs", import.meta.url), "utf8");
const script = source
  .split('const INIT_SCRIPT: &str = r#"')[1]
  .split('"#;')[0]
  .replaceAll("__GUSTAF_VERSION__", '"test"')
  .replaceAll("__GUSTAF_BOOTSTRAPS__", "[]")
  .replaceAll("__GUSTAF_PLATFORM__", '"darwin"');

function load(invoke, stored = new Map(), hostname = "127.0.0.1") {
  const events = new Map();
  const window = {
    __TAURI_INTERNALS__: {
      invoke: async (name, args) => {
        if (name === "window_fullscreen_state") return false;
        return invoke(name, args);
      },
    },
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key),
    },
    addEventListener: (name, listener) => events.set(name, listener),
    location: { hostname },
  };
  window.top = window;
  NodeVM.runInNewContext(script, {
    window,
    document: { addEventListener: (name, listener) => events.set(name, listener) },
    navigator: { language: "ru", languages: ["ru"] },
    EventTarget,
    Event,
    console,
  });
  return { window, bridge: window.desktopBridge };
}

NodeTest.test(
  "fullscreen is a boolean and subscribers receive changes until unsubscribed",
  async () => {
    const { window, bridge } = load(() => null);
    await Promise.resolve();
    NodeAssert.equal(bridge.getWindowFullscreenState(), false);
    const changes = [];
    const unsubscribe = bridge.onWindowFullscreenStateChange((value) => changes.push(value));
    window.__gustafFullscreenState(true);
    window.__gustafFullscreenState(true);
    NodeAssert.equal(bridge.getWindowFullscreenState(), true);
    unsubscribe();
    window.__gustafFullscreenState(false);
    NodeAssert.deepEqual(changes, [true]);
  },
);

NodeTest.test("migrates browser preferences only after native storage accepts them", async () => {
  const stored = new Map([["gustaf.clientSettings", '{"chatWidth":"wide"}']]);
  let saved;
  const { bridge } = load((name, args) => {
    if (name === "read_client_settings") return null;
    if (name === "write_client_settings") saved = args.settings;
  }, stored);
  NodeAssert.equal((await bridge.getClientSettings()).chatWidth, "wide");
  NodeAssert.equal(saved.chatWidth, "wide");
  NodeAssert.equal(stored.has("gustaf.clientSettings"), false);
});

NodeTest.test("a failed migration keeps the original preferences for retry", async () => {
  const stored = new Map([["gustaf.clientSettings", "{}"]]);
  const { bridge } = load((name) => {
    if (name === "read_client_settings") return null;
    throw new Error("disk full");
  }, stored);
  await NodeAssert.rejects(bridge.getClientSettings(), /disk full/);
  NodeAssert.equal(stored.get("gustaf.clientSettings"), "{}");
});

NodeTest.test("native preferences take priority over old origin storage", async () => {
  const { bridge } = load(
    (name) => {
      NodeAssert.equal(name, "read_client_settings");
      return { chatWidth: "comfortable" };
    },
    new Map([["gustaf.clientSettings", "{invalid"]]),
  );
  NodeAssert.equal((await bridge.getClientSettings()).chatWidth, "comfortable");
});

NodeTest.test("window actions use native commands and propagate failures", async () => {
  const calls = [];
  const { bridge } = load((name, args) => {
    calls.push([name, args]);
    if (name === "set_window_theme") throw new Error("window closed");
  });
  await bridge.revealWindow();
  NodeAssert.equal(calls[0][0], "reveal_window");
  await NodeAssert.rejects(bridge.setTheme("dark"), /window closed/);
  NodeAssert.equal(calls[1][1].theme, "dark");
});

NodeTest.test(
  "catalog migration removes plaintext only after secure persistence succeeds",
  async () => {
    const stored = new Map([["gustaf.connectionCatalog", "legacy-token"]]);
    let secure = null;
    let fail = true;
    const { bridge } = load((name, args) => {
      if (name === "read_connection_catalog") return secure;
      if (name === "write_connection_catalog") {
        if (fail) throw new Error("keyring locked");
        secure = args.catalog;
      }
    }, stored);
    await NodeAssert.rejects(bridge.getConnectionCatalog(), /keyring locked/);
    NodeAssert.equal(stored.get("gustaf.connectionCatalog"), "legacy-token");
    fail = false;
    NodeAssert.equal(await bridge.getConnectionCatalog(), "legacy-token");
    NodeAssert.equal(secure, "legacy-token");
    NodeAssert.equal(stored.has("gustaf.connectionCatalog"), false);
  },
);

NodeTest.test("secure catalog takes priority and removes a leftover plaintext copy", async () => {
  const stored = new Map([["gustaf.connectionCatalog", "obsolete-token"]]);
  const { bridge } = load((name) => {
    NodeAssert.equal(name, "read_connection_catalog");
    return "saved-token";
  }, stored);
  NodeAssert.equal(await bridge.getConnectionCatalog(), "saved-token");
  NodeAssert.equal(stored.has("gustaf.connectionCatalog"), false);
});

NodeTest.test(
  "a failed secure read never falls back to plaintext or overwrites the catalog",
  async () => {
    const stored = new Map([["gustaf.connectionCatalog", "obsolete-token"]]);
    const { bridge } = load((name) => {
      NodeAssert.equal(name, "read_connection_catalog");
      throw new Error("key missing");
    }, stored);
    await NodeAssert.rejects(bridge.getConnectionCatalog(), /key missing/);
    NodeAssert.equal(stored.get("gustaf.connectionCatalog"), "obsolete-token");
  },
);

NodeTest.test("a save queued during migration wins over the older catalog", async () => {
  const stored = new Map([["gustaf.connectionCatalog", "legacy-token"]]);
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  let secure = null;
  const { bridge } = load(async (name, args) => {
    if (name === "read_connection_catalog") {
      await ready;
      return secure;
    }
    if (name === "write_connection_catalog") secure = args.catalog;
  }, stored);
  const migrating = bridge.getConnectionCatalog();
  const saving = bridge.setConnectionCatalog("new-token");
  release();
  NodeAssert.equal(await migrating, "legacy-token");
  NodeAssert.equal(await saving, true);
  NodeAssert.equal(secure, "new-token");
  NodeAssert.equal(stored.has("gustaf.connectionCatalog"), false);
});

NodeTest.test("a page that is not the local server gets no bridge and no token", () => {
  for (const hostname of ["example.com", "127.0.0.1.example.com", "192.168.1.20", ""]) {
    const { window } = load(() => null, new Map(), hostname);
    NodeAssert.equal(window.desktopBridge, undefined, hostname);
    NodeAssert.equal(window.gustafShell, undefined, hostname);
  }
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    NodeAssert.notEqual(load(() => null, new Map(), hostname).bridge, undefined, hostname);
  }
});

// The page subscribes to these while it starts and does not check that they exist.
// 0.8.x builds with a bridge missing one of them would open a blank window.
NodeTest.test("every listener of the desktop bridge can be subscribed to", () => {
  const contract = NodeFS.readFileSync(
    new URL("../../../packages/contracts/src/ipc.ts", import.meta.url),
    "utf8",
  );
  const body = contract.split("export interface DesktopBridge {")[1].split("\n}\n")[0];
  const listeners = [...body.matchAll(/^ {2}(on[A-Z]\w*):/gm)].map((match) => match[1]);
  NodeAssert.ok(listeners.includes("onSshPasswordPrompt"));
  const { bridge } = load(() => null);
  // SnapShots are detected by their absence (apps/web/src/lib/desktopSnapShot.ts).
  for (const name of listeners.filter((name) => name !== "onSnapShotEvent")) {
    NodeAssert.equal(typeof bridge[name], "function", name);
    NodeAssert.equal(typeof bridge[name](() => {}), "function", `${name} returns an unsubscribe`);
  }
  // The page chains `.catch` on these.
  NodeAssert.equal(typeof bridge.webLinks.setReady(true)?.catch, "function");
  NodeAssert.equal(typeof bridge.appActivation.setReady(true)?.catch, "function");
});

// Settings shows these controls only when the call exists, and falls back to the
// page's own file input for themes. A stub that does nothing breaks both.
NodeTest.test("calls the shell cannot honour are absent, not stubbed", () => {
  const { bridge } = load(() => null);
  NodeAssert.equal(bridge.pickThemeFiles, undefined);
  NodeAssert.equal(bridge.setLocalEnvironmentEnabled, undefined);
});

NodeTest.test(
  "SSH preparation, session bootstrap and password cancellation use the native owner",
  async () => {
    const calls = [];
    const { bridge, window } = load((name, args) => {
      calls.push([name, args]);
      if (args.method === "ensure")
        return { type: "ssh-password-prompt-cancelled", message: "cancelled" };
      return { ok: true };
    });
    const received = [];
    const unsubscribe = bridge.onSshPasswordPrompt((request) => received.push(request));
    window.__gustafSshPasswordPrompt({ requestId: "one" });
    unsubscribe();
    window.__gustafSshPasswordPrompt({ requestId: "two" });
    NodeAssert.equal(received.length, 1);
    await bridge.discoverSshHosts();
    await bridge.resolveSshHost("alias");
    await NodeAssert.rejects(bridge.ensureSshEnvironment({ alias: "alias" }), /cancelled/);
    await bridge.resolveSshPasswordPrompt("one", null);
    await bridge.fetchSshEnvironmentDescriptor("http://127.0.0.1:2345/");
    await bridge.bootstrapSshBearerSession("http://127.0.0.1:2345/", "credential");
    await bridge.fetchSshSessionState("http://127.0.0.1:2345/", "bearer");
    await bridge.disconnectSshEnvironment({ alias: "alias" });
    NodeAssert.deepEqual(
      calls.map(([, args]) => args.method),
      [
        "discover",
        "resolve",
        "ensure",
        "resolve-password",
        "descriptor",
        "bootstrap",
        "session",
        "disconnect",
      ],
    );
    NodeAssert.ok(calls.every(([name, args]) => name === "ssh_request" && args.locale === "ru"));
  },
);
