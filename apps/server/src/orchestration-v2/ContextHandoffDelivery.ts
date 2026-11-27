import type {
  MemoryNote,
  OrchestrationV2ContextHandoff,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ContextHandoffBudgetError } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  estimateTextTokens,
  historyCost,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";

// A first word with a second slash is a path, not a command.
const SLASH_COMMAND = /^\s*\/[^\s/]+(?:\s|$)/u;

/** Providers only run a native command that opens the prompt, so its turn defers inline context to the next one. */
export const isSlashCommandMessage = (message: {
  readonly role: string;
  readonly text: string;
}): boolean => message.role === "user" && SLASH_COMMAND.test(message.text);

/** The provider prompt for a turn that carries inline context ahead of the user's text. */
export const withInlineContext = (context: string, userText: string): string =>
  context === "" ? userText : `${context}\n\nUser message:\n${userText}`;

/**
 * A turn's text with the shared skills it runs ahead of the request, and how much of it is not
 * the user's words. A native command must open the prompt, so its skills follow it.
 */
export const withSkillContext = (
  skillContext: string,
  userText: string,
  slashCommand: boolean,
): { readonly text: string; readonly inlineContextLength: number } => {
  if (skillContext === "") return { text: userText, inlineContextLength: 0 };
  if (slashCommand) return { text: `${userText}\n\n${skillContext}`, inlineContextLength: 0 };
  const text = withInlineContext(skillContext, userText);
  return { text, inlineContextLength: text.length - userText.length };
};

/** Persist around injection; ambiguous delivery requires a fresh native thread. Call unsent if refused before prompt consumption. */
export const deliverContextHandoffs = Effect.fn("orchestrationV2.deliverContextHandoffs")(
  function* <InjectError = never, PersistError = never, BudgetError = never>(input: {
    readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly budget: number | Effect.Effect<number, BudgetError>;
    readonly deferInline?: boolean;
    readonly alreadyDeliveredItemIds: ReadonlySet<string>;
    readonly inject?: (
      history: ProviderAdapter.ProviderAdapterV2HistoricalContext,
    ) => Effect.Effect<boolean, InjectError>;
    readonly persist: (handoff: OrchestrationV2ContextHandoff) => Effect.Effect<void, PersistError>;
  }) {
    const nativeThreadId = input.providerThread.nativeThreadRef?.nativeId ?? undefined;
    const pending = input.handoffs.filter(
      (handoff) =>
        nativeThreadId === undefined ||
        handoff.delivery?.nativeThreadId !== nativeThreadId ||
        handoff.delivery.status === "pending",
    );
    if (pending.length === 0 || (input.deferInline && input.inject === undefined))
      return { context: "", delivered: Effect.void, unsent: Effect.void, inlineHandoffs: [] };
    const budget = typeof input.budget === "number" ? input.budget : yield* input.budget;
    let coverage = pending
      .map(
        (handoff) =>
          `Context handoff (${handoff.strategy === "fork_delta_summary" ? "merge_back / fork_delta_summary" : handoff.strategy}):\n${
            handoff.history?.coverage ??
            `From thread ${handoff.threadId}, runs ${handoff.coveredRunOrdinals.from}-${handoff.coveredRunOrdinals.to}. Recover history with t3_thread_read, view=activity, afterPosition=-1; paginate with afterPosition=nextPosition, and use itemId/textOffset for long items.`
          }`,
      )
      .join("\n");
    if (historyCost([], coverage) > Math.min(4_000, budget / 2)) {
      const strategies = Array.from(new Set(pending.map((handoff) => handoff.strategy)));
      coverage = `Context handoff (${strategies.join(", ")}). ${pending.length} handoff records; detailed coverage references omitted. Recover an omitted item only when the request needs it, with t3_thread_read({threadId:"${input.providerThread.appThreadId ?? pending[0]!.threadId}",view:"activity",itemId:"<omitted item ID>",maxCharsPerItem:4000}); continue long text with textOffset=nextTextOffset until null. Follow fork/handoff source references in activity. Items included below need no read.`;
    }
    const seen = new Set(input.alreadyDeliveredItemIds);
    const messages = pending
      .flatMap((handoff) => handoff.history?.messages ?? [])
      .filter((message) => {
        if (seen.has(message.itemId)) return false;
        seen.add(message.itemId);
        return true;
      });
    const oldContext = pending
      .filter((handoff) => handoff.history === undefined)
      .map((handoff) => handoff.summaryText)
      .join("\n\n");
    const fullCoverage =
      oldContext && historyCost([], `${coverage}\n${oldContext}`) + 512 <= budget
        ? `${coverage}\n${oldContext}`
        : coverage;
    const selected = selectHistory({
      messages,
      coverage: fullCoverage,
      omittedItems: pending.reduce((sum, handoff) => sum + (handoff.history?.omittedItems ?? 0), 0),
      omittedItemIds: pending.flatMap((handoff) => handoff.history?.omittedItemIds ?? []),
      budget,
    });
    if (historyCost(selected.messages, selected.context) > budget) {
      if (input.deferInline)
        return { context: "", delivered: Effect.void, unsent: Effect.void, inlineHandoffs: [] };
      return yield* new ContextHandoffBudgetError();
    }
    const omittedItemIds = new Set(selected.omittedItemIds);
    const persist = (status: "pending" | "injected" | "inline") =>
      Effect.forEach(
        pending,
        (handoff) =>
          input.persist({
            ...handoff,
            ...(nativeThreadId === undefined
              ? {}
              : {
                  delivery: {
                    nativeThreadId,
                    status,
                    omittedItemIds: [
                      ...(handoff.history?.omittedItemIds ?? []),
                      ...(handoff.history?.messages ?? [])
                        .filter((message) => omittedItemIds.has(message.itemId))
                        .map((message) => message.itemId),
                    ],
                    itemIds: selected.messages
                      .filter((message) =>
                        handoff.history?.messages.some(
                          (candidate) => candidate.itemId === message.itemId,
                        ),
                      )
                      .map((message) => message.itemId),
                  },
                }),
          }),
        { discard: true },
      );
    if (input.inject !== undefined && nativeThreadId !== undefined) {
      if (
        pending.some(
          (handoff) =>
            handoff.delivery?.nativeThreadId === nativeThreadId &&
            handoff.delivery.status === "pending",
        )
      ) {
        return yield* new ContextHandoffDeliveryUncertainError();
      }
      yield* persist("pending");
      const injected = yield* input.inject({
        messages: selected.messages,
        context: selected.context,
      });
      if (injected) {
        yield* persist("injected");
        return { context: "", delivered: Effect.void, unsent: Effect.void, inlineHandoffs: [] };
      }
    } else {
      yield* persist("pending");
    }
    if (input.deferInline) {
      // Compaction cannot carry inline transcripts; retain for the next turn if native injection is unsupported.
      yield* Effect.forEach(pending, input.persist, { discard: true });
      return { context: "", delivered: Effect.void, unsent: Effect.void, inlineHandoffs: [] };
    }
    return {
      context: renderHistory(selected.messages, selected.context),
      delivered: persist("inline"),
      unsent: Effect.forEach(pending, input.persist, { discard: true }),
      inlineHandoffs: pending,
    };
  },
);

