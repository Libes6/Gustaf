import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInline, parseMarkdown } from "./markdown.ts";

test("inline marks: bold, italic, code and links; unmatched markers stay literal", () => {
  assert.deepEqual(parseInline("a **b** `c` _d_ [e](https://x.y)"), [
    { type: "text", text: "a " },
    { type: "bold", children: [{ type: "text", text: "b" }] },
    { type: "text", text: " " },
    { type: "code", text: "c" },
    { type: "text", text: " " },
    { type: "italic", children: [{ type: "text", text: "d" }] },
    { type: "text", text: " " },
    { type: "link", text: "e", url: "https://x.y" },
  ]);
  assert.deepEqual(parseInline("half **bold and `code"), [{ type: "text", text: "half **bold and `code" }]);
  assert.deepEqual(parseInline("snake_case_name and 2*3*4"), [{ type: "text", text: "snake_case_name and 2" }, { type: "italic", children: [{ type: "text", text: "3" }] }, { type: "text", text: "4" }]);
  assert.deepEqual(parseInline("[x](javascript:alert(1))"), [{ type: "text", text: "[x](javascript:alert(1))" }], "only http(s) links");
});

test("blocks: headings, paragraphs, lists, quotes and fenced code", () => {
  const md = "# Title\n\nSome *text*\nsecond line\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n> more\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\nafter";
  const blocks = parseMarkdown(md);
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph", "list", "list", "quote", "code", "paragraph"]);
  assert.equal((blocks[0] as { level: number }).level, 1);
  const bullets = blocks[2] as { ordered: boolean; items: unknown[] };
  assert.equal(bullets.ordered, false);
  assert.equal(bullets.items.length, 2);
  assert.equal((blocks[3] as { ordered: boolean }).ordered, true);
  const code = blocks[5] as { lang: string; text: string };
  assert.equal(code.lang, "ts");
  assert.equal(code.text, "const a = 1;\n\nconst b = 2;");
});

test("a fence that is still streaming takes the rest of the text; deep headings clamp to 3", () => {
  const blocks = parseMarkdown("intro\n```\nlet x");
  assert.deepEqual(blocks.map((b) => b.type), ["paragraph", "code"]);
  assert.equal((blocks[1] as { text: string }).text, "let x");
  assert.equal((parseMarkdown("###### deep")[0] as { level: number }).level, 3);
  assert.deepEqual(parseMarkdown(""), []);
});
