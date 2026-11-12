// Guards interface copy that skips translation so Russian coverage only goes up.
// Dependency-free on purpose: CI runs it straight after checkout. HELP below
// says what counts and how to fix a violation; --check prints it on failure.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = NodePath.join(ROOT, "scripts/i18n-audit.baseline.json");
const HELP = `Usage:
  node scripts/i18n-audit.mjs            summary per surface and per file
  node scripts/i18n-audit.mjs --json     the same as JSON on stdout
  node scripts/i18n-audit.mjs --check    fail on strings or missing ru keys beyond the baseline
  node scripts/i18n-audit.mjs --update   shrink scripts/i18n-audit.baseline.json (--force to grow)

What counts: JSX text with letters; literal placeholder, title, aria-label, label,
description, alt and similar attributes, including RN accessibility props and
*Label/*Hint/*Title props (also {cond ? "A" : "B"} forms); title, description,
message and label fields with a capitalized English value in toast, notification,
alert, confirm and dialog calls; string arguments of alert/confirm/prompt calls.
Strings built elsewhere and passed in as variables are not seen.

Fixing a violation:
  web (apps/web/src): add the English text under a key in the en table of the
    matching apps/web/src/i18nMessages/*.ts file, the translation under the same key
    in ru, and render t("area.Component.key") from const t = useT().
  mobile (apps/mobile/src): wrap the English text in t("…") from src/i18n and add
    "English text": "Перевод" to apps/mobile/src/i18n/ru.json.
  Not interface copy (a brand or product name, a command, a code sample)? Put
    i18n-ignore in a comment on that line or the line above it.
  After translating, run --update so the baseline drops and stays down.
`;
const SURFACES = [
  { name: "web", dir: "apps/web/src" },
  { name: "mobile", dir: "apps/mobile/src" },
];
const WEB_TABLES = ["apps/web/src/i18n.ts", "apps/web/src/i18nMessages"];
const MOBILE_RU = "apps/mobile/src/i18n/ru.json";

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const EXCLUDED_FILE = [
  /\.d\.ts$/,
  /\.(test|spec|stories|story|testkit)\.[cm]?[jt]sx?$/,
  /\.gen\.[cm]?[jt]sx?$/,
  /(^|\/)(__tests__|__mocks__|test|tests|testing|fixtures|__fixtures__|generated)\//,
  /(^|\/)test-fixtures\.[jt]sx?$/,
  /(^|\/)i18nMessages\//,
  /(^|\/)i18n\//,
  /(^|\/)i18n\.[jt]sx?$/,
];

const VISIBLE_ATTRIBUTES = new Set([
  "placeholder",
  "title",
  "subtitle",
  "aria-label",
  "aria-description",
  "label",
  "description",
  "detail",
  "message",
  "tooltip",
  "alt",
]);
// actionLabel, accessibilityLabel, accessibilityHint, closeAccessibilityLabel, …
const VISIBLE_ATTRIBUTE_SUFFIX =
  /[a-z](Label|Hint|Title|Subtitle|Description|Placeholder|Message)$/;
const isVisibleAttribute = (name) =>
  VISIBLE_ATTRIBUTES.has(name) || VISIBLE_ATTRIBUTE_SUFFIX.test(name);
const CODE_ELEMENTS = new Set(["code", "kbd", "pre", "samp"]);
const NOTICE_FIELDS = new Set(["title", "description", "message", "label"]);
const NOTICE_CALLEE = /toast|notif|alert|confirm|dialog|snackbar/i;
const PROMPT_CALLEE = /(^|\.)(alert|confirm|prompt)$/;
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
  "instanceof",
]);
const CLOSERS = { "(": ")", "[": "]", "{": "}" };

