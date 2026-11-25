// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous hashing keeps page matching bounded without a runtime dependency.
import * as NodeCrypto from "node:crypto";
import type { ThreadId } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

// Other providers may never consume these references.
const MAX_KEPT_HTML_RENDERS = 64;
const MAX_KEPT_TOOL_RESULTS = 64;
// Full results hold screenshots as base64, so count bytes too: the oldest go first.
const MAX_KEPT_RAW_BYTES_PER_THREAD = 16 * 1024 * 1024;
const MAX_KEPT_RAW_ENTRY_BYTES = 4 * 1024 * 1024;

// Antigravity truncates long HTML arguments to a marked tail of at most 8,000 characters.
const BOUNDED_TEXT_MARKER = "[Earlier output truncated]\n\n";
const KEPT_HTML_END_LENGTH = 8_000;

interface KeptHtmlRender {
  readonly path: string | undefined;
  readonly title: string;
  readonly height: number;
  readonly htmlLength: number;
  readonly htmlHash: string;
  readonly htmlEnd: string;
  readonly reference: HtmlRenderReference;
}

interface KeptToolResult {
  readonly toolName: string;
  readonly inputHash: string;
  readonly outputJson: string;
  readonly output: Record<string, unknown>;
}

interface KeptRawToolResult {
  readonly toolName: string;
  readonly inputHash: string;
  readonly result: unknown;
  readonly bytes: number;
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

/**
 * A result over the per-entry limit keeps its text and drops its images, which are what make it
 * big. One that is still over has nothing worth keeping: the provider's own description stands.
 */
const boundRawResult = (result: unknown): { result: unknown; bytes: number } | undefined => {
  const bytes = jsonBytes(result);
  if (bytes <= MAX_KEPT_RAW_ENTRY_BYTES) return { result, bytes };
  if (!Predicate.isObject(result) || !Array.isArray((result as { content?: unknown }).content)) {
    return undefined;
  }
  const content = (result as { content: ReadonlyArray<unknown> }).content.map((block) =>
    Predicate.isObject(block) && (block as { type?: unknown }).type === "image"
      ? { type: "text", text: "[Image too large to keep]" }
      : block,
  );
  const bounded = { ...result, content };
  const boundedBytes = jsonBytes(bounded);
  return boundedBytes <= MAX_KEPT_RAW_ENTRY_BYTES
    ? { result: bounded, bytes: boundedBytes }
    : undefined;
};

/** Newest entries that fit the count and byte limits; the entry just added is always newest. */
const evictRawResults = (entries: ReadonlyArray<KeptRawToolResult>) => {
  const kept: Array<KeptRawToolResult> = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (kept.length >= MAX_KEPT_TOOL_RESULTS || bytes + entry.bytes > MAX_KEPT_RAW_BYTES_PER_THREAD)
      break;
    kept.unshift(entry);
    bytes += entry.bytes;
  }
  return kept;
};

interface ToolResultState {
  readonly entries: ReadonlyMap<ThreadId, ReadonlyArray<KeptToolResult>>;
  readonly epochs: ReadonlyMap<ThreadId, number>;
  /** Present once the thread's provider asked to keep full results (`keepToolResults`). */
  readonly raw: ReadonlyMap<ThreadId, ReadonlyArray<KeptRawToolResult>>;
}

const hashText = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

