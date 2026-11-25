import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpProviderSessions from "./McpProviderSessions.ts";

describe("McpProviderSessions tool results", () => {
  const threadId = ThreadId.make("thread-tool-results");

  it.effect(
    "requires exact (tool, input, output) match when reported and refuses ambiguous differing outputs",
    () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "A" },
          { isError: true },
        );
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "B" },
          { sentMessage: "B" },
        );

        // A reported error for input B must not drain A's error or B's success.
        assert.strictEqual(
          yield* sessions.takeToolResult(
            threadId,
            "send_to_user",
            { message: "B" },
            { isError: true },
          ),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            threadId,
            "send_to_user",
            { message: "A" },
            { isError: true },
          ),
          { isError: true },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "B" }),
          { sentMessage: "B" },
        );

        // Identical inputs with identical outputs are interchangeable.
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "Same" },
          { sentMessage: "Same" },
        );
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "Same" },
          { sentMessage: "Same" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Same" }),
          { sentMessage: "Same" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Same" }),
          { sentMessage: "Same" },
        );

        // Identical inputs with differing outputs stay unclaimed on input-only lookup.
        yield* sessions.recordToolResult(
          threadId,
          "delegate_task",
          { task: "Audit" },
          { taskId: "task-1" },
        );
        yield* sessions.recordToolResult(
          threadId,
          "delegate_task",
          { task: "Audit" },
          { taskId: "task-2" },
        );
        assert.strictEqual(
          yield* sessions.takeToolResult(threadId, "delegate_task", { task: "Audit" }),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            threadId,
            "delegate_task",
            { task: "Audit" },
            { taskId: "task-2" },
          ),
          { taskId: "task-2" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "delegate_task", { task: "Audit" }),
          { taskId: "task-1" },
        );
      }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("drops stale-session writes and clears unconsumed results on clearToolResults", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set({
        environmentId: EnvironmentId.make("env-tool-results"),
        threadId,
        providerSessionId: "session-2",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer token",
        browserToolsAvailable: false,
      });
      // A handler finishing for replaced session-1 must not populate session-2.
      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Old" },
        { sentMessage: "Old" },
        { providerSessionId: "session-1" },
      );
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Old" }),
        undefined,
      );

      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Current" },
        { sentMessage: "Current" },
        { providerSessionId: "session-2" },
      );
      const turn1Epoch = yield* sessions.toolResultEpoch(threadId);
      yield* sessions.clearToolResults(threadId);
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Current" }),
        undefined,
      );

      // A handler started in turn 1 that finishes after turn cleanup must not populate turn 2,
      // even when the same provider session is reused.
      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Late from turn 1" },
        { sentMessage: "Late from turn 1" },
        { providerSessionId: "session-2", epoch: turn1Epoch },
      );
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Late from turn 1" }),
        undefined,
      );
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  describe("full results kept for providers that show a stand-in", () => {
    const rawThread = ThreadId.make("thread-raw-results");
    const MiB = 1024 * 1024;
    const screenshot = (megabytes: number) => ({
      content: [
        { type: "text", text: "Screenshot taken." },
        { type: "image", mimeType: "image/png", data: "A".repeat(megabytes * MiB) },
      ],
    });

    it.effect("evicts the oldest results once a thread holds 16 MB", () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.keepToolResults(rawThread);
        for (const step of [1, 2, 3, 4, 5, 6]) {
          yield* sessions.recordRawToolResult(rawThread, "device_screenshot", { step }, () =>
            screenshot(3),
          );
        }
        // Six results of about 3 MB do not fit 16 MB: the first one is gone, the rest remain.
        assert.strictEqual(
          yield* sessions.takeRawToolResult(rawThread, "device_screenshot", { step: 1 }),
          undefined,
        );
        for (const step of [2, 3, 4, 5, 6]) {
          assert.isDefined(
            yield* sessions.takeRawToolResult(rawThread, "device_screenshot", { step }),
          );
        }
      }).pipe(Effect.provide(McpProviderSessions.layer)),
    );

    it.effect("keeps the text of a result whose image is over the entry limit", () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.keepToolResults(rawThread);
        yield* sessions.recordRawToolResult(rawThread, "device_screenshot", { id: "big" }, () =>
          screenshot(5),
        );
        yield* sessions.recordRawToolResult(rawThread, "device_screenshot", { id: "ok" }, () =>
          screenshot(1),
        );
        const big = yield* sessions.takeRawToolResult(rawThread, "device_screenshot", {
          id: "big",
        });
        assert.deepEqual(big?.result, {
          content: [
            { type: "text", text: "Screenshot taken." },
            { type: "text", text: "[Image too large to keep]" },
          ],
        });
        const ok = (yield* sessions.takeRawToolResult(rawThread, "device_screenshot", {
          id: "ok",
        }))?.result as ReturnType<typeof screenshot>;
        assert.strictEqual(ok.content[1]?.type, "image");
      }).pipe(Effect.provide(McpProviderSessions.layer)),
    );

    it.effect("keeps nothing of an oversized result that has no images to drop", () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.keepToolResults(rawThread);
        yield* sessions.recordRawToolResult(rawThread, "t3_thread_read", { id: 1 }, () => ({
          structuredContent: { text: "x".repeat(5 * MiB) },
        }));
        assert.strictEqual(
          yield* sessions.takeRawToolResult(rawThread, "t3_thread_read", { id: 1 }),
          undefined,
        );
      }).pipe(Effect.provide(McpProviderSessions.layer)),
    );

    it.effect("still keeps at most 64 small results", () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.keepToolResults(rawThread);
        for (let step = 0; step < 70; step++) {
          yield* sessions.recordRawToolResult(rawThread, "t3_queue", { step }, () => ({
            content: [{ type: "text", text: "ok" }],
          }));
        }
        assert.strictEqual(
          yield* sessions.takeRawToolResult(rawThread, "t3_queue", { step: 5 }),
          undefined,
        );
        assert.isDefined(yield* sessions.takeRawToolResult(rawThread, "t3_queue", { step: 6 }));
      }).pipe(Effect.provide(McpProviderSessions.layer)),
    );
  });
});
