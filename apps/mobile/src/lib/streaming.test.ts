import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage, ServerEvent } from "@gustaf/protocol";
import { backoffDelay } from "./backoff.ts";
import { initialChatState, reduceEvent, type ChatState } from "./streaming.ts";

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 1,
  chatId: 7,
  role: "assistant",
  text: "",
  tools: [],
  createdAt: 0,
  ...over,
});
const run = (state: ChatState, events: ServerEvent[]) => events.reduce(reduceEvent, state);

test("deltas are appended to the created assistant message", () => {
  const s = run(initialChatState(7), [
    { type: "message.created", message: msg() },
    { type: "message.delta", chatId: 7, messageId: 1, text: "Hel" },
    { type: "message.delta", chatId: 7, messageId: 1, text: "lo" },
  ]);
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0]!.text, "Hello");
  assert.equal(s.running, true);
  assert.equal(s.streamingMessageId, 1);
});

test("a delta before message.created makes a placeholder and created does not lose the text", () => {
  const s = run(initialChatState(7), [
    { type: "message.delta", chatId: 7, messageId: 1, text: "early" },
    { type: "message.created", message: msg({ text: "" }) },
  ]);
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0]!.text, "early");
});

test("events for other chats are ignored (same state object)", () => {
  const s0 = initialChatState(7);
  assert.equal(reduceEvent(s0, { type: "message.delta", chatId: 8, messageId: 1, text: "x" }), s0);
  assert.equal(reduceEvent(s0, { type: "message.created", message: msg({ chatId: 8 }) }), s0);
  assert.equal(reduceEvent(s0, { type: "run.finished", chatId: 8, outcome: "done" }), s0);
});

test("tool updates upsert by id", () => {
  const s = run(initialChatState(7, [msg()]), [
    { type: "tool.updated", chatId: 7, messageId: 1, tool: { id: "t1", tool: "bash", summary: "ls", status: "running" } },
    { type: "tool.updated", chatId: 7, messageId: 1, tool: { id: "t1", tool: "bash", summary: "ls", status: "done" } },
    { type: "tool.updated", chatId: 7, messageId: 1, tool: { id: "t2", tool: "read", summary: "a.ts", status: "done" } },
  ]);
  assert.deepEqual(s.messages[0]!.tools.map((t) => [t.id, t.status]), [["t1", "done"], ["t2", "done"]]);
});

test("approvals are added once and removed when resolved", () => {
  const approval = { approvalId: "a1", chatId: 7, tool: "bash", summary: "rm -rf x" };
  let s = run(initialChatState(7), [
    { type: "approval.requested", approval },
    { type: "approval.requested", approval },
  ]);
  assert.equal(s.approvals.length, 1);
  s = reduceEvent(s, { type: "approval.resolved", approvalId: "a1", decision: "deny" });
  assert.equal(s.approvals.length, 0);
});

test("run.finished stops streaming, clears approvals and records an error", () => {
  const approval = { approvalId: "a1", chatId: 7, tool: "bash", summary: "x" };
  let s = run(initialChatState(7), [
    { type: "message.created", message: msg() },
    { type: "approval.requested", approval },
    { type: "run.finished", chatId: 7, outcome: "error", error: "boom" },
  ]);
  assert.equal(s.running, false);
  assert.equal(s.streamingMessageId, null);
  assert.equal(s.approvals.length, 0);
  assert.equal(s.error, "boom");
  s = reduceEvent(s, { type: "run.finished", chatId: 7, outcome: "done" });
  assert.equal(s.error, undefined);
});

test("chat.updated mirrors the running flag", () => {
  const chat = { id: 7, projectId: 1, title: "t", archived: false, updatedAt: 0, running: true };
  assert.equal(reduceEvent(initialChatState(7), { type: "chat.updated", chat }).running, true);
});

test("backoff grows, is capped and jittered", () => {
  assert.equal(backoffDelay(0, () => 1), 1000);
  assert.equal(backoffDelay(0, () => 0), 500);
  assert.equal(backoffDelay(3, () => 1), 8000);
  assert.equal(backoffDelay(20, () => 1), 30000);
});
