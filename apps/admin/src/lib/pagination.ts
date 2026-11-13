/**
 * Cursor pages visited so far. The API pages forward only, so going back means
 * remembering the cursors that led here; `null` is the first page.
 */
export type CursorTrail = ReadonlyArray<string | null>;

export const FIRST_PAGE: CursorTrail = [null];

export function currentCursor(trail: CursorTrail): string | null {
  return trail.at(-1) ?? null;
}

export function forward(trail: CursorTrail, nextCursor: string | null): CursorTrail {
  return nextCursor === null ? trail : [...trail, nextCursor];
}

export function back(trail: CursorTrail): CursorTrail {
  return trail.length > 1 ? trail.slice(0, -1) : trail;
}
