import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import type * as EffectAcpSchema from "effect-acp/compat";

import { antigravityLimitFailure } from "./AntigravityTurnOutcome.ts";

// The harness sends this after a model stream breaks, then asks the model again (1.4.5).
const STREAM_INTERRUPTED =
  "The stream was interrupted. Please continue the task you were working on.";
// A model that thinks past the harness's 5-minute stream timeout breaks every time.
const MAX_INTERRUPTIONS_IN_A_ROW = 3;
// Enough of the recent text for a harness error that arrives split across chunks.
const RECENT_TEXT_CHARS = 4_096;
// The harness posts its error as its own message, so the error opens the text since the last
// tool call or follows its warning sign; a model quoting one mid-sentence is not stopped.
const HARNESS_ERROR = /(?:^|⚠\uFE0F?\s*)(Error \d{3}, Message: [\s\S]*)$/;
const FLAGGED_HARNESS_ERROR = /⚠\uFE0F?\s*(Error \d{3}, Message: [\s\S]*)$/;

const STREAM_LOOP_FAILURE = makeProviderFailure({
  class: "provider_error",
  message:
    "The model's answer broke off 3 times in a row, so Gustaf stopped the turn. Antigravity cuts a model off after 5 minutes without output, which long thinking on a big task hits. Ask for the work in smaller parts, or pick another model or provider.",
  retryable: true,
});

/**
 * Antigravity retries a broken model stream and a spent quota on its own, for up to an
 * hour, while the turn looks busy. This stops the turn once the session shows either.
 */
export function makeAntigravityPromptGuard(): (
  notification: EffectAcpSchema.SessionNotification,
) => OrchestrationV2ProviderFailure | undefined {
  let interruptions = 0;
  let recent = "";
  // Once the window drops older text, its start is no longer where the message began.
  let trimmed = false;
  return (notification) => {
    const update = notification.update;
    if (update.sessionUpdate === "tool_call") {
      interruptions = 0;
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
    // Count each notice once: only matches that end in the new text.
    for (let at = recent.indexOf(STREAM_INTERRUPTED); at !== -1;) {
      if (at + STREAM_INTERRUPTED.length > seen - shift) interruptions += 1;
      at = recent.indexOf(STREAM_INTERRUPTED, at + 1);
    }
    if (interruptions >= MAX_INTERRUPTIONS_IN_A_ROW) return STREAM_LOOP_FAILURE;
    if (update.sessionUpdate !== "agent_message_chunk") return undefined;
    const harnessError = (trimmed ? FLAGGED_HARNESS_ERROR : HARNESS_ERROR).exec(
      recent.trimStart(),
    )?.[1];
    return harnessError === undefined
      ? undefined
      : antigravityLimitFailure(harnessError, DateTime.nowUnsafe());
  };
}
