import { assert, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { makeAntigravityPromptGuard } from "./AntigravityPromptGuard.ts";
import { antigravityFailedMcpServer } from "./AntigravityTurnOutcome.ts";

const REFUSAL = (server: string) =>
  `The MCP server '${server}' failed to initialize: spawn ENOENT. Fix the MCP server, or remove it from your configuration and start a new session, to continue.`;
const NOTICE = "The stream was interrupted. Please continue the task you were working on.";

const message = (text: string): EffectAcpSchema.SessionNotification => ({
  sessionId: "session-1",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const toolCall: EffectAcpSchema.SessionNotification = {
  sessionId: "session-1",
  update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read file" },
};

it("stops on the third broken stream in a row, counting notices split across chunks", () => {
  const guard = makeAntigravityPromptGuard();
  assert.isUndefined(guard(message(`Writing the analysis. ⚠ ${NOTICE}`)));
  // A tool call between breaks is progress, so the count starts over.
  assert.isUndefined(guard(toolCall));
  assert.isUndefined(guard(message(`Continuing. ⚠ ${NOTICE.slice(0, 30)}`)));
  assert.isUndefined(guard(message(NOTICE.slice(30))));
  assert.isUndefined(guard(message("Still writing.")));
  assert.isUndefined(guard(message(`⚠ ${NOTICE}`)));
  const failure = guard(message(`Again. ⚠ ${NOTICE}`));
  assert.equal(failure?.class, "provider_error");
  assert.include(failure?.message, "5 minutes");
});

it("stops at once on a spent quota the harness reports in the chat, not on a quoted one", () => {
  const quoting = makeAntigravityPromptGuard();
  assert.isUndefined(
    quoting(
      message(
        "Your log shows Error 429, Message: Resource has been exhausted, Status: RESOURCE_EXHAUSTED [reason:QUOTA_EXHAUSTED].",
      ),
    ),
  );

  const guard = makeAntigravityPromptGuard();
  assert.isUndefined(guard(message("Error 429, Message: Resource has been ")));
  const failure = guard(
    message("exhausted, Status: RESOURCE_EXHAUSTED [reason:QUOTA_EXHAUSTED quotaResetDelay:2h]"),
  );
  assert.equal(failure?.class, "usage_limit");
  assert.isString(failure?.resetAt);
});

it("stops when the harness refuses the session over an MCP server, not on a quoted refusal", () => {
  const quoting = makeAntigravityPromptGuard();
  assert.isUndefined(
    quoting(message("The log said The MCP server 'spline' failed to initialize: ENOENT.")),
  );

  const user: EffectAcpSchema.SessionNotification = {
    sessionId: "session-1",
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: `${REFUSAL("spline")} What does this mean?` },
    },
  };
  for (const notifications of [
    // The model quotes the whole refusal, mid-answer or after a tool call.
    [message(`Here is what the log says: ${REFUSAL("spline")}`)],
    [message("Checking the log."), toolCall, message(REFUSAL("spline"))],
    [toolCall, message(REFUSAL("spline"))],
    // The user pastes it; the model's answer starts with it and goes on.
    [user, message("That means")],
    [message(`${REFUSAL("spline")} I will fix it.`)],
    // Only part of the harness phrase.
    [message("The MCP server 'spline' failed to initialize: ENOENT.")],
  ]) {
    const quoted = makeAntigravityPromptGuard();
    assert.deepEqual(
      notifications.map((notification) => quoted(notification)),
      notifications.map(() => undefined),
    );
  }

  const guard = makeAntigravityPromptGuard();
  assert.isUndefined(guard(message("The MCP server 'computer-")));
  const failure = guard(
    message(
      "use' failed to initialize: spawn ENOENT. Fix the MCP server, or remove it from your configuration and start a new session, to continue.",
    ),
  );
  assert.equal(failure?.code, "ANTIGRAVITY_MCP_SERVER_FAILED");
  assert.include(failure?.message, '"computer-use"');
  assert.include(failure?.message, "Settings → MCP");
  assert.equal(antigravityFailedMcpServer(failure!), "computer-use");
  assert.isUndefined(antigravityFailedMcpServer({ ...failure!, code: "OTHER" }));
});
