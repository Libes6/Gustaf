import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const MAX_HIGHLIGHTS = 7;
const conventional = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/;
const counted = new Set(["fix", "perf"]);

/** `feat(web): add X (#12)` -> `{ kind: "feature", text: "Add X" }`; unrelated titles -> null. */
export function classifyTitle(title) {
  const match = conventional.exec(title.trim());
  if (!match) return null;
  const type = match[1].toLowerCase();
  const text = match[2].replace(/\s*\(#\d+\)$/, "").trim();
  if (!text) return null;
  if (type === "feat") return { kind: "feature", text: text[0].toUpperCase() + text.slice(1) };
  if (counted.has(type)) return { kind: "fix", text };
  return null;
}

/** Titles newest first. The updater reads `- ` bullets and the closing `Plus N` line. */
export function generateNotes(titles) {
  const features = [];
  let fixes = 0;
  for (const title of titles) {
    const entry = classifyTitle(title);
    if (entry?.kind === "feature") features.push(entry.text);
    else if (entry?.kind === "fix") fixes++;
  }
  const lines = features.slice(0, MAX_HIGHLIGHTS).map((text) => `- ${text}`);
  if (fixes > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Plus ${fixes} bug ${fixes === 1 ? "fix" : "fixes"} and improvements.`);
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

/** A hand-written `docs/release-notes/<version>.md` wins over generated notes. */
export function releaseNotes({ override, titles }) {
  if (override !== undefined && override.trim()) return override.trimEnd() + "\n";
  return generateNotes(titles());
}

function gh(...args) {
  return NodeChildProcess.execFileSync("gh", ["api", ...args], { encoding: "utf8" });
}

/** PR titles merged between two tags, newest first, one per pull request. */
function mergedTitles(repo, previousTag, tag) {
  const commits = gh(
    "--paginate",
    `repos/${repo}/compare/${previousTag}...${tag}`,
    "--jq",
    '.commits[] | [.sha, (.commit.message | split("\\n")[0])] | @tsv',
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .reverse();
  const seen = new Set();
  const titles = [];
  for (const [sha, subject] of commits) {
    const pulls = JSON.parse(
      gh(
        `repos/${repo}/commits/${sha}/pulls`,
        "--jq",
        "[.[] | select(.merged_at) | [.number, .title]]",
      ),
    );
    if (pulls.length === 0) {
      titles.push(subject);
      continue;
    }
    for (const [number, title] of pulls) {
      if (seen.has(number)) continue;
      seen.add(number);
      titles.push(title);
    }
  }
  return titles;
}

if (
  process.argv[1] &&
  NodeFS.realpathSync(process.argv[1]) ===
    NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url))
) {
  const [version, previousTag, outFile] = process.argv.slice(2);
  if (!version || !outFile) {
    throw Error("Usage: release-notes.mjs <version> <previous-tag|''> <out-file>");
  }
  const repo = process.env.GITHUB_REPOSITORY || "Libes6/Gustaf";
  const overridePath = NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../../../docs/release-notes",
    `${version}.md`,
  );
  const notes = releaseNotes({
    override: NodeFS.existsSync(overridePath)
      ? NodeFS.readFileSync(overridePath, "utf8")
      : undefined,
    titles: () => (previousTag ? mergedTitles(repo, previousTag, `v${version}`) : []),
  });
  NodeFS.writeFileSync(outFile, notes);
}
