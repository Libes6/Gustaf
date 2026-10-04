import { loadAgentSettings } from "../agent/agentSettingsStore";
import { listMemories, remember } from "../agent/memory";
import { buildSuggestPrompt, dedupeSuggestions, suggestBudget, suggestionsFromParts, type Suggestion, type SuggestScope } from "../agent/memorySuggest";
import { getAdapter } from "../providers";
import type { ModelInfo, ProviderConfig, TokenUsage } from "../providers/types";
import { loadMessages } from "./data";
import { cheapTarget, runsOwnTools } from "./modelRouting";

/** The parts of the app state the request needs (a subset of `AppState`, so it is easy to fake in tests). */
export type SuggestApp = {
  providers: ProviderConfig[];
  models: ModelInfo[];
  selection: { providerId: string; model: string } | null;
  bumpUsage: (providerId: string) => void;
  recordTokens: (providerId: string, model: string, usage?: TokenUsage) => void;
};

export class SuggestParseError extends Error {
  constructor() { super("unparsable"); this.name = "SuggestParseError"; }
}

/**
 * One request: the chat's conversation text (tool outputs excluded, secrets redacted, bounded) goes to the cheap model
 * from the agent settings, else the selected model, as a tool-less read-only turn. Returns the parsed suggestions that are not
 * already saved (global or this project). Nothing is stored here.
 */
export async function suggestMemories(app: SuggestApp, o: { chatId: number; projectRoot: string | null; signal: AbortSignal; /** The end-of-chat run, not the user's request. */ auto?: boolean }): Promise<{ suggestions: Suggestion[]; model: string }> {
  const selection = app.selection;
  const provider = app.providers.find((p) => p.id === selection?.providerId);
  if (!provider || !selection) throw new Error("No model selected.");
  const target = cheapTarget(await loadAgentSettings(), app, { provider, model: selection.model });
  // Like the automatic review: a CLI agent would start a whole agent run in the project folder (and spend its quota) unasked.
  if (o.auto && runsOwnTools(target.provider)) return { suggestions: [], model: target.info?.name ?? target.model };
  const messages = await loadMessages(o.chatId);
  const hasProject = !!o.projectRoot;
  const { system, user } = buildSuggestPrompt(messages, { hasProject, budget: suggestBudget(target.info?.contextWindow) });
  const adapter = await getAdapter(target.provider);
  app.bumpUsage(target.provider.id);
  const out = await adapter.turn({
    system, messages: [{ role: "user", parts: [{ type: "text", text: user }] }],
    tools: [], model: target.model, cwd: o.projectRoot ?? undefined, access: "readonly", signal: o.signal, onText: () => {},
  });
  app.recordTokens(target.provider.id, target.model, out.usage);
  if (o.signal.aborted) throw new DOMException("aborted", "AbortError");
  const parsed = suggestionsFromParts(out.parts, { hasProject });
  if (!parsed.ok) throw new SuggestParseError();
  const existing = [...(await listMemories(null)), ...(o.projectRoot ? await listMemories(o.projectRoot) : [])];
  return { suggestions: dedupeSuggestions(parsed.suggestions, existing), model: target.info?.name ?? target.model };
}

/**
 * Stores the confirmed facts (the caller passes only the ticked ones, with the user's edits). Each fact is checked once more
 * against what is saved now, so a double confirm or a fact added meanwhile does not create a duplicate. A fact scoped to
 * the project needs a project folder; without one it is stored globally only if the caller says so (it never guesses).
 */
export async function storeSuggestions(items: { text: string; scope: SuggestScope }[], o: { projectRoot: string | null; chatId?: number }): Promise<{ saved: number; skipped: number }> {
  let saved = 0;
  let skipped = 0;
  for (const item of items) {
    const root = item.scope === "project" ? o.projectRoot : null;
    if (item.scope === "project" && !root) { skipped++; continue; }
    const existing = [...(await listMemories(null)), ...(o.projectRoot ? await listMemories(o.projectRoot) : [])];
    if (!dedupeSuggestions([item], existing).length) { skipped++; continue; }
    await remember(root, item.text, o.chatId);
    saved++;
  }
  return { saved, skipped };
}
