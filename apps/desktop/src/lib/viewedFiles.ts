// "Viewed" marks in the changes panel (T13): a file stays viewed until its change differs from when it was marked
// (the signature is the diff counts, or the review id for review-copy files). Per device, in localStorage.
const KEY = "gustaf-viewed";
const LIMIT = 500;
type Marks = Record<string, string>;
const read = (): Marks => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {}; } catch { return {}; } };
const id = (root: string, path: string) => `${root}\n${path}`;

export const isViewed = (root: string, path: string, signature: string) => read()[id(root, path)] === signature;

export function setViewed(root: string, path: string, signature: string, viewed: boolean) {
  try {
    const all = read();
    delete all[id(root, path)];
    if (viewed) all[id(root, path)] = signature;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - LIMIT))) delete all[k];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* storage unavailable */ }
}
