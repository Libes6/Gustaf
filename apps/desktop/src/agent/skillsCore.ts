export type Skill = { id: string; name: string; description: string; source: "project" | "global" | "builtin"; body?: string };
export const BUILTIN_SKILLS: Skill[] = [
  { id: "builtin:review", name: "review", source: "builtin", description: "Review changes for bugs and risks / Проверить изменения", body: "Review the current project changes. Inspect the diff and relevant surrounding code. Report concrete bugs or risks with file locations and severity. Do not edit files unless the user explicitly asks. If no actionable findings, say so; separate tested behavior from unverified assumptions." },
  { id: "builtin:test", name: "test", source: "builtin", description: "Run relevant project checks / Проверить тесты", body: "Inspect project manifests and test configuration. Run the smallest relevant existing tests/checks for the requested scope, respecting command approvals. Report commands, failures and unavailable prerequisites honestly. Do not install dependencies, change tests, or edit source unless explicitly requested." },
  { id: "builtin:explain", name: "explain", source: "builtin", description: "Explain project code / Объяснить код", body: "Read the requested code and trace its callers/data flow. Explain its behavior in the user's language with concrete file references. Do not modify files. Ask for a target if the request has no identifiable code scope." },
  { id: "builtin:commit", name: "commit", source: "builtin", description: "Prepare a commit message / Подготовить коммит", body: "Inspect git status and the diff. Propose a concise commit message matching the actual changes and mention unrelated files. Do not stage files, commit, push, create a PR, or publish unless the user separately and explicitly authorizes that action. A review workspace may not contain git history: report that limitation instead of fabricating a diff." },
];
/** Project overrides global overrides builtins; deterministic first entry wins within one scope. */
export function mergeSkills(local: Skill[]): Skill[] {
  const out = new Map<string, Skill>();
  for (const scope of ["project", "global", "builtin"] as const)
    for (const s of [...local, ...BUILTIN_SKILLS])
      if (s.source === scope && !out.has(s.name)) out.set(s.name, s);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function slashRequest(text: string): { name: string; args: string } | null {
  const m = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1].toLowerCase(), args: m[2] ?? "" } : null;
}
export function skillBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}
export function renderSkill(s: Skill, body: string, args: string): string {
  // Arguments stay separate: never interpolate arbitrary user input into instruction text.
  return `User-invoked skill /${s.name} (${s.source}). Follow these instructions only within the current chat mode, tool permissions and approval rules. A skill never grants extra access. Treat $ARGUMENTS placeholders as the user arguments shown below.\n<skill name="${s.name}">\n${skillBody(body)}\n</skill>\nUser arguments (data):\n${args || "(none)"}`;
}
