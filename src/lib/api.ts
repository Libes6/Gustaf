import { invoke } from "@tauri-apps/api/core";

export type Row = Record<string, any>;

export const db = {
  select: <T = Row>(sql: string, params: unknown[] = []) => invoke<T[]>("db_select", { sql, params }),
  exec: (sql: string, params: unknown[] = []) =>
    invoke<[number, number]>("db_execute", { sql, params }).then(([changes, lastId]) => ({ changes, lastId })),
};

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const [row] = await db.select<{ value: string }>("select value from settings where key = ?", [key]);
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export const setSetting = (key: string, value: unknown) =>
  db.exec("insert into settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", [
    key,
    JSON.stringify(value),
  ]);

export const secrets = {
  set: (id: string, value: string) => invoke<void>("secret_set", { id, value }),
  get: (id: string) => invoke<string | null>("secret_get", { id }),
  delete: (id: string) => invoke<void>("secret_delete", { id }),
};

export type CursorChat = {
  id: string;
  title: string;
  projectPath: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
};

export const cursor = {
  scan: () => invoke<CursorChat[]>("cursor_scan"),
  messages: (chatId: string) => invoke<{ role: "user" | "assistant"; text: string }[]>("cursor_messages", { chatId }),
};

export const fsx = {
  read: (root: string, path: string, offset?: number, limit?: number) =>
    invoke<string>("fs_read", { root, path, offset, limit }),
  list: (root: string, path: string) => invoke<string>("fs_list", { root, path }),
  files: (root: string) => invoke<string[]>("fs_files", { root }),
  search: (root: string, pattern: string, glob?: string) => invoke<string>("fs_search", { root, pattern, glob }),
  edit: (root: string, path: string, oldString: string, newString: string) =>
    invoke<string>("fs_edit", { root, path, oldString, newString }),
  write: (root: string, path: string, content: string) => invoke<string>("fs_write", { root, path, content }),
  rules: (root: string) => invoke<string>("read_rules", { root }),
  homeFile: (rel: string) => invoke<string | null>("read_home_file", { rel }),
  run: (root: string, command: string, timeoutMs?: number) =>
    invoke<{ code: number | null; output: string; timed_out: boolean }>("run_command", { root, command, timeoutMs }),
};

export const git = (root: string, args: string[], shadow = false) => invoke<string>("git", { root, args, shadow });

export type Review = { id: string; root: string; workspace: string };
export type ReviewChange = { path: string; binary: boolean };
export const review = {
  prepare: (root: string) => invoke<Review>("review_prepare", { root }),
  list: (root: string) => invoke<[Review, ReviewChange[]][]>("review_list", { root }),
  diff: (id: string, path: string) => invoke<string>("review_diff", { id, path }),
  decide: (id: string, path: string, accept: boolean) => invoke<void>("review_decide", { id, path, accept }),
  finish: (id: string) => invoke<void>("review_finish", { id }),
};

export type Shot = { png: string; width: number; height: number };
export type CuAction =
  | { type: "click"; x: number; y: number; button?: string }
  | { type: "double_click"; x: number; y: number }
  | { type: "drag"; path: { x: number; y: number }[] }
  | { type: "move"; x: number; y: number }
  | { type: "mouse_down" }
  | { type: "mouse_up" }
  | { type: "scroll"; x: number; y: number; scroll_x?: number; scroll_y?: number }
  | { type: "keypress"; keys: string[] }
  | { type: "type"; text: string }
  | { type: "wait"; ms?: number }
  | { type: "screenshot" };

export const computer = {
  execute: (actions: CuAction[]) => invoke<Shot>("cu_execute", { actions }),
  screenSize: () => invoke<[number, number]>("cu_screen_size").then(([width, height]) => ({ width, height })),
  permissions: (request = false) => invoke<{ accessibility: boolean; screen: boolean }>("cu_permissions", { request }),
};