export const hashToolInput = (input: unknown): string => {
  const normalized = Predicate.isObject(input) && !Array.isArray(input) ? input : {};
  return hashText(stableStringify(normalized));
};

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    readonly recordHtmlRender: (
      threadId: ThreadId,
      input: {
        readonly html: string;
        readonly path?: string | undefined;
        readonly title: string;
        readonly height: number;
      },
      reference: HtmlRenderReference,
    ) => Effect.Effect<void>;
    // A reported attachment consumes that exact page; otherwise the oldest page for a path, or a
    // unique inline match.
    readonly takeHtmlRender: (
      threadId: ThreadId,
      input: PageInput,
      reported?: HtmlRenderReference,
    ) => Effect.Effect<HtmlRenderReference | undefined>;
    readonly toolResultEpoch: (threadId: ThreadId) => Effect.Effect<number>;
    readonly recordToolResult: (
      threadId: ThreadId,
      toolName: string,
      input: unknown,
      output: Record<string, unknown>,
      options?: {
        readonly providerSessionId?: string | undefined;
        readonly epoch?: number | undefined;
      },
    ) => Effect.Effect<void>;
    // A reported output consumes only an exact (tool, input, output) match; input-only recovery
    // consumes a match only when all matching candidates carry the same output.
    readonly takeToolResult: (
      threadId: ThreadId,
      toolName: string,
      input: unknown,
      reported?: Record<string, unknown>,
    ) => Effect.Effect<Record<string, unknown> | undefined>;
    readonly clearToolResults: (threadId: ThreadId) => Effect.Effect<void>;
    /**
     * The thread's provider reports a stand-in for MCP results, so its full `t3-code` results are
     * kept too, until the provider session changes.
     */
    readonly keepToolResults: (threadId: ThreadId) => Effect.Effect<void>;
    /** Calls `encode` only for threads that keep full results; an undefined result is not kept. */
    readonly recordRawToolResult: (
      threadId: ThreadId,
      toolName: string,
      input: unknown,
      encode: () => unknown,
      options?: {
        readonly providerSessionId?: string | undefined;
        readonly epoch?: number | undefined;
      },
    ) => Effect.Effect<void>;
    /** The oldest kept full result of a call with this tool and this input. */
    readonly takeRawToolResult: (
      threadId: ThreadId,
      toolName: string,
      input: unknown,
    ) => Effect.Effect<{ readonly result: unknown } | undefined>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

interface PageInput {
  readonly html?: unknown;
  readonly path?: unknown;
  readonly title?: unknown;
  readonly height?: unknown;
}

const matchingPageIndex = (kept: ReadonlyArray<KeptHtmlRender>, input: PageInput): number => {
  const height =
    typeof input.height === "string" && input.height.trim() !== ""
      ? Number(input.height)
      : input.height;
  const sameFrame = (page: KeptHtmlRender) => page.title === input.title && page.height === height;
  const path = input.path;
  // The handler refuses a call with both sources, so it published nothing to recover. Its decoder
  // reads null as an omitted source.
  if (path !== undefined && path !== null && input.html !== undefined && input.html !== null) {
    return -1;
  }
  if (typeof path === "string" && path.length > 0) {
    // An edited file is published again under the same path; completions arrive in publish order.
    return kept.findIndex((page) => page.path === path && sameFrame(page));
  }
  const html = input.html;
  if (typeof html !== "string" || html.length === 0) {
    return -1;
  }
  const htmlHash = hashText(html);
  const tail = html.startsWith(BOUNDED_TEXT_MARKER)
    ? html.slice(BOUNDED_TEXT_MARKER.length)
    : undefined;
  const matches = kept.flatMap((page, index) =>
    page.path === undefined &&
    sameFrame(page) &&
    (page.htmlHash === htmlHash ||
      (tail !== undefined &&
        tail.length > 0 &&
        tail.length < page.htmlLength &&
        page.htmlEnd.endsWith(tail)))
      ? [index]
      : [],
  );
  // Identical pages are interchangeable, so repeats are taken in publish order.
  if (matches.length > 1 && matches.every((index) => kept[index]!.htmlHash === htmlHash)) {
    return matches[0]!;
  }
  return matches.length === 1 ? matches[0]! : -1;
};

const matchingToolResultIndex = (
  kept: ReadonlyArray<KeptToolResult>,
  toolName: string,
  input: unknown,
  reported?: Record<string, unknown>,
): number => {
  const inputHash = hashToolInput(input);
  if (reported !== undefined) {
    const reportedJson = stableStringify(reported);
    return kept.findIndex(
      (entry) =>
        entry.toolName === toolName &&
        entry.inputHash === inputHash &&
        entry.outputJson === reportedJson,
    );
  }
  const matches = kept.flatMap((entry, index) =>
    entry.toolName === toolName && entry.inputHash === inputHash ? [index] : [],
  );
  if (matches.length === 0) return -1;
  if (matches.length === 1) return matches[0]!;
  // Identical outputs (e.g. repeated send_to_user calls) are interchangeable; differing outputs
  // (e.g. parallel identical-input delegate_task calls) stay unclaimed to avoid misattribution.
  const firstOutput = kept[matches[0]!]!.outputJson;
  return matches.every((index) => kept[index]!.outputJson === firstOutput) ? matches[0]! : -1;
};

