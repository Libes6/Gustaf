// Storing parsed history. The store is injected (components/HistoryImport builds one from lib/data.ts via
// importers/store.ts), so this stays testable under plain Node.
import type { Msg } from "../../providers/types.ts";
import { storedSourceId, type ImportedChat } from "./common.ts";

export type ImportStore = {
  /** Every chat already stored, archived ones included. `source_id` is set for chats created by an importer. */
  existing(): Promise<{ title: string; created_at: number; source_id?: string | null }[]>;
  /** Finds a matching project (by path, then name) or creates one *without* a path; `null` keeps the chat outside projects. */
  project(name: string, path: string | null): Promise<number | null>;
  /** Creates the chat with its source id; resolves to `null` when that source id is already taken. */
  createChat(projectId: number | null, title: string, sourceId: string, createdAt: number): Promise<number | null>;
  /** Appends a message with its original timestamp (`undefined`: now). */
  addMessage(chatId: number, msg: Msg, createdAt: number | undefined): Promise<void>;
  /** Restores the original chat timestamps once all messages are in. */
  finish(chatId: number, times: { createdAt: number | undefined; updatedAt: number | undefined }): Promise<void>;
  /** Removes a half-imported chat when inserting its messages failed. */
  discard(chatId: number): Promise<void>;
};

export type ImportRun = { imported: number; skipped: number; messages: number; failed: number };

const timeKey = (title: string, createdAt: number) => `${createdAt}\u0000${title}`;

/** Both identities of a chat that count as "already imported": its source id, or the same title and creation time. */
export function duplicateKeys(existing: { title: string; created_at: number; source_id?: string | null }[]) {
  const ids = new Set<string>();
  const times = new Set<string>();
  for (const c of existing) {
    if (c.source_id) ids.add(c.source_id);
    times.add(timeKey(c.title, c.created_at));
  }
  return { ids, times };
}

export const isDuplicate = (chat: ImportedChat, keys: ReturnType<typeof duplicateKeys>) =>
  keys.ids.has(storedSourceId(chat.source, chat.sourceId)) || (!!chat.createdAt && keys.times.has(timeKey(chat.title, chat.createdAt)));

/**
 * Imports chats one at a time. `load` supplies a chat when its turn comes (so a big selection is never held in memory
 * at once); a chat that cannot be read or parsed counts as `failed` and does not stop the others.
 */
export async function importChats(
  items: { sourceId: string; source: ImportedChat["source"] }[],
  load: (index: number) => Promise<ImportedChat | null>,
  store: ImportStore,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportRun> {
  const keys = duplicateKeys(await store.existing());
  const projects = new Map<string, Promise<number | null>>();
  const run: ImportRun = { imported: 0, skipped: 0, messages: 0, failed: 0 };
  for (let i = 0; i < items.length; i++) {
    onProgress?.(i, items.length);
    // Cheap check first: a known source id never needs the file to be read again.
    if (keys.ids.has(storedSourceId(items[i].source, items[i].sourceId))) {
      run.skipped++;
      continue;
    }
    let chat: ImportedChat | null = null;
    try {
      chat = await load(i);
    } catch {
      chat = null;
    }
    if (!chat) {
      run.failed++;
      continue;
    }
    if (isDuplicate(chat, keys)) {
      run.skipped++;
      continue;
    }
    let projectId: number | null = null;
    if (chat.project) {
      const pk = `${chat.project.name}\u0000${chat.project.path ?? ""}`;
      if (!projects.has(pk)) projects.set(pk, store.project(chat.project.name, chat.project.path));
      projectId = (await projects.get(pk)) ?? null;
    }
    const sourceId = storedSourceId(chat.source, chat.sourceId);
    const id = await store.createChat(projectId, chat.title, sourceId, chat.createdAt ?? chat.updatedAt ?? Date.now());
    if (id === null) {
      run.skipped++;
      continue;
    }
    try {
      for (const m of chat.messages) await store.addMessage(id, { role: m.role, parts: m.parts, meta: m.meta }, m.createdAt ?? chat.createdAt);
      await store.finish(id, { createdAt: chat.createdAt, updatedAt: chat.updatedAt });
    } catch (e) {
      await store.discard(id).catch(() => {});
      throw e;
    }
    keys.ids.add(sourceId);
    if (chat.createdAt) keys.times.add(timeKey(chat.title, chat.createdAt));
    run.imported++;
    run.messages += chat.messages.length;
  }
  onProgress?.(items.length, items.length);
  return run;
}
