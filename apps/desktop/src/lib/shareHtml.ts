// "Share as HTML": one chat as a single self-contained page (no scripts, no network, strict CSP, light/dark/print).
// Pure (no Tauri, no DOM): the dialog (components/ShareHtmlDialog.tsx) loads the rows and saves the string. The content goes
// through the same whitelist and secret scrubbing as the JSON/Markdown export (exportChats.ts); Markdown is rendered with the
// app's own pipeline (react-markdown + remark-gfm + rehype-highlight, raw HTML in messages stays text) via renderToStaticMarkup.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { parseArtifacts } from "../canvas/artifacts";
import type { Part } from "../providers/types";
import {
  buildBundle, formatDate, partsInDisplayOrder, REDACTED, type ExportedChat, type ExportedMessage, type ExportSource, type MdLabels,
} from "./exportChats";

export type ShareLabels = MdLabels & {
  canvas: string;
  model: string;
  /** Contains `{date}`. */
  generated: string;
};
export const DEFAULT_SHARE_LABELS: ShareLabels = {
  exported: "Exported from Gustaf on {date}",
  project: "Project", created: "Created", updated: "Updated", messages: "Messages", chats: "Chats", user: "User", assistant: "Assistant",
  toolCall: "Tool", toolResult: "Result", noOutput: "(no output)", truncated: "… {chars} more characters not shown",
  status: { running: "Running", success: "Completed", error: "Failed", unknown: "Result not reported" },
  canvas: "Canvas", model: "Model", generated: "Shared from Gustaf on {date}",
};

/** Longest text of one message, one tool output and one tool argument block; the rest is replaced by a note. */
export const SHARE_TEXT_LIMIT = 200_000;
export const SHARE_OUTPUT_LIMIT = 6_000;
export const SHARE_ARGS_LIMIT = 4_000;

/** No network at all: nothing may load, nothing may run. Images are data: URIs. */
export const SHARE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

const rec = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

