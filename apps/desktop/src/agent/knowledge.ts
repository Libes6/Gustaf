import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting } from "../lib/api";
import {
  CHAT_KNOWLEDGE_SETTING,
  CitationBook,
  formatKnowledgeHits,
  knowledgeOf,
  knowledgePrompt,
  normalizeChatKnowledge,
  parseKnowledgeArgs,
  searchable,
  withChatKnowledge,
  type EmbedConfig,
  type KnowledgeCollection,
  type KnowledgeEstimate,
  type KnowledgeHit,
  type KnowledgeProgress,
  type KnowledgeStats,
} from "./knowledgeCore";

export * from "./knowledgeCore";

// Collections live in the app data folder (src-tauri/src/knowledge.rs); these are thin wrappers over its commands.
export const knowledge = {
  list: () => invoke<KnowledgeCollection[]>("knowledge_list"),
  create: (name: string, config: EmbedConfig, include?: string[]) =>
    invoke<KnowledgeCollection>("knowledge_create", { name, config, include: include ?? null }),
  rename: (id: string, name: string) => invoke<KnowledgeCollection>("knowledge_rename", { id, name }),
  remove: (id: string) => invoke<void>("knowledge_delete", { id }),
  addSource: (id: string, path: string) => invoke<KnowledgeCollection>("knowledge_add_source", { id, path }),
  removeSource: (id: string, path: string) => invoke<KnowledgeCollection>("knowledge_remove_source", { id, path }),
  setInclude: (id: string, include: string[]) => invoke<KnowledgeCollection>("knowledge_set_include", { id, include }),
  estimate: (id: string) => invoke<KnowledgeEstimate>("knowledge_estimate", { id }),
  reindex: (id: string, confirm: boolean) => invoke<KnowledgeStats>("knowledge_reindex", { id, confirm }),
  cancel: (id: string) => invoke<void>("knowledge_cancel", { id }),
  search: (ids: string[], query: string, limit = 6) =>
    invoke<KnowledgeHit[]>("knowledge_search", { ids, query, limit }),
};

// Changes made in Settings reach open chats (the composer menu) without a reload.
const listeners = new Set<() => void>();
export const onKnowledgeChange = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));
export const emitKnowledgeChange = () => listeners.forEach((fn) => fn());

/** Index progress events of the backend; resolves to the unsubscribe function (a no-op outside Tauri). */
export async function onKnowledgeProgress(fn: (p: KnowledgeProgress) => void): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<KnowledgeProgress>("knowledge-progress", (e) => fn(e.payload));
  } catch {
    return () => {};
  }
}

let queue: Promise<unknown> = Promise.resolve();
export const loadChatKnowledge = async (chatId: number | null): Promise<string[]> =>
  knowledgeOf(
    normalizeChatKnowledge(await getSetting<unknown>(CHAT_KNOWLEDGE_SETTING, null).catch(() => null)),
    chatId,
  );
/** Stores the selection of one chat; writes are serialized so quick toggles cannot overwrite each other. */
export const saveChatKnowledge = (chatId: number, ids: string[]): Promise<void> =>
  (queue = queue
    .then(async () => {
      const map = normalizeChatKnowledge(await getSetting<unknown>(CHAT_KNOWLEDGE_SETTING, null).catch(() => null));
      await setSetting(CHAT_KNOWLEDGE_SETTING, withChatKnowledge(map, chatId, ids));
    })
    .catch(() => {})) as Promise<void>;

/** The chat's selected collections that still exist and have something indexed (null: none, so no tool is offered). */
export async function knowledgeForChat(chatId: number | undefined): Promise<{ ids: string[]; prompt: string } | null> {
  if (chatId === undefined) return null;
  const selected = await loadChatKnowledge(chatId);
  if (!selected.length) return null;
  const all = await knowledge.list().catch(() => [] as KnowledgeCollection[]);
  const usable = all.filter((c) => selected.includes(c.id) && searchable(c));
  return usable.length ? { ids: usable.map((c) => c.id), prompt: knowledgePrompt(usable.map((c) => c.name)) } : null;
}

const books = new WeakMap<AbortSignal, CitationBook>();
/** Runs `knowledge_search` for a chat. Citation numbers stay stable across the calls of one run (keyed by its abort signal). */
export async function runKnowledgeSearch(
  chatId: number | undefined,
  signal: AbortSignal,
  args: unknown,
): Promise<string> {
  const { query, limit } = parseKnowledgeArgs(args);
  const scope = await knowledgeForChat(chatId);
  if (!scope) throw new Error("No indexed knowledge collection is selected for this chat.");
  let book = books.get(signal);
  if (!book) books.set(signal, (book = new CitationBook()));
  return formatKnowledgeHits(await knowledge.search(scope.ids, query, limit), book);
}
