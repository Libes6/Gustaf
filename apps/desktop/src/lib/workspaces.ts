// Pure logic for chats that run in their own git worktree ("workspaces"; backend in src-tauri/src/worktree.rs, typed
// wrapper in lib/worktrees.ts). No React, no Tauri: Node runs this file directly in tests/workspaces.test.mjs, so only
// `import type` is allowed here.
import type { WorktreeInfo } from "./worktrees";

/** The link stored on a chat (`chats.workspace_*`). */
export type ChatWorkspace = { taskId: string; branch: string | null; base: string | null };
type LinkFields = { workspace_task_id?: string | null; workspace_branch?: string | null; workspace_base?: string | null };

/** The workspace a chat is linked to, or null for an ordinary chat. */
export function chatWorkspace(chat: LinkFields | null | undefined): ChatWorkspace | null {
  const id = chat?.workspace_task_id;
  if (typeof id !== "string" || !id) return null;
  return { taskId: id, branch: chat?.workspace_branch ?? null, base: chat?.workspace_base ?? null };
}

const SLUG_WORDS = 5;
const SLUG_CHARS = 40;

/**
 * Branch-name stem from the first words of a prompt or title: lowercase ascii words joined by `-`. Text without any
 * ascii letter or digit (for example Cyrillic) gives "task"; the backend sanitizes again and makes branches unique.
 */
export function slugFromText(text: string, maxWords = SLUG_WORDS): string {
  const words = String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const slug = words.slice(0, maxWords).join("-").slice(0, SLUG_CHARS).replace(/-+$/, "");
  return slug || "task";
}

/** `w<time in base 36>-<4 random chars>`: valid for the backend (letters, digits, `-`), different from every id in `taken`. */
export function newTaskId(taken: Iterable<string> = [], now = Date.now(), random: () => number = Math.random): string {
  const used = new Set(taken);
  const stem = `w${now.toString(36)}`;
  for (let i = 0; i < 1000; i++) {
    const id = `${stem}-${Math.floor(random() * 36 ** 4).toString(36).padStart(4, "0")}`;
    if (!used.has(id)) return id;
  }
  // Practically unreachable; stays unique anyway.
  let n = used.size;
  while (used.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

/** Project folder inside the checkout: a project in a repository subfolder (`prefix` = `sub/dir/`) lives at the same subfolder. */
export function joinCheckout(checkout: string, prefix: string | null | undefined): string {
  const rel = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  const base = checkout.replace(/[\\/]+$/, "");
  return rel ? `${base}/${rel}` : base;
}

export type ChatRoot =
  | { state: "project"; root: string | null }
  | { state: "workspace"; root: string; info: WorktreeInfo }
  /** The list of workspaces has not been read yet; do not run anything until it is. */
  | { state: "pending"; root: null }
  /** Linked, but the checkout is gone (archived or deleted): never fall back to the main checkout. */
  | { state: "missing"; root: null };

/**
 * The folder a chat works in. An ordinary chat uses its project folder, exactly as before. A chat linked to a workspace
 * uses that workspace's checkout (and nothing else): while it cannot be resolved the result has no root.
 * `known` is the project's workspace list, or undefined while it is loading.
 */
export function resolveChatRoot(o: { projectPath: string | null; workspace: ChatWorkspace | null; known: readonly WorktreeInfo[] | undefined; prefix?: string | null }): ChatRoot {
  if (!o.workspace) return { state: "project", root: o.projectPath };
  if (!o.known) return { state: "pending", root: null };
  const info = o.known.find((w) => w.taskId === o.workspace!.taskId);
  if (!info || !info.existsOnDisk) return { state: "missing", root: null };
  return { state: "workspace", root: joinCheckout(info.path, o.prefix), info };
}

export type WorkspaceRow = {
  chatId: number;
  title: string;
  taskId: string;
  branch: string;
  /** The checkout exists. False once archived or removed. */
  active: boolean;
  /** `null` until the first list arrived. */
  changedFiles: number | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  /** `↑2 ↓1`-style text, empty when level or unknown. */
  sync: string;
  /** Ahead of the base by nothing: deleting the branch loses no commits (offered with Archive). */
  mergedLike: boolean;
};

/** View model of one sidebar row: the chat joined with the live info of its workspace (when the list has it). */
export function workspaceRow(chat: { id: number; title: string } & LinkFields, info: WorktreeInfo | undefined, listed: boolean): WorkspaceRow | null {
  const ws = chatWorkspace(chat);
  if (!ws) return null;
  const active = !!info && info.existsOnDisk;
  const ahead = info?.ahead ?? null;
  const behind = info?.behind ?? null;
  const parts = [ahead ? `↑${ahead}` : "", behind ? `↓${behind}` : ""].filter(Boolean);
  return {
    chatId: chat.id,
    title: chat.title,
    taskId: ws.taskId,
    branch: info?.branch ?? ws.branch ?? ws.taskId,
    // Before the list arrived the row is shown as active (no flicker to "archived").
    active: listed ? active : true,
    changedFiles: info ? info.changedFiles : null,
    ahead,
    behind,
    dirty: !!info?.dirty,
    sync: parts.join(" "),
    mergedLike: !!info && ahead === 0 && !info.dirty,
  };
}

/** Splits the chats of a project into ordinary ones and workspace chats (order kept). */
export function splitWorkspaceChats<T extends LinkFields>(chats: readonly T[]): { plain: T[]; workspaces: T[] } {
  const plain: T[] = [];
  const workspaces: T[] = [];
  for (const c of chats) (chatWorkspace(c) ? workspaces : plain).push(c);
  return { plain, workspaces };
}

/** Archive options for a workspace given its live info: deleting the branch is offered only when nothing would be lost. */
export function archiveChoices(info: WorktreeInfo | undefined): { canArchive: boolean; offerDeleteBranch: boolean } {
  return { canArchive: !!info && info.existsOnDisk, offerDeleteBranch: !!info && info.existsOnDisk && info.ahead === 0 && !info.dirty };
}

/** `worktrees.list` is not re-read more often than this unless forced, and polled at most this often while a project is open. */
export const WORKSPACE_REFRESH_MS = 5000;
export const WORKSPACE_POLL_MS = 30_000;
