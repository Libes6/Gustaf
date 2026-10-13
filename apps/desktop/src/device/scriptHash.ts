// A short stable hash of a script or source text, so a changed one becomes a new file and an old one is never run.

export function scriptHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
