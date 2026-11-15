import { assert, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { makeAntigravityPromptGuard } from "./AntigravityPromptGuard.ts";

const NOTICE = "The stream was interrupted. Please continue the task you were working on.";

const message = (text: string): EffectAcpSchema.SessionNotification => ({
  sessionId: "session-1",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const toolCall: EffectAcpSchema.SessionNotification = {
  sessionId: "session-1",
  update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read file" },
};

it("leaves repeated broken streams to the harness's own retry loop", () => {
  const guard = makeAntigravityPromptGuard();
  assert.isUndefined(guard(message(`Writing the analysis. ⚠ ${NOTICE}`)));
  assert.isUndefined(guard(toolCall));
  assert.isUndefined(guard(message(`Continuing. ⚠ ${NOTICE.slice(0, 30)}`)));
  assert.isUndefined(guard(message(NOTICE.slice(30))));
  assert.isUndefined(guard(message("Still writing.")));
  assert.isUndefined(guard(message(`⚠ ${NOTICE}`)));
  assert.isUndefined(guard(message(`Again. ⚠ ${NOTICE}`)));
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
