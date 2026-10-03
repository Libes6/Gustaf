// Pure chat export/import logic: no Tauri, no SQLite, no React. The UI (components/ImportPanel.tsx) loads rows,
// calls these functions and writes the result, so everything here is unit-testable under plain Node
// (tests/exportChats.test.mjs). Only `import type` is allowed because Node runs this file directly.
import type { Msg, Part, TokenUsage } from "../providers/types";

export const EXPORT_FORMAT = "mcode-chats";
/** Bump when the JSON shape changes incompatibly; `parseBundle` rejects newer versions. */
export const EXPORT_VERSION = 1;
export const REDACTED = "[REDACTED]";
export const IMAGE_OMITTED = "[image omitted]";
/** Markdown shows at most this many characters of one tool output or argument block; JSON keeps everything. */
export const MD_BLOCK_LIMIT = 4000;

export type ExportFormat = "markdown" | "json";
type Meta = NonNullable<Msg["meta"]>;

export type ExportedMessage = { role: Msg["role"]; createdAt?: number; parts: Part[]; meta?: Meta };
export type ExportedChat = {
  title: string;
  createdAt?: number;
  updatedAt?: number;
  archived: boolean;
  project: { name: string; path: string | null } | null;
  messages: ExportedMessage[];
};
// `app` stays "M Code": it is part of the file format, not a display name.
export type ChatBundle = { format: typeof EXPORT_FORMAT; version: number; app: "M Code"; exportedAt: string; chats: ExportedChat[] };

/** Rows as the app stores them (see `Chat`, `Project` and `StoredMsg` in lib/data.ts). */
export type ExportSource = {
  chat: { title: string; created_at: number; updated_at: number; archived?: number };
  project?: { name: string; path: string | null } | null;
  messages: (Msg & { created_at?: number })[];
};

const rec = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const ts = (v: unknown): number | undefined => (num(v) && v > 0 && v <= 8.64e15 ? Math.floor(v) : undefined);

// ---------------------------------------------------------------------------------------------------------------
// Secret redaction. API keys live in the macOS Keychain and are never part of a message, and exports copy only
// whitelisted fields. Tool output and arguments are free-form though (`cat .env`), so strings are also scrubbed
// with best-effort patterns and sensitive-looking object keys are blanked.

