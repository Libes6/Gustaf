import { parseFiles, type ArtifactFile } from "./modules.ts";

/** `code` is the raw fence body; `files` is that body split on `// file: path` markers (one App.tsx when unmarked). */
export type Artifact = { id: string; title: string; code: string; files: ArtifactFile[]; filesError?: string; complete: boolean };
export type Segment = { type: "text"; text: string } | { type: "canvas"; artifact: Artifact };

/** Only top-level fences are interpreted; examples inside longer fences stay Markdown. */
export function parseArtifacts(text: string): Segment[] {
  const lines = text.split("\n");
  const result: Segment[] = [];
  let plain: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/.exec(lines[i]);
    if (!opening) { plain.push(lines[i]); continue; }
    const fence = opening[1];
    let end = i + 1;
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
    while (end < lines.length && !closing.test(lines[end])) end++;
    if (!/^tsx-canvas(?:\s|$)/.test(opening[2].trim())) {
      plain.push(...lines.slice(i, Math.min(end + 1, lines.length)));
    } else {
      if (plain.length) result.push({ type: "text", text: plain.join("\n") });
      plain = [];
      const metadata = opening[2];
      const title = /\btitle="([^"\n]{1,160})"/.exec(metadata)?.[1] ?? "Canvas";
      const id = /\bid="([\w-]{1,80})"/.exec(metadata)?.[1] ?? title;
      const code = lines.slice(i + 1, end).join("\n");
      const { files, error } = parseFiles(code);
      result.push({ type: "canvas", artifact: { id, title, code, files, ...(error ? { filesError: error } : {}), complete: end < lines.length } });
    }
    i = end;
  }
  if (plain.length) result.push({ type: "text", text: plain.join("\n") });
  return result;
}

export const CANVAS_INSTRUCTIONS = `The app can render interactive React/TypeScript artifacts in a Canvas panel.
When the user requests an interactive visualization, calculator, small app or UI preview, emit a fenced block with this exact header:
\`\`\`tsx-canvas id="stable-artifact-id" title="Short descriptive title"
The body must be a complete TSX module with a default-exported React component. Close the fence.
For larger artifacts split the body into files: start with \`// file: App.tsx\` (the entry, default-exports the component), then \`// file: utils.ts\` etc. on their own lines; files import each other with relative paths such as "./utils". Every revision must repeat all files.
React is available globally as React; imports are supported ONLY from "react", "lucide-react" (icon components such as import { Heart } from "lucide-react") and relative paths to your own files. Use React hooks, inline styles or a <style> element, and SVG for charts. No Tailwind, other packages, external assets, network, storage, files or native APIs. The canvas runs offline in an isolated frame.
For revisions reuse the same id and return the entire updated module, not a patch. Previous versions remain in chat history. Use different ids for distinct artifacts. Do not use canvas fences for ordinary source-code explanations.
The user opens a completed artifact from its card. Never claim it was executed or tested unless you actually have that evidence. If the user shares a canvas error, return a corrected complete version with the same id.`;
