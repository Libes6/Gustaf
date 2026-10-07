// SQLite glue for the history importers: the `ImportStore` over lib/data.ts and the import history record.
import { db, getSetting, setSetting } from "../api";
import { createProject, listArchived, listChats, listProjects, type ImportRecord } from "../data";
import type { ImportSource } from "./common";
import type { ImportStore } from "./run";

/**
 * Projects are matched by path, then by name. A path read from a file is never registered as a new project, so an
 * import cannot hand the agent access to a directory the user did not add themselves (the same rule as the JSON import).
 */
export async function matchOrCreateProject(name: string, path: string | null): Promise<number> {
  const projects = await listProjects();
  const hit = (path && projects.find((p) => p.path === path)) || projects.find((p) => p.name === name);
  return hit ? hit.id : createProject(name, null, null);
}

export const importStore: ImportStore = {
  async existing() {
    const chats = [...(await listChats()), ...(await listArchived())];
    const rows = await db.select<{ id: number; source_id: string | null }>(
      "select id, source_id from chats where source_id is not null",
    );
    const sourceOf = new Map(rows.map((r) => [r.id, r.source_id]));
    return chats.map((c) => ({ title: c.title, created_at: c.created_at, source_id: sourceOf.get(c.id) ?? null }));
  },
  project: matchOrCreateProject,
  async createChat(projectId, title, sourceId, createdAt) {
    const r = await db.exec(
      "insert or ignore into chats(project_id, title, source_id, created_at, updated_at) values(?, ?, ?, ?, ?)",
      [projectId, title, sourceId, createdAt, createdAt],
    );
    return r.changes ? r.lastId : null;
  },
  async addMessage(chatId, msg, createdAt) {
    const { role, parts, meta } = msg;
    await db.exec("insert into messages(chat_id, role, content, created_at) values(?, ?, ?, ?)", [
      chatId,
      role,
      JSON.stringify({ role, parts, meta }),
      createdAt ?? Date.now(),
    ]);
  },
  async finish(chatId, { createdAt, updatedAt }) {
    if (createdAt)
      await db.exec("update chats set created_at = ?, updated_at = ? where id = ?", [
        createdAt,
        updatedAt ?? createdAt,
        chatId,
      ]);
  },
  async discard(chatId) {
    await db.exec("delete from chats where id = ?", [chatId]);
  },
};

/** Adds an entry to the import history shown in Settings. */
export async function recordImport(source: ImportSource, chats: number, projects = 0) {
  const history = await getSetting<ImportRecord[]>("importHistory", []);
  history.unshift({ source, at: Date.now(), chats, projects });
  await setSetting("importHistory", history.slice(0, 20));
}
