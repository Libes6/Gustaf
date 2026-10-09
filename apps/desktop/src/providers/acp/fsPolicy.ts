// Confinement of the agent's `fs/*` requests to the project folder. This is the lexical half: the path must be absolute,
// free of NUL bytes and, once `.` and `..` are resolved, inside the root. The host that really touches the disk repeats
// the check with real paths (`resolve_in_root` in src-tauri/src/tools.rs canonicalizes, so a symlink inside the project
// that points out is refused too). Pure, unit-tested in tests/acpClient.test.mjs.
import { AcpError, RPC } from "./rpc.ts";

const MAX_PATH = 4096;

const isWindowsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");

function split(p: string, windows: boolean): string[] {
  return (windows ? p.replace(/\\/g, "/") : p).split("/");
}

/** Resolves `.` and `..`; returns null when `..` climbs above the first segment. */
function normalize(parts: string[]): string[] | null {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out;
}

/**
 * The path relative to `root` (never empty-escaping), or an `AcpError` with the JSON-RPC "invalid params" code.
 * `root` is the project folder as the host knows it (absolute).
 */
export function confineToRoot(root: string, path: unknown): string {
  const invalid = (why: string): never => {
    throw new AcpError("rpc", why, { code: RPC.params });
  };
  if (typeof path !== "string" || !path || path.length > MAX_PATH) return invalid("a path is required");
  if (path.includes("\0")) return invalid("invalid path");
  const windows = isWindowsPath(root);
  if (windows !== isWindowsPath(path) || !(windows || path.startsWith("/")))
    return invalid("an absolute path is required");
  const base = normalize(split(root, windows));
  const target = normalize(split(path, windows));
  if (!base || !target) return invalid("the path is outside the project");
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (target.length < base.length || !base.every((seg, i) => same(seg, target[i])))
    return invalid("the path is outside the project");
  const rel = target.slice(base.length).join("/");
  return rel || ".";
}
