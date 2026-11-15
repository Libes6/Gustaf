import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as EffectAcpSchema from "effect-acp/compat";

import { antigravityLimitFailure } from "./AntigravityTurnOutcome.ts";

// Enough of the recent text for a harness error that arrives split across chunks.
const RECENT_TEXT_CHARS = 4_096;
// The harness posts its error as its own message, so the error opens the text since the last
// tool call or follows its warning sign; a model quoting one mid-sentence is not stopped.
const HARNESS_ERROR = /(?:^|⚠\uFE0F?\s*)(Error \d{3}, Message: [\s\S]*)$/;
const FLAGGED_HARNESS_ERROR = /⚠\uFE0F?\s*(Error \d{3}, Message: [\s\S]*)$/;

/**
 * Antigravity retries a broken model stream itself. A spent quota also looks busy while
 * the harness retries it, so this stops the turn once the session shows that error.
 */
export function makeAntigravityPromptGuard(): (
  notification: EffectAcpSchema.SessionNotification,
) => OrchestrationV2ProviderFailure | undefined {
  let recent = "";
  // Once the window drops older text, its start is no longer where the message began.
  let trimmed = false;
  return (notification) => {
    const update = notification.update;
    if (update.sessionUpdate === "tool_call") {
      recent = "";
      trimmed = false;
      return undefined;
    }
    if (
      (update.sessionUpdate !== "agent_message_chunk" &&
        update.sessionUpdate !== "user_message_chunk") ||
      update.content.type !== "text"
    ) {
      return undefined;
    }
    const seen = recent.length;
    recent = (recent + update.content.text).slice(-RECENT_TEXT_CHARS);
    const shift = seen + update.content.text.length - recent.length;
    if (shift > 0) trimmed = true;
    if (update.sessionUpdate !== "agent_message_chunk") return undefined;
    const harnessError = (trimmed ? FLAGGED_HARNESS_ERROR : HARNESS_ERROR).exec(
      recent.trimStart(),
    )?.[1];
    return harnessError === undefined
      ? undefined
      : antigravityLimitFailure(harnessError, DateTime.nowUnsafe());
  };
}
