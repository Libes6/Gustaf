// Pure helpers for the import list: search and the cap on how many rows are rendered.
import type { SourceSession } from "../api.ts";

/** Rows rendered at once; a longer match list asks for a narrower search instead. */
export const LIST_LIMIT = 200;

/** Case-insensitive match of every word of `query` against title, project path and id. */
export function filterSessions<T extends Pick<SourceSession, "title" | "projectPath" | "id">>(
  list: T[],
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((s) => {
    const hay = `${s.title}\n${s.projectPath ?? ""}\n${s.id}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Ids that can still be selected (not imported yet), for "select all shown". */
export const selectable = <T extends { id: string }>(list: T[], imported: Set<string>) =>
  list.filter((s) => !imported.has(s.id));
