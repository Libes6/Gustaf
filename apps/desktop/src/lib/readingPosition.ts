// Reading position per chat across restarts (T13): the distance from the bottom of the feed, kept in localStorage
// (a per-device convenience; losing it only means the chat opens at the end, as before).
const KEY = "gustaf-reading";
const LIMIT = 200;

type Positions = Record<string, number>;
const read = (): Positions => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
};

/** Pixels from the bottom when the chat was last left, or null (at the end / never opened). */
export function savedPosition(chatId: number): number | null {
  const v = read()[chatId];
  return typeof v === "number" && v > 40 ? v : null;
}

export function savePosition(chatId: number, fromBottom: number) {
  try {
    const all = read();
    delete all[chatId];
    if (fromBottom > 40) all[chatId] = Math.round(fromBottom);
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - LIMIT))) delete all[k];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}
