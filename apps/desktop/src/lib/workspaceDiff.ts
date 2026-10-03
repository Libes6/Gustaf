// Pure helpers for showing a workspace's changes (components/WorkspaceChanges.tsx). Tested in tests/workspaces.test.mjs.

/** `path` (relative to the repository) as a path relative to the project folder, or null when it is outside it. */
export function relativeToProject(path: string, prefix: string): string | null {
  const p = prefix.replace(/^\/+|\/+$/g, "");
  if (!p) return path;
  return path.startsWith(`${p}/`) ? path.slice(p.length + 1) : null;
}

/** A diff-looking text for a file git does not know yet: every line is an addition. */
export function untrackedDiffText(content: string): string {
  const lines = content.replace(/\n$/, "").split("\n");
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
}