export class ContextHandoffDeliveryUncertainError extends Schema.TaggedError<ContextHandoffDeliveryUncertainError>()(
  "ContextHandoffDeliveryUncertainError",
  {},
) {
  override get message() {
    return "Historical context delivery is uncertain; replace the native thread before retrying.";
  }
}

export interface MemoryDeliveryState {
  readonly globalRevision: number;
  readonly projectRevision: number;
}

export interface MemoryInlineDeliveryResult {
  readonly context: string;
  readonly nextDelivered: MemoryDeliveryState | null;
}

const MEMORY_MIN_BUDGET_TOKENS = 64;
const MEMORY_TRUNCATION_SUFFIX = "\n…(truncated to fit context budget)";

/**
 * Formats user/project Gustaf Memory notes for inline delivery into a provider turn.
 * Delivers on the first eligible turn of a native session and whenever either note's revision
 * changes. Deferred on slash-command or compaction turns; cleared notes stop future delivery.
 */
export function buildMemoryInlineContext(input: {
  readonly global: Pick<MemoryNote, "content" | "revision">;
  readonly project: Pick<MemoryNote, "content" | "revision"> | null;
  readonly delivered?: MemoryDeliveryState;
  readonly budgetTokens?: number;
  readonly deferInline?: boolean;
}): MemoryInlineDeliveryResult {
  if (input.deferInline === true) {
    return { context: "", nextDelivered: null };
  }
  const nextDelivered: MemoryDeliveryState = {
    globalRevision: input.global.revision,
    projectRevision: input.project?.revision ?? 0,
  };
  const globalText = input.global.content.trim();
  const projectText = input.project?.content.trim() ?? "";

  const includeGlobal =
    globalText !== "" &&
    (input.delivered === undefined || input.delivered.globalRevision !== input.global.revision);
  const includeProject =
    projectText !== "" &&
    (input.delivered === undefined ||
      input.delivered.projectRevision !== (input.project?.revision ?? 0));

  if (!includeGlobal && !includeProject) {
    return { context: "", nextDelivered };
  }

  const header =
    input.delivered === undefined
      ? "Gustaf Memory (user-maintained preferences and project notes; follow unless overridden by the user):"
      : "Gustaf Memory update (the user updated their memory notes since your last turn):";
  const sections = [
    ...(includeGlobal ? [`[Global memory]\n${globalText}`] : []),
    ...(includeProject ? [`[Project memory]\n${projectText}`] : []),
  ];
  let rendered = `${header}\n\n${sections.join("\n\n")}`;

  if (input.budgetTokens !== undefined) {
    if (input.budgetTokens < MEMORY_MIN_BUDGET_TOKENS) {
      return { context: "", nextDelivered: null };
    }
    if (estimateTextTokens(rendered) > input.budgetTokens) {
      const headerTokens = estimateTextTokens(`${header}\n\n${MEMORY_TRUNCATION_SUFFIX}`);
      if (headerTokens >= input.budgetTokens) {
        return { context: "", nextDelivered: null };
      }
      const body = sections.join("\n\n");
      let maxChars = Math.min(body.length, Math.max(0, (input.budgetTokens - headerTokens) * 4));
      rendered = `${header}\n\n${body.slice(0, maxChars).trimEnd()}${MEMORY_TRUNCATION_SUFFIX}`;
      while (maxChars > 0 && estimateTextTokens(rendered) > input.budgetTokens) {
        maxChars = Math.floor(maxChars * 0.8);
        rendered = `${header}\n\n${body.slice(0, maxChars).trimEnd()}${MEMORY_TRUNCATION_SUFFIX}`;
      }
      if (maxChars <= 0 || estimateTextTokens(rendered) > input.budgetTokens) {
        return { context: "", nextDelivered: null };
      }
    }
  }

  return { context: rendered, nextDelivered };
}