function clip(text: string, limit: number, L: ShareLabels): string {
  if (text.length <= limit) return text;
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}\n${L.truncated.replace("{chars}", String(text.length - end))}`;
}

// ---- Markdown -----------------------------------------------------------------------------------------------------

const MARKDOWN_COMPONENTS = {
  // Remote images would be a network request when the file is opened: show the alt text instead.
  img: ({ alt }: { alt?: string }) => createElement("span", { className: "img-omitted" }, alt ? `[image: ${alt}]` : "[image]"),
  a: ({ href, children }: { href?: string; children?: unknown }) => createElement("a", { href, rel: "noopener noreferrer" }, children as never),
};

/** The app's Markdown pipeline as static HTML. Raw HTML in the source is escaped; unsafe URL schemes are dropped by react-markdown. */
export function markdownToHtml(text: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm], rehypePlugins: [[rehypeHighlight, { detect: false, ignoreMissing: true }]], components: MARKDOWN_COMPONENTS as never },
      text,
    ),
  );
}

function textHtml(text: string, L: ShareLabels): string {
  const clipped = clip(text, SHARE_TEXT_LIMIT, L);
  return parseArtifacts(clipped)
    .map((seg) =>
      seg.type === "text"
        ? seg.text.trim() ? `<div class="md">${markdownToHtml(seg.text)}</div>` : ""
        : `<div class="card canvas"><div class="card-head">${escapeHtml(L.canvas)}: ${escapeHtml(seg.artifact.title)}</div><pre>${escapeHtml(seg.artifact.code)}</pre></div>`,
    )
    .join("");
}

// ---- Tool cards ---------------------------------------------------------------------------------------------------

function diffHtml(oldText: string, newText: string, L: ShareLabels): string {
  const lines = (t: string, sign: string, cls: string) => t.split("\n").map((l) => `<span class="${cls}">${sign} ${escapeHtml(l)}</span>`);
  const all = [...lines(oldText, "-", "del"), ...lines(newText, "+", "add")];
  const shown = all.length > 400 ? [...all.slice(0, 400), `<span class="note">${escapeHtml(L.truncated.replace("{chars}", String(all.length - 400)))}</span>`] : all;
  return `<pre class="diff">${shown.join("\n")}</pre>`;
}

function callHtml(args: unknown, computer: Extract<Part, { type: "tool_call" }>["computer"], L: ShareLabels): string {
  if (computer?.actions?.length) {
    const items = computer.actions.map((a: any) => `<li>${escapeHtml(`${a?.type ?? ""}${typeof a?.text === "string" ? ` ${JSON.stringify(a.text.slice(0, 200))}` : ""}`)}</li>`);
    return `<ul class="actions">${items.join("")}</ul>`;
  }
  if (args === undefined || args === null || (rec(args) && !Object.keys(args).length)) return "";
  const json = (v: unknown) => `<pre>${escapeHtml(clip(JSON.stringify(v, null, 2) ?? "", SHARE_ARGS_LIMIT, L))}</pre>`;
  if (!rec(args)) return json(args);
  const path = str(args.file_path) ? args.file_path : str(args.path) ? args.path : undefined;
  const { command, old_string, new_string, content, ...rest } = args;
  const out: string[] = [];
  if (str(command)) out.push(`<pre class="cmd">${escapeHtml(clip(command, SHARE_ARGS_LIMIT, L))}</pre>`);
  else if (str(old_string) && str(new_string)) {
    if (path) out.push(`<div class="path">${escapeHtml(path)}</div>`);
    out.push(diffHtml(clip(old_string, SHARE_ARGS_LIMIT, L), clip(new_string, SHARE_ARGS_LIMIT, L), L));
    delete rest.file_path;
    delete rest.path;
  } else if (str(content) && path) {
    out.push(`<div class="path">${escapeHtml(path)}</div><pre>${escapeHtml(clip(content, SHARE_ARGS_LIMIT, L))}</pre>`);
    delete rest.file_path;
    delete rest.path;
  } else return json(args);
  if (Object.keys(rest).length) out.push(json(rest));
  return out.join("");
}

type Result = Extract<Part, { type: "tool_result" }>;

function outputHtml(output: string | undefined, L: ShareLabels): string {
  return output?.trim() ? `<pre class="out">${escapeHtml(clip(output, SHARE_OUTPUT_LIMIT, L))}</pre>` : `<p class="muted">${escapeHtml(L.noOutput)}</p>`;
}

const imageSrc = (data: string): string | null => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  return `data:image/${data.startsWith("/9j/") ? "jpeg" : "png"};base64,${data}`;
};
const imageHtml = (data: string) => {
  const src = imageSrc(data);
  return src ? `<img src="${src}" alt="">` : "";
};

function card(name: string, status: string, kind: "ok" | "err" | "run" | "unk", inner: string): string {
  return `<div class="card tool ${kind}"><div class="card-head"><code>${escapeHtml(name)}</code><span class="badge ${kind}">${escapeHtml(status)}</span></div>${inner}</div>`;
}

function partHtml(p: Part, results: Map<string, Result>, used: Set<string>, L: ShareLabels): string {
  switch (p.type) {
    case "text":
      return textHtml(p.text, L);
    case "image":
      return imageHtml(p.data);
    case "tool_call": {
      const r = results.get(p.id);
      if (r) used.add(p.id);
      const kind = !r ? "unk" : r.isError ? "err" : "ok";
      const status = !r ? L.status.unknown : r.isError ? L.status.error : L.status.success;
      return card(p.name, status, kind, callHtml(p.args, p.computer, L) + (r ? outputHtml(r.output, L) + (r.image ? imageHtml(r.image) : "") : ""));
    }
    case "tool_result":
      if (used.has(p.id)) return "";
      return card(p.name || L.toolResult, p.isError ? L.status.error : L.status.success, p.isError ? "err" : "ok", outputHtml(p.output, L) + (p.image ? imageHtml(p.image) : ""));
    case "activity": {
      const kind = p.status === "success" ? "ok" : p.status === "error" ? "err" : p.status === "running" ? "run" : "unk";
      return card(p.name, L.status[p.status], kind, callHtml(p.args, undefined, L) + (p.output || p.status !== "running" ? outputHtml(p.output, L) : ""));
    }
  }
}

// ---- Document -----------------------------------------------------------------------------------------------------

const CSS = `:root{color-scheme:light dark;--bg:#fff;--text:#1f2328;--text2:#59636e;--border:#d1d9e0;--card:#f6f8fa;--code:#f6f8fa;--inline:#eff1f3;--user:#eef4ff;--accent:#0969da;--ok:#1a7f37;--err:#cf222e;--add:#dafbe1;--del:#ffebe9;--hl-keyword:#8250df;--hl-string:#1a7f37;--hl-number:#bc4c00;--hl-comment:#59636e;--hl-title:#0550ae;--hl-type:#953800}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--text:#e6edf3;--text2:#9198a1;--border:#30363d;--card:#151b23;--code:#151b23;--inline:#262c36;--user:#14233a;--accent:#4493f8;--ok:#3fb950;--err:#f85149;--add:#12261e;--del:#2d1618;--hl-keyword:#d2a8ff;--hl-string:#a5d6ff;--hl-number:#ffa657;--hl-comment:#9198a1;--hl-title:#79c0ff;--hl-type:#ffa657}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 20px 64px}header{border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:24px}
h1{font-size:24px;margin:0 0 8px;overflow-wrap:anywhere}.meta{color:var(--text2);font-size:13px;display:flex;flex-wrap:wrap;gap:4px 16px}
.msg{margin:0 0 20px}.msg>.who{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--text2);margin:0 0 6px}
.msg.user>.body{background:var(--user);border-radius:12px;padding:10px 14px}
.md{overflow-wrap:anywhere}.md p{margin:0 0 10px}.md ul,.md ol{padding-left:22px;margin:0 0 10px}.md h1,.md h2,.md h3{font-size:16px;margin:16px 0 8px}
.md a{color:var(--accent)}.md img{max-width:100%}.md blockquote{margin:0 0 10px;padding-left:12px;border-left:3px solid var(--border);color:var(--text2)}
.md table{border-collapse:collapse;display:block;overflow-x:auto;margin:0 0 10px}.md td,.md th{border:1px solid var(--border);padding:4px 8px}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.md code{background:var(--inline);padding:1px 5px;border-radius:5px}
pre{margin:0;padding:10px 14px;background:var(--code);border-radius:8px;overflow-x:auto;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre}.md pre{margin:0 0 12px;border:1px solid var(--border)}.md pre code{background:none;padding:0}
.card{border:1px solid var(--border);background:var(--card);border-radius:10px;margin:0 0 12px;overflow:hidden}.card pre{border-radius:0;background:transparent}
.card-head{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:6px 12px;font-size:12.5px;border-bottom:1px solid var(--border)}
.badge{font-size:11px;font-weight:600}.badge.ok{color:var(--ok)}.badge.err{color:var(--err)}.badge.run,.badge.unk{color:var(--text2)}
.path{padding:6px 14px 0;color:var(--text2);font:12px ui-monospace,Menlo,monospace;overflow-wrap:anywhere}.cmd::before{content:"$ ";color:var(--text2)}
.out{border-top:1px dashed var(--border);max-height:none}.muted,.note{color:var(--text2);margin:6px 12px}.actions{margin:6px 0;padding-left:30px}
.diff span{display:block;white-space:pre}.diff .add{background:var(--add)}.diff .del{background:var(--del)}.card img,.msg>.body>img{max-width:100%;display:block;margin:8px 0}
.img-omitted{color:var(--text2)}footer{margin-top:40px;border-top:1px solid var(--border);padding-top:12px;color:var(--text2);font-size:12px}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in{color:var(--hl-keyword)}.hljs-string,.hljs-attr{color:var(--hl-string)}.hljs-number,.hljs-literal{color:var(--hl-number)}
.hljs-comment{color:var(--hl-comment);font-style:italic}.hljs-title,.hljs-function{color:var(--hl-title)}.hljs-type,.hljs-class{color:var(--hl-type)}
@media print{:root{--bg:#fff;--text:#000;--card:#fff;--code:#f4f4f4;--user:#f4f4f4;--text2:#444}main{max-width:none;padding:0}pre{white-space:pre-wrap;overflow:visible}.card,.msg{break-inside:avoid-page}a{color:inherit}}`;

function messageHtml(m: ExportedMessage, results: Map<string, Result>, used: Set<string>, L: ShareLabels): string {
  const body = partsInDisplayOrder(m.role, m.parts).map((p) => partHtml(p, results, used, L)).join("");
  if (!body) return "";
  // Tool messages continue the assistant turn that requested them, so they get no heading of their own.
  if (m.role === "tool") return `<section class="msg tool"><div class="body">${body}</div></section>`;
  const who = m.role === "user" ? escapeHtml(L.user) : `${escapeHtml(L.assistant)}${m.meta?.model ? ` (${escapeHtml(m.meta.model)})` : ""}`;
  return `<section class="msg ${m.role}"><div class="who">${who}</div><div class="body">${body}</div></section>`;
}

/** The page for one already-cleaned (redacted) chat. */
export function renderShareDocument(chat: ExportedChat, exportedAt: string, L: ShareLabels = DEFAULT_SHARE_LABELS): string {
  const results = new Map<string, Result>();
  for (const m of chat.messages) for (const p of m.parts) if (p.type === "tool_result") results.set(p.id, p);
  const used = new Set<string>();
  const model = chat.messages.find((m) => m.role === "assistant" && m.meta?.model)?.meta?.model;
  const title = chat.title.replace(/\s+/g, " ").trim().slice(0, 200) || "Untitled";
  const facts = [
    chat.project && `${escapeHtml(L.project)}: ${escapeHtml(chat.project.name)}`,
    chat.createdAt && `${escapeHtml(L.created)}: ${escapeHtml(formatDate(chat.createdAt))}`,
    chat.updatedAt && `${escapeHtml(L.updated)}: ${escapeHtml(formatDate(chat.updatedAt))}`,
    model && `${escapeHtml(L.model)}: ${escapeHtml(model)}`,
    `${escapeHtml(L.messages)}: ${chat.messages.length}`,
  ].filter(Boolean) as string[];
  const body = chat.messages.map((m) => messageHtml(m, results, used, L)).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SHARE_CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head><body><main>
<header><h1>${escapeHtml(title)}</h1><div class="meta">${facts.map((f) => `<span>${f}</span>`).join("")}</div></header>
${body}
<footer>${escapeHtml(L.generated.replace("{date}", formatDate(exportedAt)))}</footer>
</main></body></html>
`;
}

const countMarkers = (s: string) => s.split(REDACTED).length - 1;

export type ShareResult = { html: string; redactions: number; messages: number };

/**
 * Builds the page for one chat. `redactions` is how many secrets the scrubbing replaced (for the review step before saving);
 * images are left out unless `includeImages`.
 */
export function buildShareHtml(source: ExportSource, options: { includeImages?: boolean; labels?: ShareLabels; now?: number } = {}): ShareResult {
  const L = options.labels ?? DEFAULT_SHARE_LABELS;
  const bundle = buildBundle([source], { includeImages: options.includeImages, now: options.now });
  const raw = buildBundle([source], { includeImages: options.includeImages, now: options.now, redact: false });
  const redactions = Math.max(0, countMarkers(JSON.stringify(bundle)) - countMarkers(JSON.stringify(raw)));
  const chat = bundle.chats[0];
  return { html: renderShareDocument(chat, bundle.exportedAt, L), redactions, messages: chat.messages.length };
}

/** Default file name for the save dialog. */
export function shareFileName(title: string): string {
  const base = Array.from(title.normalize("NFC").replace(/[\u0000-\u001f\\/:*?"<>|]+/g, " ").replace(/\s+/g, "-").replace(/^[.-]+/, ""))
    .slice(0, 60)
    .join("")
    .replace(/-+$/, "");
  return `${base || "chat"}.html`;
}
