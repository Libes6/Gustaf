export type ChatSession = { key: string; chatId: number | null; projectId: number | null; busy?: boolean };
export type Sessions = { active: string; items: ChatSession[] };
export function openSession(state: Sessions, chatId: number | null, projectId: number | null, key: string): Sessions {
  const existing = state.items.find((s) =>
    chatId !== null ? s.chatId === chatId : s.chatId === null && !s.busy && s.projectId === projectId,
  );
  return existing
    ? { ...state, active: existing.key }
    : { active: key, items: [...state.items, { key, chatId, projectId }] };
}
export function promoteSession(state: Sessions, key: string, chatId: number): Sessions {
  return { ...state, items: state.items.map((s) => (s.key === key ? { ...s, chatId } : s)) };
}
export function isAuthError(message: string) {
  return /\b401\b|unauthori[sz]ed|failed to authenticate|oauth.*invalid|not logged in|authentication required|invalid.*api.?key/i.test(
    message,
  );
}

// ---- Composer drafts: persisted per chat in SQLite (`drafts` table, see src-tauri/src/db.rs) ----
// This module stays pure (no Tauri/DOM imports) so node tests can cover it; the SQL lives in data.ts.

/** An unsent composer: text plus attached images (base64 payloads, as the composer keeps them in memory). */
export type Draft = { text: string; images: string[] };
/** What is stored: attachments are a JSON array of `{ type: "image", data }`. */
export type DraftRow = { text: string; attachments: string };

/**
 * Persistence bounds. Only the stored copy is bounded; the composer itself keeps everything in memory.
 * Images cannot be trimmed, so an image over the per-image limit (or one that no longer fits the total/count
 * budget) is simply not persisted and will be missing after a restart. Over-long text is cut at `text` chars.
 */
export const DRAFT_LIMITS = {
  text: 200_000, // characters
  image: 3_000_000, // base64 characters per attachment (about 2.2 MB of image data)
  images: 8_000_000, // base64 characters across all attachments of one draft
  count: 8, // attachments per draft
} as const;

const EMPTY_ATTACHMENTS = "[]";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** `chat:<id>` for an existing chat, `new:<projectId>` (or `new:`) for a chat that does not exist yet. */
export function draftScope(chatId: number | null, projectId: number | null): string {
  return chatId !== null ? `chat:${chatId}` : `new:${projectId ?? ""}`;
}

export function parseScope(scope: string): { chatId: number | null; projectId: number | null } {
  const id = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
  return scope.startsWith("chat:")
    ? { chatId: id(scope.slice(5)), projectId: null }
    : { chatId: null, projectId: id(scope.slice(4)) };
}

export const isEmptyDraft = (d: Draft) => !d.text.trim() && d.images.length === 0;

/** Applies DRAFT_LIMITS; also reports what was left out so callers and tests can see it. */
export function boundDraft(d: Draft): Draft & { truncated: boolean; dropped: number } {
  let text = d.text;
  let truncated = false;
  if (text.length > DRAFT_LIMITS.text) {
    text = text.slice(0, DRAFT_LIMITS.text);
    // Never leave half of a surrogate pair at the cut.
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
    truncated = true;
  }
  const images: string[] = [];
  let total = 0;
  let dropped = 0;
  for (const data of d.images) {
    const ok =
      data.length > 0 &&
      data.length <= DRAFT_LIMITS.image &&
      images.length < DRAFT_LIMITS.count &&
      total + data.length <= DRAFT_LIMITS.images;
    if (!ok) {
      dropped++;
      continue;
    }
    images.push(data);
    total += data.length;
  }
  return { text, images, truncated, dropped };
}

/** The bounded stored form of a draft, or null when there is nothing worth keeping (the row is deleted). */
export function serializeDraft(d: Draft): DraftRow | null {
  const { text, images } = boundDraft(d);
  const bounded = { text, images };
  if (isEmptyDraft(bounded)) return null;
  return {
    text,
    attachments: images.length ? JSON.stringify(images.map((data) => ({ type: "image", data }))) : EMPTY_ATTACHMENTS,
  };
}

/** Tolerant reader for stored rows: malformed JSON or entries are dropped instead of breaking the composer. */
export function parseDraft(text: unknown, attachments: unknown): Draft | null {
  const images: string[] = [];
  if (typeof attachments === "string") {
    try {
      const list: unknown = JSON.parse(attachments);
      if (Array.isArray(list)) {
        for (const a of list) {
          const data =
            a && typeof a === "object" && (a as { type?: unknown }).type === "image"
              ? (a as { data?: unknown }).data
              : null;
          if (typeof data === "string" && data.length <= DRAFT_LIMITS.image && BASE64.test(data)) images.push(data);
        }
      }
    } catch {
      /* corrupt attachments are ignored; the text is still restored */
    }
  }
  const draft = boundDraft({ text: typeof text === "string" ? text : "", images });
  return isEmptyDraft(draft) ? null : { text: draft.text, images: draft.images };
}

/** `attachments` is omitted when it is unchanged since the last write, so typing never re-sends image payloads. */
export type DraftWrite = { text: string; attachments?: string };
export type DraftWriter = (scope: string, row: DraftWrite | null) => Promise<unknown>;

/**
 * Debounced, ordered, best-effort draft persistence.
 * - `schedule` coalesces rapid edits per scope and writes after `delayMs` of quiet.
 * - Writes run strictly one after another and are skipped when the stored row would not change.
 * - `seed` tells it what the database already holds (after loading); until a scope is seeded or written,
 *   it assumes nothing and writes in full.
 * - `clear` drops any pending edit and deletes the row (used on send); `flush` writes pending edits now.
 */
export function createDraftSaver(write: DraftWriter, opts: { delayMs?: number; onError?: (e: unknown) => void } = {}) {
  const delayMs = opts.delayMs ?? 400;
  const pending = new Map<string, { draft: Draft; timer: ReturnType<typeof setTimeout> }>();
  const stored = new Map<string, DraftRow | null>();
  let chain: Promise<unknown> = Promise.resolve();

  const enqueue = (job: () => Promise<unknown>) => (chain = chain.then(job).catch((e) => opts.onError?.(e)));

  const commit = (scope: string, draft: Draft | null) => {
    const next = draft ? serializeDraft(draft) : null;
    return enqueue(async () => {
      const known = stored.has(scope);
      const prev = stored.get(scope) ?? null;
      if (known && prev?.text === next?.text && prev?.attachments === next?.attachments) return;
      if (!next) await write(scope, null);
      else {
        const same = known && (prev?.attachments ?? EMPTY_ATTACHMENTS) === next.attachments;
        await write(scope, same ? { text: next.text } : next);
      }
      stored.set(scope, next);
    });
  };

  const take = (scope: string) => {
    const p = pending.get(scope);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(scope);
    }
    return p?.draft;
  };

  return {
    schedule(scope: string, draft: Draft) {
      take(scope);
      pending.set(scope, {
        draft,
        timer: setTimeout(() => {
          pending.delete(scope);
          void commit(scope, draft);
        }, delayMs),
      });
    },
    seed(scope: string, draft: Draft | null) {
      stored.set(scope, draft ? serializeDraft(draft) : null);
    },
    clear(scope: string) {
      take(scope);
      return commit(scope, null);
    },
    async flush(scope?: string) {
      for (const s of scope === undefined ? [...pending.keys()] : [scope]) {
        const draft = take(s);
        if (draft) void commit(s, draft);
      }
      await chain;
    },
  };
}