// User-facing text: at least two letters in a row, not a URL, path, or code identifier.
export function isUserText(raw, { requireCapital = false, allowLowerWord = true } = {}) {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!/[A-Za-z]{2}/.test(text)) return false;
  if (/^(https?:|mailto:|file:|data:|www\.)/i.test(text)) return false;
  if (/^[{[<]/.test(text)) return false; // a JSON or markup sample
  if (requireCapital && !/^[^A-Za-z]*[A-Z]/.test(text)) return false;
  if (!/\s/.test(text)) {
    if (/[./\\_:#@=<>{}()[\]$]/.test(text) && !/^[A-Za-z][a-z']*[.:!?…]$/.test(text)) return false;
    if (/^[a-z]+[A-Z]/.test(text)) return false; // camelCase
    if (/^[a-z0-9-]+-[a-z0-9-]+$/.test(text)) return false; // kebab-case
    if (/^[A-Z0-9_]+$/.test(text) && text.includes("_")) return false; // CONSTANT_CASE
    if (!allowLowerWord && /^[a-z]/.test(text)) return false;
  }
  return true;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&[a-z]+;/gi, " ");
}

function unescapeJs(body) {
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_, esc) => {
    if (esc[0] === "u" && esc.length > 1) {
      return String.fromCodePoint(parseInt(esc.replace(/[u{}]/g, ""), 16));
    }
    if (esc[0] === "x" && esc.length === 3) return String.fromCharCode(parseInt(esc.slice(1), 16));
    return { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0", "\n": "" }[esc] ?? esc;
  });
}

const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
const isIdentChar = (c) => /[A-Za-z0-9_$]/.test(c);

// A small scanner for TS/TSX: it tracks strings, comments, regexes, templates
// and JSX well enough to tell copy from code without a parser dependency.
export function scanSource(src, { jsx = true } = {}) {
  const findings = [];
  const translated = [];
  const ignoredLines = new Set();
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === "\n") lineStarts.push(k + 1);
  const lineOf = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const report = (kind, text, index) => {
    const value = text.replace(/\s+/g, " ").trim();
    findings.push({ kind, text: value, line: lineOf(index) });
  };
  const noteComment = (start, end) => {
    if (src.slice(start, end).includes("i18n-ignore")) ignoredLines.add(lineOf(start));
  };

  let i = 0;

  const skipComment = () => {
    if (src[i] === "/" && src[i + 1] === "/") {
      const start = i;
      while (i < src.length && src[i] !== "\n") i++;
      noteComment(start, i);
      return true;
    }
    if (src[i] === "/" && src[i + 1] === "*") {
      const start = i;
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      noteComment(start, i);
      return true;
    }
    return false;
  };
  const skipSpace = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (!skipComment()) return;
    }
  };
  const readString = () => {
    const quote = src[i];
    const start = ++i;
    while (i < src.length && src[i] !== quote && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
    const body = src.slice(start, i);
    i++;
    return unescapeJs(body);
  };
  const skipTemplate = () => {
    i++;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "$" && src[i + 1] === "{") {
        i += 2;
        scanCode("}", null);
      } else i++;
    }
    i++;
  };
  const skipRegex = () => {
    i++;
    let inClass = false;
    while (i < src.length && src[i] !== "\n") {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "/" && !inClass) break;
      else {
        if (src[i] === "[") inClass = true;
        if (src[i] === "]") inClass = false;
        i++;
      }
    }
    i++;
    while (i < src.length && isIdentChar(src[i])) i++;
  };
  // Is the `<` at i the start of a JSX element (not a comparison or a generic)?
  const looksLikeJsx = () => {
    if (!jsx) return false;
    const c = src[i + 1];
    if (c === ">") return true;
    if (!isIdentStart(c ?? "")) return false;
    let k = i + 1;
    while (k < src.length && /[A-Za-z0-9_$.:-]/.test(src[k])) k++;
    const rest = src.slice(k, k + 12);
    if (/^\s*[,=]/.test(rest) || /^\s+extends\s/.test(rest)) return false;
    // `type F = <T>(x: T) => T`: a generic signature, not an element with "(" text.
    if (/^[A-Z]/.test(src[i + 1]) && /^\s*>\s*\(/.test(rest)) return false;
    return true;
  };

  // context: null for plain code; "child" or "attr" for a JSX expression container.
  function scanCode(stop, context) {
    const stack = [];
    let prev = { kind: "start", value: "" };
    let prev2 = null;
    let prev3 = null;
    let chain = "";
    let pending = null;
    const push = (token) => {
      if (pending) {
        if (token.kind === "punct" && pending.next.includes(token.value)) {
          report(pending.kind, pending.text, pending.index);
        }
        pending = null;
      }
      prev3 = prev2;
      prev2 = prev;
      prev = token;
    };
    const exprPosition = () =>
      prev.kind === "start" ||
      (prev.kind === "punct" && ![")", "]", "}"].includes(prev.value)) ||
      (prev.kind === "ident" && REGEX_KEYWORDS.has(prev.value));
    const nearestCall = () => {
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k].char === "(") return stack[k];
      return null;
    };

    while (i < src.length) {
      if (skipComment()) continue;
      const c = src[i];
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (stack.length === 0 && c === stop) {
        push({ kind: "punct", value: c });
        i++;
        return;
      }
      if (c === '"' || c === "'") {
        const index = i;
        const value = readString();
        const top = stack.at(-1);
        const call = nearestCall();
        let candidate = null;
        if (
          top?.char === "(" &&
          top.callee === "t" &&
          prev.kind === "punct" &&
          prev.value === "("
        ) {
          translated.push(value);
        } else if (
          context &&
          stack.length === 0 &&
          (prev.kind === "start" ||
            (prev.kind === "punct" && ["?", ":", "&&", "||", "??"].includes(prev.value))) &&
          isUserText(value, { allowLowerWord: context === "child" })
        ) {
          candidate = { kind: `jsx-${context}`, text: value, index, next: ["}", ":"] };
        } else if (
          prev.kind === "punct" &&
          prev.value === ":" &&
          prev2?.kind === "ident" &&
          NOTICE_FIELDS.has(prev2.value) &&
          prev3?.kind === "punct" &&
          ["{", ","].includes(prev3.value) &&
          top?.char === "{" &&
          call &&
          NOTICE_CALLEE.test(call.callee) &&
          isUserText(value, { requireCapital: true })
        ) {
          candidate = { kind: "notice-field", text: value, index, next: [",", "}"] };
        } else if (
          top?.char === "(" &&
          PROMPT_CALLEE.test(top.callee) &&
          prev.kind === "punct" &&
          ["(", ","].includes(prev.value) &&
          isUserText(value, { requireCapital: true })
        ) {
          candidate = { kind: "dialog-arg", text: value, index, next: [",", ")"] };
        }
        push({ kind: "str", value });
        // Report only when the string is the whole value: the next token decides.
        pending = candidate;
        continue;
      }
      if (c === "`") {
        skipTemplate();
        push({ kind: "str", value: "" });
        continue;
      }
      if (/[0-9]/.test(c)) {
        while (i < src.length && /[0-9A-Za-z_.]/.test(src[i])) i++;
        push({ kind: "num", value: "" });
        continue;
      }
      if (isIdentStart(c)) {
        const start = i;
        while (i < src.length && isIdentChar(src[i])) i++;
        const word = src.slice(start, i);
        chain =
          prev.kind === "punct" && (prev.value === "." || prev.value === "?.") && chain
            ? `${chain}.${word}`
            : word;
        push({ kind: "ident", value: word });
        continue;
      }
      if (c === "/" && exprPosition()) {
        skipRegex();
        push({ kind: "str", value: "" });
        continue;
      }
      if (c === "<" && exprPosition() && looksLikeJsx()) {
        scanJsxElement();
        push({ kind: "jsx", value: "" });
        continue;
      }
      if (c === "(" || c === "[" || c === "{") {
        stack.push({ char: c, callee: c === "(" && prev.kind === "ident" ? chain : "" });
        push({ kind: "punct", value: c });
        i++;
        continue;
      }
      if (c === ")" || c === "]" || c === "}") {
        while (stack.length > 0 && CLOSERS[stack.at(-1).char] !== c) stack.pop();
        stack.pop();
        push({ kind: "punct", value: c });
        i++;
        continue;
      }
      const op = /^(\?\?=?|\?\.(?![0-9])|=>|&&=?|\|\|=?|\.\.\.|[=!]==?|[-+*/%&|^<>]=?|.)/s.exec(
        src.slice(i, i + 4),
      )[0];
      i += op.length;
      push({ kind: "punct", value: op });
    }
  }

  function scanJsxAttributes() {
    for (;;) {
      skipSpace();
      const c = src[i];
      if (c === undefined) return false;
      if (c === "/" && src[i + 1] === ">") {
        i += 2;
        return false;
      }
      if (c === ">") {
        i++;
        return true;
      }
      if (c === "{") {
        i++;
        scanCode("}", null);
        continue;
      }
      const start = i;
      while (i < src.length && /[A-Za-z0-9_$:.-]/.test(src[i])) i++;
      if (i === start) {
        i++;
        continue;
      }
      const name = src.slice(start, i);
      skipSpace();
      if (src[i] !== "=") continue;
      i++;
      skipSpace();
      const visible = isVisibleAttribute(name);
      if (src[i] === '"' || src[i] === "'") {
        const index = i;
        const quote = src[i];
        const found = src.indexOf(quote, i + 1);
        const end = found === -1 ? src.length : found;
        const value = decodeEntities(src.slice(i + 1, end));
        i = end + 1;
        if (visible && isUserText(value, { allowLowerWord: false }))
          report("jsx-attr", value, index);
      } else if (src[i] === "{") {
        i++;
        scanCode("}", visible ? "attr" : null);
      } else if (src[i] === "<") {
        scanJsxElement();
      }
    }
  }

  // Text inside <code>, <kbd> and <pre> is a command or identifier, not copy.
  function scanJsxElement(quiet = false) {
    const nameStart = ++i;
    while (i < src.length && /[A-Za-z0-9_$.:-]/.test(src[i])) i++;
    const inCode = quiet || CODE_ELEMENTS.has(src.slice(nameStart, i));
    skipSpace();
    if (src[i] === "<") {
      // TS generic on a component: <Foo<Bar> ...>
      let depth = 0;
      do {
        if (src[i] === "<") depth++;
        if (src[i] === ">") depth--;
        i++;
      } while (i < src.length && depth > 0);
    }
    if (!scanJsxAttributes()) return;
    for (;;) {
      const start = i;
      while (i < src.length && src[i] !== "<" && src[i] !== "{") i++;
      const text = decodeEntities(src.slice(start, i));
      if (!inCode && isUserText(text)) report("jsx-text", text, start + text.search(/\S/));
      if (i >= src.length) return;
      if (src[i] === "{") {
        i++;
        scanCode("}", "child");
        continue;
      }
      if (src[i + 1] === "/") {
        const end = src.indexOf(">", i);
        i = end === -1 ? src.length : end + 1;
        return;
      }
      scanJsxElement(inCode);
    }
  }

  scanCode(null, null);
  return {
    findings: findings.filter(
      (finding) => !ignoredLines.has(finding.line) && !ignoredLines.has(finding.line - 1),
    ),
    translated,
  };
}

