import test from "node:test";
import assert from "node:assert/strict";
import { collectErrors, formatMemory, formatUptime, isHeavy, processName, scrubText, totals } from "../src/lib/appDiagnostics.ts";

test("scrubText hides keys in flags, assignments and tokens, and bounds the length", () => {
  const out = scrubText("node app.js --api-key abcdef123456 --token=hunter2hunter2 sk-ant-abcdefghijklmnopqrstuvwxyz0123 PASSWORD=swordfish");
  for (const s of ["abcdef123456", "hunter2", "sk-ant-", "swordfish"]) assert.ok(!out.includes(s), s);
  assert.ok(scrubText("x".repeat(1000)).length <= 301);
});

test("processName shows the script of an interpreter and the program otherwise", () => {
  assert.equal(processName("/usr/local/bin/node /a/b/index.mjs --x"), "node index.mjs");
  assert.equal(processName("/bin/zsh -l"), "zsh");
  assert.equal(processName("claude --print"), "claude");
});

test("formatting and totals", () => {
  assert.equal(formatMemory(512), "512 KB");
  assert.equal(formatMemory(204_800), "200 MB");
  assert.equal(formatMemory(2 * 1024 * 1024), "2.0 GB");
  assert.equal(formatUptime(59), "59s");
  assert.equal(formatUptime(3700), "1h 1m");
  const a = { pid: 1, ppid: 0, cpu: 10, rssKb: 100, elapsedSecs: 1, command: "", isApp: true };
  assert.deepEqual(totals([a, { ...a, cpu: 20.4 }]), { count: 2, rssKb: 200, cpu: 30 });
  assert.equal(isHeavy({ ...a, cpu: 99 }), true);
  assert.equal(isHeavy(a), false);
});

test("collectErrors merges sources, scrubs, skips ok providers and duplicates of a check error", () => {
  const list = collectErrors({
    providers: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    health: { a: { status: "ok", message: "", at: 1 }, b: { status: "error", message: "boom sk-ant-abcdefghijklmnopqrstuvwxyz0123", at: 5 } },
    modelErrors: { b: "boom sk-ant-abcdefghijklmnopqrstuvwxyz0123", a: "list failed" },
    limitErrors: {},
    mcp: [{ id: "m", state: "error", error: "bad" }, { id: "n", state: "running", error: null }],
  });
  assert.deepEqual(list.map((e) => e.id), ["health:b", "models:a", "mcp:m"]);
  assert.ok(!list[0].text.includes("sk-ant"));
});
