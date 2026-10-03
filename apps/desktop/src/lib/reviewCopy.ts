import { getSetting, setSetting } from "./api";

/** A chat's own choice about the review copy; absent = follow the global setting. */
export type ReviewOverride = "on" | "off";

/** Global default: off (the agent edits the project folder directly). */
export const REVIEW_COPY_DEFAULT = false;
export const REVIEW_COPY_KEY = "reviewCopy";
const OVERRIDES_KEY = "chatReviewOverrides";

/** Whether a chat run works in a shadow copy: the chat's override, else the global setting (off unless set to exactly true). */
export const resolveReviewCopy = (override: ReviewOverride | null | undefined, global: unknown): boolean =>
  override === "on" ? true : override === "off" ? false : global === true;

const normalize = (raw: unknown): Record<string, ReviewOverride> => {
  const out: Record<string, ReviewOverride> = {};
  if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) if (v === "on" || v === "off") out[k] = v;
  return out;
};

export async function loadReviewOverride(chatId: number): Promise<ReviewOverride | undefined> {
  return normalize(await getSetting<unknown>(OVERRIDES_KEY, {}).catch(() => ({})))[String(chatId)];
}

/** Stores (or, with undefined, clears) the chat's override. */
export async function saveReviewOverride(chatId: number, value: ReviewOverride | undefined): Promise<void> {
  const all = normalize(await getSetting<unknown>(OVERRIDES_KEY, {}).catch(() => ({})));
  if (value) all[String(chatId)] = value; else delete all[String(chatId)];
  await setSetting(OVERRIDES_KEY, all);
}
