import { cursor, db, fsx, getSetting, setSetting } from "./api";
import type { Msg } from "../providers/types";
import { createDraftSaver, parseDraft, parseScope, type Draft, type DraftWrite } from "./chatSessions";

export type Project = { id: number; name: string; path: string | null; pinned: number; created_at: number };
export type Chat = {
  id: number;
  project_id: number | null;
  title: string;
  archived: number;
  created_at: number;
  updated_at: number;
};
export type StoredMsg = Msg & { id: number; chat_id: number; created_at: number };

export const listProjects = () =>
  db.select<Project>("select * from projects order by pinned desc, created_at desc");

export const listChats = () =>
  db.select<Chat>("select * from chats where archived = 0 order by updated_at desc");

export const listArchived = () => db.select<Chat>("select * from chats where archived = 1 order by updated_at desc");

export async function createProject(name: string, path: string | null, sourceId: string | null = null) {
  const r = await db.exec("insert or ignore into projects(name, path, source_id, created_at) values(?, ?, ?, ?)", [
    name,
    path,
    sourceId,
    Date.now(),
  ]);
  if (r.changes) return r.lastId;
  const [row] = await db.select<{ id: number }>("select id from projects where source_id = ?", [sourceId]);
  return row.id;
}

export async function createChat(projectId: number | null, title: string) {
  const now = Date.now();
  const r = await db.exec("insert into chats(project_id, title, created_at, updated_at) values(?, ?, ?, ?)", [
    projectId,
    title,
    now,
    now,
  ]);
  return r.lastId;
}

export async function loadMessages(chatId: number): Promise<StoredMsg[]> {
  const rows = await db.select("select * from messages where chat_id = ? order by id", [chatId]);
  return rows.map((r) => ({ ...JSON.parse(r.content), id: r.id, chat_id: r.chat_id, created_at: r.created_at }));
}

export async function addMessage(chatId: number, msg: Msg) {
  const now = Date.now();
  const { role, parts, meta } = msg;
  const plain: Msg = { role, parts, meta };
  const r = await db.exec("insert into messages(chat_id, role, content, created_at) values(?, ?, ?, ?)", [
    chatId,
    msg.role,
    JSON.stringify(plain),
    now,
  ]);
  await db.exec("update chats set updated_at = ? where id = ?", [now, chatId]);
  return r.lastId;
}

export const deleteMessagesFrom = (chatId: number, fromId: number) =>
  db.exec("delete from messages where chat_id = ? and id >= ?", [chatId, fromId]);

export const renameChat = (id: number, title: string) => db.exec("update chats set title = ? where id = ?", [title, id]);
export const archiveChat = (id: number, archived = true) =>
  db.exec("update chats set archived = ? where id = ?", [archived ? 1 : 0, id]);
export const archiveProjectChats = (projectId: number) =>
  db.exec("update chats set archived = 1 where project_id = ?", [projectId]);
export const removeProject = (id: number) => db.exec("delete from projects where id = ?", [id]);
export const renameProject = (id: number, name: string) => db.exec("update projects set name = ? where id = ?", [name, id]);
export const togglePin = (id: number) => db.exec("update projects set pinned = 1 - pinned where id = ?", [id]);

/** Stored composer draft for a scope (see `draftScope`), or null when there is none. Corrupt rows read as empty. */
export async function loadDraft(scope: string): Promise<Draft | null> {
  const [row] = await db.select<{ text: string; attachments_json: string }>(
    "select text, attachments_json from drafts where scope = ?",
    [scope],
  );
  return row ? parseDraft(row.text, row.attachments_json) : null;
}

async function writeDraft(scope: string, row: DraftWrite | null) {
  if (!row) return db.exec("delete from drafts where scope = ?", [scope]);
  const { chatId, projectId } = parseScope(scope);
  const owner = [scope, chatId, projectId, row.text];
  // Without `attachments` the stored attachments stay as they are (new rows default to none).
  return row.attachments === undefined
    ? db.exec(
        "insert into drafts(scope, chat_id, project_id, text, updated_at) values(?, ?, ?, ?, ?) " +
          "on conflict(scope) do update set text = excluded.text, updated_at = excluded.updated_at",
        [...owner, Date.now()],
      )
    : db.exec(
        "insert into drafts(scope, chat_id, project_id, text, attachments_json, updated_at) values(?, ?, ?, ?, ?, ?) " +
          "on conflict(scope) do update set text = excluded.text, attachments_json = excluded.attachments_json, updated_at = excluded.updated_at",
        [...owner, row.attachments, Date.now()],
      );
}

/** Debounced draft writer shared by all composers; failures (e.g. the chat was just removed) are non-fatal. */
export const draftSaver = createDraftSaver(writeDraft, { onError: (e) => console.warn("draft not saved", e) });

export type ImportRecord = { source: string; at: number; chats: number; projects: number };
export type ImportProject = { path: string; name: string; chats: number; latest: number };

export async function scanCursor() {
  const chats = await cursor.scan();
  const byPath = new Map<string, ImportProject>();
  for (const c of chats) {
    if (!c.projectPath) continue;
    const p = byPath.get(c.projectPath) ?? {
      path: c.projectPath,
      name: c.projectPath.split("/").pop() || c.projectPath,
      chats: 0,
      latest: 0,
    };
    p.chats++;
    p.latest = Math.max(p.latest, c.updatedAt);
    byPath.set(c.projectPath, p);
  }
  const mcp = await fsx.homeFile(".cursor/mcp.json");
  const mcpServers = mcp ? Object.keys(JSON.parse(mcp).mcpServers ?? {}) : [];
  return { chats, projects: [...byPath.values()].sort((a, b) => b.latest - a.latest), mcpServers };
}

/** Idempotent: projects and chats are keyed by their Cursor ids, so re-running imports only new ones. */
export async function importFromCursor(paths: string[], onProgress?: (done: number, total: number) => void) {
  const { chats } = await scanCursor();
  const wanted = chats.filter((c) => c.projectPath && paths.includes(c.projectPath));
  let imported = 0;
  for (const [i, c] of wanted.entries()) {
    onProgress?.(i, wanted.length);
    const path = c.projectPath!;
    const projectId = await createProject(path.split("/").pop() || path, path, `cursor:${path}`);
    const r = await db.exec(
      "insert or ignore into chats(project_id, title, source_id, created_at, updated_at) values(?, ?, ?, ?, ?)",
      [projectId, c.title || "Untitled", `cursor:${c.id}`, c.createdAt, c.updatedAt],
    );
    if (!r.changes) continue;
    for (const m of await cursor.messages(c.id)) {
      await db.exec("insert into messages(chat_id, role, content, created_at) values(?, ?, ?, ?)", [
        r.lastId,
        m.role,
        JSON.stringify({ role: m.role, parts: [{ type: "text", text: m.text }], meta: { imported: "cursor" } }),
        c.updatedAt,
      ]);
    }
    imported++;
  }
  onProgress?.(wanted.length, wanted.length);
  const history = await getSetting<ImportRecord[]>("importHistory", []);
  history.unshift({ source: "cursor", at: Date.now(), chats: imported, projects: paths.length });
  await setSetting("importHistory", history.slice(0, 20));
  return imported;
}