// Keys of each language table in a web message file: `en: { "key": ... }`.
export function parseMessageTables(src) {
  const tables = {};
  const header = /^\s{2,4}(en|ru):\s*\{\s*$/gm;
  for (let match = header.exec(src); match; match = header.exec(src)) {
    const lang = match[1];
    const keys = new Set();
    let depth = 1;
    let k = header.lastIndex;
    while (k < src.length && depth > 0) {
      const c = src[k];
      if (c === '"' || c === "'") {
        let end = k + 1;
        while (end < src.length && src[end] !== c) end += src[end] === "\\" ? 2 : 1;
        const value = src.slice(k + 1, end);
        let after = end + 1;
        while (/\s/.test(src[after] ?? "")) after++;
        if (depth === 1 && src[after] === ":") keys.add(value);
        k = end + 1;
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") depth--;
      k++;
    }
    tables[lang] = new Set([...(tables[lang] ?? []), ...keys]);
  }
  return tables;
}

function listFiles(dir) {
  const out = [];
  const walk = (abs) => {
    for (const entry of NodeFS.readdirSync(abs, { withFileTypes: true })) {
      const full = NodePath.join(abs, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (SOURCE_FILE.test(entry.name)) {
        out.push(NodePath.relative(ROOT, full).split(NodePath.sep).join("/"));
      }
    }
  };
  walk(NodePath.join(ROOT, dir));
  return out.sort();
}

export const isExcluded = (file) => EXCLUDED_FILE.some((pattern) => pattern.test(file));

export function audit() {
  const files = {};
  const totals = {};
  const mobileTranslated = new Set();
  for (const surface of SURFACES) {
    totals[surface.name] = { files: 0, strings: 0 };
    for (const file of listFiles(surface.dir)) {
      if (isExcluded(file)) continue;
      const src = NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8");
      const result = scanSource(src, { jsx: /\.[jt]sx$/.test(file) });
      if (surface.name === "mobile")
        for (const text of result.translated) mobileTranslated.add(text);
      if (result.findings.length === 0) continue;
      files[file] = result.findings;
      totals[surface.name].files++;
      totals[surface.name].strings += result.findings.length;
    }
  }

  const missingRu = { web: [], mobile: [] };
  for (const entry of WEB_TABLES) {
    const abs = NodePath.join(ROOT, entry);
    const tableFiles = NodeFS.statSync(abs).isDirectory()
      ? NodeFS.readdirSync(abs)
          .filter((name) => name.endsWith(".ts"))
          .map((name) => `${entry}/${name}`)
      : [entry];
    for (const file of tableFiles.sort()) {
      const tables = parseMessageTables(NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8"));
      for (const key of tables.en ?? []) {
        if (!tables.ru?.has(key)) missingRu.web.push(`${file}: ${key}`);
      }
    }
  }
  const ru = JSON.parse(NodeFS.readFileSync(NodePath.join(ROOT, MOBILE_RU), "utf8"));
  for (const text of [...mobileTranslated].sort()) {
    if (!Object.hasOwn(ru, text)) missingRu.mobile.push(text);
  }
  return { totals, files, missingRu };
}

const surfaceOf = (file) => SURFACES.find((surface) => file.startsWith(`${surface.dir}/`))?.name;

function withTotals(files, missingRu) {
  const totals = Object.fromEntries(
    SURFACES.map((surface) => [surface.name, { files: 0, strings: 0 }]),
  );
  for (const [file, strings] of Object.entries(files)) {
    const total = totals[surfaceOf(file)];
    total.files++;
    total.strings += strings.length;
  }
  return { totals, files, missingRu };
}

// Baseline entries are the sorted strings of each file; the per-file count is their length.
export function toBaseline(result) {
  const files = {};
  for (const [file, findings] of Object.entries(result.files)) {
    files[file] = findings.map((finding) => finding.text).sort();
  }
  return withTotals(files, result.missingRu);
}

// Items of `current` beyond those in `base`, compared as multisets of `key`.
function extra(current, base, key = (item) => item) {
  const left = new Map();
  for (const text of base) left.set(text, (left.get(text) ?? 0) + 1);
  return current.filter((item) => {
    const n = left.get(key(item)) ?? 0;
    if (n > 0) left.set(key(item), n - 1);
    return n === 0;
  });
}

// What --check rejects: files above their baseline count and new missing ru keys.
export function compare(baseline, result) {
  const grown = [];
  for (const [file, findings] of Object.entries(result.files)) {
    const allowed = baseline.files[file] ?? [];
    if (findings.length <= allowed.length) continue;
    grown.push({
      file,
      baseline: allowed.length,
      count: findings.length,
      added: extra(findings, allowed, (finding) => finding.text),
    });
  }
  const missing = {
    web: extra(result.missingRu.web, baseline.missingRu?.web ?? []),
    mobile: extra(result.missingRu.mobile, baseline.missingRu?.mobile ?? []),
  };
  return {
    grown,
    missing,
    ok: grown.length === 0 && missing.web.length === 0 && missing.mobile.length === 0,
  };
}

// --update keeps every entry at or below the baseline unless forced.
export function updateBaseline(baseline, result, force) {
  const next = toBaseline(result);
  if (force || !baseline) return next;
  const shrink = (now, old = []) => (now.length <= old.length ? now : old);
  const files = {};
  for (const [file, strings] of Object.entries(next.files)) {
    const kept = shrink(strings, baseline.files[file]);
    if (kept.length > 0) files[file] = kept;
  }
  return withTotals(files, {
    web: shrink(next.missingRu.web, baseline.missingRu?.web),
    mobile: shrink(next.missingRu.mobile, baseline.missingRu?.mobile),
  });
}

function printSummary(result) {
  const lines = [];
  for (const surface of SURFACES) {
    const total = result.totals[surface.name];
    lines.push(`${surface.name}: ${total.strings} untranslated strings in ${total.files} files`);
    const entries = Object.entries(result.files)
      .filter(([file]) => file.startsWith(`${surface.dir}/`))
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    for (const [file, findings] of entries) {
      lines.push(`  ${String(findings.length).padStart(4)}  ${file}`);
    }
  }
  lines.push(`web en keys missing in ru: ${result.missingRu.web.length}`);
  for (const key of result.missingRu.web) lines.push(`  ${key}`);
  lines.push(`mobile t() strings missing in ru.json: ${result.missingRu.mobile.length}`);
  for (const text of result.missingRu.mobile) lines.push(`  ${JSON.stringify(text)}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function readBaseline() {
  return NodeFS.existsSync(BASELINE_PATH)
    ? JSON.parse(NodeFS.readFileSync(BASELINE_PATH, "utf8"))
    : null;
}

function main(argv) {
  const result = audit();
  if (argv.includes("--update")) {
    const next = updateBaseline(readBaseline(), result, argv.includes("--force"));
    NodeFS.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    process.stdout.write(`Wrote ${NodePath.relative(ROOT, BASELINE_PATH)}\n`);
    return 0;
  }
  if (argv.includes("--check")) {
    const baseline = readBaseline();
    if (!baseline) {
      process.stderr.write("No baseline. Run node scripts/i18n-audit.mjs --update.\n");
      return 1;
    }
    const { grown, missing, ok } = compare(baseline, result);
    if (ok) {
      process.stdout.write(
        `i18n audit ok: web ${result.totals.web.strings}, mobile ${result.totals.mobile.strings} untranslated strings (at or below baseline).\n`,
      );
      return 0;
    }
    const lines = ["i18n audit failed. New untranslated interface copy:"];
    for (const entry of grown) {
      lines.push(`  ${entry.file} (${entry.baseline} -> ${entry.count})`);
      for (const finding of entry.added) {
        lines.push(
          `    ${entry.file}:${finding.line} ${finding.kind} ${JSON.stringify(finding.text)}`,
        );
      }
    }
    for (const key of missing.web) lines.push(`  missing ru key: ${key}`);
    for (const text of missing.mobile) {
      lines.push(`  missing in ${MOBILE_RU}: ${JSON.stringify(text)}`);
    }
    lines.push(
      "",
      HELP,
      "To accept them anyway (with a maintainer's agreement): node scripts/i18n-audit.mjs --update --force",
    );
    process.stderr.write(`${lines.join("\n")}\n`);
    return 1;
  }
  if (argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  printSummary(result);
  return 0;
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
