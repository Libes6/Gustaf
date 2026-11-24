import { assert, describe, it } from "vite-plus/test";

import { appendChatDelta, modelsFromTags, ollamaBaseUrl, readGenerateResponse } from "./http.ts";

describe("ollama http", () => {
  it("keeps a bare host and drops a trailing slash", () => {
    assert.strictEqual(ollamaBaseUrl(undefined), "http://127.0.0.1:11434");
    assert.strictEqual(ollamaBaseUrl(" http://localhost:11434/ "), "http://localhost:11434");
  });

  it("reads model names from /api/tags", () => {
    assert.deepEqual(
      modelsFromTags({ models: [{ name: "llama3.2:latest" }, { name: " " }, { model: "skip" }] }),
      ["llama3.2:latest"],
    );
    assert.deepEqual(modelsFromTags({}), []);
  });

  it("appends streamed chat chunks until done", () => {
    const first = appendChatDelta(
      "",
      '{"message":{"role":"assistant","content":"Hi"},"done":false}',
    );
    const second = appendChatDelta(first.text, '{"message":{"content":" there"},"done":true}');
    assert.strictEqual(second.text, "Hi there");
    assert.strictEqual(second.done, true);
    assert.deepEqual(appendChatDelta("Hi", " "), { text: "Hi", done: false });
  });

  it("reads a non-streaming generate body", () => {
    assert.strictEqual(readGenerateResponse({ response: "  Title  " }), "Title");
    assert.strictEqual(readGenerateResponse(null), "");
  });
});