const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic (sk-ant-), OpenRouter (sk-or-v1-), project keys
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:npm|hf)_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];
const BEARER = /\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{16,}/g;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
// KEY=value, "apiKey": "value", Authorization: value ... (the value must be 6+ characters and not a placeholder).
const ASSIGNMENT =
  /((?:api[_-]?key|apikey|secret|token(?!s)|passw(?:or)?d|passwd|authorization|credentials?|private[_-]?key|access[_-]?key)[\w-]*["']?\s*[:=]\s*["']?)(?![\w.$-]*\()((?:(?:Bearer|Basic|Token)\s+)?[^\s"'`,;&)}\]]{6,})/gi;
const NOT_A_SECRET = /^(?:string|number|boolean|undefined|null|true|false|none|required|optional|any|object|unknown)$/i;
const SENSITIVE_KEY = /(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|authorization|credentials?|private[_-]?key|access[_-]?key)$/i;

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of TOKEN_PATTERNS) out = out.replace(p, REDACTED);
  out = out.replace(BEARER, (_, scheme: string, space: string) => `${scheme}${space}${REDACTED}`);
  out = out.replace(URL_CREDENTIALS, (_, head: string) => `${head}${REDACTED}@`);
  return out.replace(ASSIGNMENT, (whole, head: string, value: string) =>
    value.includes("[REDACTED") || NOT_A_SECRET.test(value) || /^[$<{%(*]/.test(value) ? whole : `${head}${REDACTED}`,
  );
}

/** Deep copy with every string scrubbed and every value under a sensitive-looking key blanked. */
export function redactValue<T>(value: T, depth = 0): T {
  if (str(value)) return redactSecrets(value) as T;
  if (depth > 24) return REDACTED as T;
  if (Array.isArray(value)) return value.map((x) => redactValue(x, depth + 1)) as T;
  if (rec(value)) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) if (k !== "__proto__") out[k] = str(v) && v && SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, depth + 1);
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Whitelisting. The same cleaners build the export and sanitize an imported file, so unknown fields never travel
// in either direction (for example `responseId` and `checkpoint` refer to this machine and are dropped).

type CleanOptions = { redact: boolean; images: boolean };
const STATUSES = ["running", "success", "error", "unknown"] as const;

function cleanPart(raw: unknown, o: CleanOptions): Part | null {
  if (!rec(raw)) return null;
  const s = (x: string) => (o.redact ? redactSecrets(x) : x);
  const v = <T>(x: T): T => (o.redact ? redactValue(x) : x);
  switch (raw.type) {
    case "text":
      return str(raw.text) ? { type: "text", text: s(raw.text) } : null;
    case "image":
      if (!str(raw.data) || !raw.data) return null;
      return o.images ? { type: "image", data: raw.data } : { type: "text", text: IMAGE_OMITTED };
    case "tool_call": {
      if (!str(raw.id) || !str(raw.name)) return null;
      const part: Extract<Part, { type: "tool_call" }> = { type: "tool_call", id: raw.id, name: raw.name, args: v(raw.args ?? {}) };
      if (rec(raw.computer) && Array.isArray(raw.computer.actions)) {
        part.computer = v({
          actions: raw.computer.actions,
          ...(Array.isArray(raw.computer.safetyChecks) ? { safetyChecks: raw.computer.safetyChecks } : {}),
        });
      }
      return part;
    }
    case "tool_result": {
      if (!str(raw.id)) return null;
      const part: Extract<Part, { type: "tool_result" }> = {
        type: "tool_result",
        id: raw.id,
        name: str(raw.name) ? raw.name : "",
        output: str(raw.output) ? s(raw.output) : "",
      };
      if (o.images && str(raw.image) && raw.image) part.image = raw.image;
      if (raw.isError === true) part.isError = true;
      if (raw.computer === true) part.computer = true;
      return part;
    }
    case "activity": {
      if (!str(raw.id) || !str(raw.name)) return null;
      const part: Extract<Part, { type: "activity" }> = {
        type: "activity",
        id: raw.id,
        name: raw.name,
        args: rec(raw.args) ? v(raw.args) : {},
        status: STATUSES.find((x) => x === raw.status) ?? "unknown",
      };
      if (str(raw.output)) part.output = s(raw.output);
      return part;
    }
    default:
      return null;
  }
}

function cleanUsage(raw: unknown): TokenUsage | undefined {
  if (!rec(raw)) return undefined;
  const keys = ["input", "output", "cached", "cacheWrite", "reasoning"] as const;
  if (!keys.every((k) => num(raw[k]) && raw[k] >= 0)) return undefined;
  return { input: raw.input, output: raw.output, cached: raw.cached, cacheWrite: raw.cacheWrite, reasoning: raw.reasoning };
}

function cleanMeta(raw: unknown): Meta | undefined {
  if (!rec(raw)) return undefined;
  const meta: Meta = {};
  if (str(raw.provider)) meta.provider = raw.provider.slice(0, 200);
  if (str(raw.model)) meta.model = raw.model.slice(0, 200);
  if (str(raw.imported)) meta.imported = raw.imported.slice(0, 50);
  if (num(raw.durationMs) && raw.durationMs >= 0) meta.durationMs = raw.durationMs;
  if (raw.compacted === true) meta.compacted = true;
  const usage = cleanUsage(raw.usage);
  if (usage) meta.usage = usage;
  return Object.keys(meta).length ? meta : undefined;
}

function cleanMessage(raw: unknown, o: CleanOptions): ExportedMessage | null {
  if (!rec(raw) || !(raw.role === "user" || raw.role === "assistant" || raw.role === "tool") || !Array.isArray(raw.parts)) return null;
  const parts = raw.parts.map((p: unknown) => cleanPart(p, o)).filter((p: Part | null): p is Part => p !== null);
  if (!parts.length) return null;
  const message: ExportedMessage = { role: raw.role, parts };
  const createdAt = ts(raw.created_at ?? raw.createdAt);
  if (createdAt) message.createdAt = createdAt;
  const meta = cleanMeta(raw.meta);
  if (meta) message.meta = meta;
  return message;
}

// ---------------------------------------------------------------------------------------------------------------
// JSON

/** `redact: false` is only for counting what redaction changes (the share dialog); never write such a bundle out. */
export function buildBundle(sources: ExportSource[], options: { includeImages?: boolean; now?: number; redact?: boolean } = {}): ChatBundle {
  const o: CleanOptions = { redact: options.redact !== false, images: options.includeImages === true };
  const s = (x: string) => (o.redact ? redactSecrets(x) : x);
  const chats = sources.map(({ chat, project, messages }): ExportedChat => {
    const exported: ExportedChat = {
      title: s(chat.title),
      archived: !!chat.archived,
      project: project ? { name: s(project.name), path: project.path ?? null } : null,
      messages: messages.map((m) => cleanMessage(m, o)).filter((m): m is ExportedMessage => m !== null),
    };
    const createdAt = ts(chat.created_at);
    const updatedAt = ts(chat.updated_at);
    return { ...exported, ...(createdAt ? { createdAt } : {}), ...(updatedAt ? { updatedAt } : {}) };
  });
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, app: "M Code", exportedAt: new Date(options.now ?? Date.now()).toISOString(), chats };
}

export const toJson = (bundle: ChatBundle) => `${JSON.stringify(bundle, null, 2)}\n`;

export type ImportErrorCode = "invalid_json" | "not_export" | "unsupported_version" | "empty" | "too_large";
export class ImportError extends Error {
  code: ImportErrorCode;
  constructor(code: ImportErrorCode) {
    super(code);
    this.name = "ImportError";
    this.code = code;
  }
}

function cleanChat(raw: unknown): ExportedChat | null {
  if (!rec(raw)) return null;
  const o: CleanOptions = { redact: false, images: true };
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .map((m: unknown) => cleanMessage(m, o))
    .filter((m: ExportedMessage | null): m is ExportedMessage => m !== null);
  if (!messages.length) return null;
  const chat: ExportedChat = {
    title: str(raw.title) && raw.title.trim() ? raw.title.trim().slice(0, 300) : "Untitled",
    archived: raw.archived === true,
    project:
      rec(raw.project) && str(raw.project.name) && raw.project.name.trim()
        ? { name: raw.project.name.trim().slice(0, 200), path: str(raw.project.path) && raw.project.path ? raw.project.path : null }
        : null,
    messages,
  };
  const createdAt = ts(raw.createdAt);
  const updatedAt = ts(raw.updatedAt);
  if (createdAt) chat.createdAt = createdAt;
  if (updatedAt) chat.updatedAt = updatedAt;
  return chat;
}

/** Validates and sanitizes an exported JSON document. Chats without any usable message are dropped. */
export function parseBundle(text: string): ChatBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new ImportError("invalid_json");
  }
  if (!rec(raw) || raw.format !== EXPORT_FORMAT || !Number.isInteger(raw.version) || raw.version < 1) throw new ImportError("not_export");
  if (raw.version > EXPORT_VERSION) throw new ImportError("unsupported_version");
  const chats = (Array.isArray(raw.chats) ? raw.chats : []).map(cleanChat).filter((c: ExportedChat | null): c is ExportedChat => c !== null);
  if (!chats.length) throw new ImportError("empty");
  return {
    format: EXPORT_FORMAT,
    version: raw.version,
    app: "M Code",
    exportedAt: str(raw.exportedAt) ? raw.exportedAt : "",
    chats,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Import into storage. The store is injected so this stays free of Tauri; ImportPanel builds one from lib/data.ts.

export type ChatStore = {
  /** Every chat already in the database, archived ones included. */
  existing(): Promise<{ title: string; created_at: number }[]>;
  /** Finds a matching project or creates one; `null` keeps the chat outside any project. */
  project(name: string, path: string | null): Promise<number | null>;
  createChat(projectId: number | null, title: string): Promise<number>;
  addMessage(chatId: number, msg: Msg): Promise<number>;
  /** Restores original timestamps and the archived flag after the messages were inserted. */
  stamp(
    chatId: number,
    chat: { createdAt?: number; updatedAt?: number; archived: boolean },
    messages: { id: number; createdAt?: number }[],
  ): Promise<void>;
  /** Removes a half-imported chat when inserting its messages failed. */
  discard(chatId: number): Promise<void>;
};
export type ImportResult = { imported: number; skipped: number; messages: number };

const chatKey = (title: string, createdAt: number) => `${createdAt}\u0000${title}`;

/** Re-importing the same file is harmless: a chat with the same title and creation time is skipped. */
export async function importBundle(
  bundle: ChatBundle,
  store: ChatStore,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const seen = new Set((await store.existing()).map((c) => chatKey(c.title, c.created_at)));
  const projects = new Map<string, Promise<number | null>>();
  const total = bundle.chats.length;
  let imported = 0;
  let skipped = 0;
  let messages = 0;
  for (const [i, chat] of bundle.chats.entries()) {
    onProgress?.(i, total);
    const key = chat.createdAt ? chatKey(chat.title, chat.createdAt) : null;
    if (key && seen.has(key)) {
      skipped++;
      continue;
    }
    let projectId: number | null = null;
    if (chat.project) {
      const pk = `${chat.project.name}\u0000${chat.project.path ?? ""}`;
      if (!projects.has(pk)) projects.set(pk, store.project(chat.project.name, chat.project.path));
      projectId = (await projects.get(pk)) ?? null;
    }
    const id = await store.createChat(projectId, chat.title);
    const stamps: { id: number; createdAt?: number }[] = [];
    try {
      for (const m of chat.messages) {
        stamps.push({ id: await store.addMessage(id, { role: m.role, parts: m.parts, meta: m.meta }), createdAt: m.createdAt });
      }
      await store.stamp(id, chat, stamps);
    } catch (e) {
      await store.discard(id).catch(() => {});
      throw e;
    }
    if (key) seen.add(key);
    imported++;
    messages += stamps.length;
  }
  onProgress?.(total, total);
  return { imported, skipped, messages };
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown

export type MdLabels = {
  /** Contains `{date}`. */
  exported: string;
  project: string;
  created: string;
  updated: string;
  messages: string;
  chats: string;
  user: string;
  assistant: string;
  toolCall: string;
  toolResult: string;
  noOutput: string;
  /** Contains `{chars}`. */
  truncated: string;
  status: Record<(typeof STATUSES)[number], string>;
};

export const DEFAULT_MD_LABELS: MdLabels = {
  exported: "Exported from Gustaf on {date}",
  project: "Project",
  created: "Created",
  updated: "Updated",
  messages: "Messages",
  chats: "Chats",
  user: "User",
  assistant: "Assistant",
  toolCall: "Tool call",
  toolResult: "Tool result",
  noOutput: "(no output)",
  truncated: "… {chars} more characters not shown",
  status: { running: "Running", success: "Completed", error: "Failed", unknown: "Result not reported" },
};

/** `YYYY-MM-DD HH:MM UTC`; UTC keeps exports reproducible across machines. */
export function formatDate(ms: number | string): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A fence long enough that backticks inside `body` cannot close it. */
function fence(info: string, body: string): string {
  const longest = (body.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}${info}\n${body}\n${f}`;
}

/** Closes a code fence the author left open so it cannot swallow the rest of the export. */
function closeOpenFence(text: string): string {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    if (!open) open = m[1];
    else if (m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = null;
  }
  return open ? `${text}\n${open}` : text;
}

function clip(text: string, L: MdLabels): string {
  if (text.length <= MD_BLOCK_LIMIT) return text;
  let end = MD_BLOCK_LIMIT;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // do not split a surrogate pair
  return `${text.slice(0, end)}\n${L.truncated.replace("{chars}", String(text.length - end))}`;
}

function callBody(args: unknown, computer: Extract<Part, { type: "tool_call" }>["computer"], L: MdLabels): string[] {
  if (computer?.actions?.length) {
    return [
      computer.actions
        .map((x: any) =>
          x.type === "type" ? `- type ${JSON.stringify(String(x.text ?? "").slice(0, 200))}` :
          x.type === "keypress" ? `- keypress ${Array.isArray(x.keys) ? x.keys.join("+") : ""}` :
          x.type === "drag" ? `- drag (${Array.isArray(x.path) ? x.path.length : 0} points)` :
          x.type === "open_app" ? `- open_app ${JSON.stringify(String(x.name ?? "").slice(0, 80))}` :
          `- ${x.type}${num(x.x) && num(x.y) ? ` ${x.x},${x.y}` : ""}`,
        )
        .join("\n"),
    ];
  }
  if (args === undefined || args === null || (rec(args) && !Object.keys(args).length)) return [];
  if (!rec(args)) return [fence("json", clip(JSON.stringify(args, null, 2), L))];
  const path = str(args.file_path) ? args.file_path : str(args.path) ? args.path : undefined;
  const { command, old_string, new_string, content, ...rest } = args;
  const out: string[] = [];
  if (str(command)) out.push(fence("sh", clip(command, L)));
  else if (str(old_string) && str(new_string)) {
    if (path) out.push(`\`${path}\``);
    const lines = (t: string, sign: string) => t.split("\n").map((l) => `${sign} ${l}`);
    out.push(fence("diff", clip([...lines(old_string, "-"), ...lines(new_string, "+")].join("\n"), L)));
    delete rest.file_path;
    delete rest.path;
  } else if (str(content) && path) {
    out.push(`\`${path}\``, fence("", clip(content, L)));
    delete rest.file_path;
    delete rest.path;
  } else return [fence("json", clip(JSON.stringify(args, null, 2), L))];
  if (Object.keys(rest).length) out.push(fence("json", clip(JSON.stringify(rest, null, 2), L)));
  return out;
}

function outputBlock(output: string | undefined, L: MdLabels): string {
  return output?.trim() ? fence("text", clip(output, L)) : `*${L.noOutput}*`;
}

/**
 * A sent message shows its pictures above the text, so the exports do the same. An omitted picture (the placeholder
 * text left by an export without images) counts as a picture. Other roles keep the order the model produced.
 */
export function partsInDisplayOrder(role: string, parts: Part[]): Part[] {
  if (role !== "user") return parts;
  const lead = (p: Part) => p.type === "image" || (p.type === "text" && p.text === IMAGE_OMITTED);
  return [...parts.filter(lead), ...parts.filter((p) => !lead(p))];
}

function renderPart(p: Part, L: MdLabels): string[] {
  switch (p.type) {
    case "text":
      return p.text.trim() ? [closeOpenFence(p.text.replace(/\s+$/, ""))] : [];
    case "image":
      return [`![image](data:image/png;base64,${p.data})`];
    case "tool_call":
      return [`**${L.toolCall}: \`${p.name}\`**`, ...callBody(p.args, p.computer, L)];
    case "tool_result":
      return [
        `**${L.toolResult}: \`${p.name}\`**${p.isError ? ` (${L.status.error})` : ""}`,
        outputBlock(p.output, L),
        ...(p.image ? [`![screenshot](data:image/png;base64,${p.image})`] : []),
      ];
    case "activity":
      return [
        `**${L.toolCall}: \`${p.name}\`** (${L.status[p.status]})`,
        ...callBody(p.args, undefined, L),
        ...(p.output || p.status !== "running" ? [outputBlock(p.output, L)] : []),
      ];
  }
}

function renderChat(chat: ExportedChat, level: number, L: MdLabels): { head: string[]; body: string[] } {
  const h = (n: number) => "#".repeat(Math.min(n, 6));
  const facts = [
    chat.project && `- ${L.project}: ${chat.project.name}${chat.project.path ? ` (${chat.project.path})` : ""}`,
    chat.createdAt && `- ${L.created}: ${formatDate(chat.createdAt)}`,
    chat.updatedAt && `- ${L.updated}: ${formatDate(chat.updatedAt)}`,
    `- ${L.messages}: ${chat.messages.length}`,
  ].filter(Boolean) as string[];
  const head = [`${h(level)} ${chat.title.replace(/\s+/g, " ").trim() || "Untitled"}`];
  const body = [facts.join("\n")];
  for (const m of chat.messages) {
    // Tool messages continue the assistant turn that requested them, so they get no heading of their own.
    if (m.role === "user") body.push(`${h(level + 1)} ${L.user}`);
    else if (m.role === "assistant") body.push(`${h(level + 1)} ${L.assistant}${m.meta?.model ? ` (${m.meta.model})` : ""}`);
    for (const p of partsInDisplayOrder(m.role, m.parts)) body.push(...renderPart(p, L));
  }
  return { head, body };
}

/** One chat becomes a document titled with the chat; several become one document with a section per chat. */
export function toMarkdown(bundle: ChatBundle, labels: MdLabels = DEFAULT_MD_LABELS): string {
  const note = `*${labels.exported.replace("{date}", formatDate(bundle.exportedAt))}*`;
  let blocks: string[];
  if (bundle.chats.length === 1) {
    const { head, body } = renderChat(bundle.chats[0], 1, labels);
    blocks = [...head, note, ...body];
  } else {
    blocks = ["# Gustaf", `${note}\n\n- ${labels.chats}: ${bundle.chats.length}`];
    for (const chat of bundle.chats) {
      const { head, body } = renderChat(chat, 2, labels);
      blocks.push("---", ...head, ...body);
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------

/** Default file name for the save dialog: the chat title for one chat, a dated name for several. */
export function exportFileName(format: ExportFormat, titles: string[], now = Date.now()): string {
  const ext = format === "json" ? "json" : "md";
  const clean = (s: string) =>
    Array.from(
      s
        .normalize("NFC")
        .replace(/[\u0000-\u001f\\/:*?"<>|]+/g, " ")
        .replace(/\s+/g, "-")
        .replace(/^[.-]+/, ""),
    )
      .slice(0, 60)
      .join("")
      .replace(/-+$/, "");
  const base = titles.length === 1 ? clean(titles[0]) || "chat" : `mcode-chats-${new Date(now).toISOString().slice(0, 10)}`;
  return `${base}.${ext}`;
}
