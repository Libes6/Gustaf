import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { appendChatDelta, modelsFromTags, ollamaBaseUrl, readGenerateResponse } from "./http.ts";

NodeTest.describe("ollama http", () => {
  NodeTest.it("keeps a bare host and drops a trailing slash", () => {
    NodeAssert.equal(ollamaBaseUrl(undefined), "http://127.0.0.1:11434");
    NodeAssert.equal(ollamaBaseUrl(" http://localhost:11434/ "), "http://localhost:11434");
  });

  NodeTest.it("reads model names from /api/tags", () => {
    NodeAssert.deepEqual(
      modelsFromTags({ models: [{ name: "llama3.2:latest" }, { name: " " }, { model: "skip" }] }),
      ["llama3.2:latest"],
    );
    NodeAssert.deepEqual(modelsFromTags({}), []);
  });

  NodeTest.it("appends streamed chat chunks until done", () => {
    const first = appendChatDelta(
      "",
      '{"message":{"role":"assistant","content":"Hi"},"done":false}',
    );
    const second = appendChatDelta(first.text, '{"message":{"content":" there"},"done":true}');
    NodeAssert.equal(second.text, "Hi there");
    NodeAssert.equal(second.done, true);
    NodeAssert.deepEqual(appendChatDelta("Hi", " "), { text: "Hi", done: false });
  });

  NodeTest.it("reads a non-streaming generate body", () => {
    NodeAssert.equal(readGenerateResponse({ response: "  Title  " }), "Title");
    NodeAssert.equal(readGenerateResponse(null), "");
  });
});