const clearThreadToolResults = (
  state: ToolResultState,
  threadId: ThreadId,
  options?: { readonly keepRawOptIn?: boolean },
): ToolResultState => {
  const entries = new Map(state.entries);
  entries.delete(threadId);
  const epochs = new Map(state.epochs);
  epochs.set(threadId, (state.epochs.get(threadId) ?? 0) + 1);
  const raw = new Map(state.raw);
  if (options?.keepRawOptIn === true && raw.has(threadId)) {
    raw.set(threadId, []);
  } else {
    raw.delete(threadId);
  }
  return { entries, epochs, raw };
};

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const htmlRenders = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptHtmlRender>>());
  const toolResultState = yield* Ref.make<ToolResultState>({
    entries: new Map(),
    epochs: new Map(),
    raw: new Map(),
  });
  const activeSessionMismatch = (threadId: ThreadId, providerSessionId: string | undefined) =>
    providerSessionId === undefined
      ? Effect.succeed(false)
      : Ref.get(sessions).pipe(
          Effect.map((current) => {
            const active = current.get(threadId);
            return active !== undefined && active.providerSessionId !== providerSessionId;
          }),
        );
  return McpProviderSessions.of({
    set: Effect.fn("McpProviderSessions.set")(function* (config) {
      const current = yield* Ref.get(sessions);
      if (current.get(config.threadId)?.providerSessionId !== config.providerSessionId) {
        yield* Ref.update(htmlRenders, (kept) => {
          const next = new Map(kept);
          next.delete(config.threadId);
          return next;
        });
        yield* Ref.update(toolResultState, (state) =>
          clearThreadToolResults(state, config.threadId),
        );
      }
      yield* Ref.update(sessions, (current) => new Map(current).set(config.threadId, config));
    }),
    read: Effect.fn("McpProviderSessions.read")(function (threadId) {
      return Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId)));
    }),
    clear: Effect.fn("McpProviderSessions.clear")(function (threadId) {
      return Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }).pipe(
        Effect.andThen(
          Ref.update(htmlRenders, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          }),
        ),
        Effect.andThen(
          Ref.update(toolResultState, (state) => clearThreadToolResults(state, threadId)),
        ),
      );
    }),
    recordHtmlRender: Effect.fn("McpProviderSessions.recordHtmlRender")(
      function (threadId, input, reference) {
        return Ref.update(htmlRenders, (current) =>
          new Map(current).set(
            threadId,
            [
              ...(current.get(threadId) ?? []),
              {
                path: input.path,
                title: input.title,
                height: input.height,
                htmlLength: input.html.length,
                htmlHash: hashText(input.html),
                // Copy the tail so its backing storage cannot retain the entire HTML string.
                htmlEnd: Buffer.from(input.html.slice(-KEPT_HTML_END_LENGTH), "utf16le").toString(
                  "utf16le",
                ),
                reference,
              },
            ].slice(-MAX_KEPT_HTML_RENDERS),
          ),
        );
      },
    ),
    takeHtmlRender: Effect.fn("McpProviderSessions.takeHtmlRender")(
      function (threadId, input, reported) {
        return Ref.modify(htmlRenders, (current) => {
          const kept = current.get(threadId) ?? [];
          const index =
            reported === undefined
              ? matchingPageIndex(kept, input)
              : kept.findIndex((page) => page.reference.attachmentId === reported.attachmentId);
          if (index === -1) {
            return [undefined, current];
          }
          const rest = kept.filter((_, keptIndex) => keptIndex !== index);
          const next = new Map(current);
          if (rest.length === 0) {
            next.delete(threadId);
          } else {
            next.set(threadId, rest);
          }
          return [kept[index]!.reference, next];
        });
      },
    ),
    toolResultEpoch: Effect.fn("McpProviderSessions.toolResultEpoch")(function (threadId) {
      return Ref.get(toolResultState).pipe(Effect.map((state) => state.epochs.get(threadId) ?? 0));
    }),
    recordToolResult: Effect.fn("McpProviderSessions.recordToolResult")(
      function* (threadId, toolName, input, output, options) {
        const providerSessionId = options?.providerSessionId;
        if (providerSessionId !== undefined) {
          const activeSession = (yield* Ref.get(sessions)).get(threadId);
          // A handler finishing after session replacement must not populate the new session.
          if (
            activeSession !== undefined &&
            activeSession.providerSessionId !== providerSessionId
          ) {
            return;
          }
        }
        const canonicalTool = resolveT3McpToolId(toolName) ?? toolName;
        const entry: KeptToolResult = {
          toolName: canonicalTool,
          inputHash: hashToolInput(input),
          outputJson: stableStringify(output),
          output,
        };
        const expectedEpoch = options?.epoch;
        yield* Ref.update(toolResultState, (state) => {
          // A handler finishing after its turn closed must not populate the next turn.
          if (expectedEpoch !== undefined && (state.epochs.get(threadId) ?? 0) !== expectedEpoch) {
            return state;
          }
          const entries = new Map(state.entries);
          entries.set(
            threadId,
            [...(entries.get(threadId) ?? []), entry].slice(-MAX_KEPT_TOOL_RESULTS),
          );
          return { ...state, entries };
        });
      },
    ),
    takeToolResult: Effect.fn("McpProviderSessions.takeToolResult")(
      function (threadId, toolName, input, reported) {
        const canonicalTool = resolveT3McpToolId(toolName) ?? toolName;
        return Ref.modify(toolResultState, (state) => {
          const kept = state.entries.get(threadId) ?? [];
          const index = matchingToolResultIndex(kept, canonicalTool, input, reported);
          if (index === -1) {
            return [undefined, state];
          }
          const rest = kept.filter((_, keptIndex) => keptIndex !== index);
          const entries = new Map(state.entries);
          if (rest.length === 0) {
            entries.delete(threadId);
          } else {
            entries.set(threadId, rest);
          }
          return [kept[index]!.output, { ...state, entries }];
        });
      },
    ),
    clearToolResults: Effect.fn("McpProviderSessions.clearToolResults")(function (threadId) {
      return Ref.update(toolResultState, (state) =>
        clearThreadToolResults(state, threadId, { keepRawOptIn: true }),
      );
    }),
    keepToolResults: Effect.fn("McpProviderSessions.keepToolResults")(function (threadId) {
      return Ref.update(toolResultState, (state) =>
        state.raw.has(threadId) ? state : { ...state, raw: new Map(state.raw).set(threadId, []) },
      );
    }),
    recordRawToolResult: Effect.fn("McpProviderSessions.recordRawToolResult")(
      function* (threadId, toolName, input, encode, options) {
        if (!(yield* Ref.get(toolResultState)).raw.has(threadId)) return;
        if (yield* activeSessionMismatch(threadId, options?.providerSessionId)) return;
        const encoded = encode();
        if (encoded === undefined) return;
        const bounded = boundRawResult(encoded);
        if (bounded === undefined) return;
        const entry: KeptRawToolResult = {
          toolName: resolveT3McpToolId(toolName) ?? toolName,
          inputHash: hashToolInput(input),
          result: bounded.result,
          bytes: bounded.bytes,
        };
        const expectedEpoch = options?.epoch;
        yield* Ref.update(toolResultState, (state) => {
          const current = state.raw.get(threadId);
          if (
            current === undefined ||
            (expectedEpoch !== undefined && (state.epochs.get(threadId) ?? 0) !== expectedEpoch)
          ) {
            return state;
          }
          return {
            ...state,
            raw: new Map(state.raw).set(threadId, evictRawResults([...current, entry])),
          };
        });
      },
    ),
    takeRawToolResult: Effect.fn("McpProviderSessions.takeRawToolResult")(
      function (threadId, toolName, input) {
        const canonicalTool = resolveT3McpToolId(toolName) ?? toolName;
        const inputHash = hashToolInput(input);
        return Ref.modify(toolResultState, (state) => {
          const kept = state.raw.get(threadId) ?? [];
          const index = kept.findIndex(
            (entry) => entry.toolName === canonicalTool && entry.inputHash === inputHash,
          );
          if (index === -1) return [undefined, state];
          return [
            { result: kept[index]!.result },
            {
              ...state,
              raw: new Map(state.raw).set(
                threadId,
                kept.filter((_, keptIndex) => keptIndex !== index),
              ),
            },
          ];
        });
      },
    ),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
