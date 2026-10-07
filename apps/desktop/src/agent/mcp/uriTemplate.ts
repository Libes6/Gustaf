// RFC 6570 URI templates, levels 1 and 2 only, for MCP resource templates (`resources/templates/list`). A server's
// template plus arguments chosen by the model becomes a URI that is then read with `resources/read`, so the expansion is
// deliberately strict: it cannot change the scheme or the host of the template, and values cannot climb out of the
// directory the template points into. Pure: unit-tested in tests/mcpExtras.test.mjs.

export const MAX_TEMPLATE_URI = 2000;
export const MAX_TEMPLATE_ARG = 2048;

type Expression = { op: "" | "+" | "#"; name: string };
export type TemplatePart = string | Expression;
export type ParsedTemplate = {
  parts: TemplatePart[];
  variables: string[];
  /** Lower-case scheme, always a literal. */
  scheme: string;
  /** The literal authority (`""` for `file:///x`), `null` when the template has none (`urn:x`) or builds it from variables. */
  authority: string | null;
};

const SIMPLE = "\u0000";
const RESERVED = "\u0001";

/**
 * Parses a template limited to levels 1-2: literals, `{var}`, `{+var}` and `{#var}`. Everything else (other operators,
 * variable lists, `*` and `:n` modifiers, unbalanced braces) is refused, as is a template that does not start with a
 * literal scheme or lets a reserved expansion (`+`, `#`) land in the authority, where it could change the host.
 */
export function parseUriTemplate(template: string): ParsedTemplate {
  if (typeof template !== "string" || !template || template.length > MAX_TEMPLATE_URI)
    throw new Error("invalid URI template");
  const parts: TemplatePart[] = [];
  const variables: string[] = [];
  let lit = "";
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === "}") throw new Error("unsupported URI template: unbalanced }");
    if (c !== "{") {
      lit += c;
      continue;
    }
    const end = template.indexOf("}", i);
    if (end < 0) throw new Error("unsupported URI template: unbalanced {");
    const body = template.slice(i + 1, end);
    const op = body[0] === "+" || body[0] === "#" ? (body[0] as "+" | "#") : "";
    const name = op ? body.slice(1) : body;
    if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(name))
      throw new Error(
        `unsupported URI template expression {${body.slice(0, 40)}} (only {var}, {+var} and {#var} are supported)`,
      );
    if (lit) parts.push(lit);
    lit = "";
    parts.push({ op, name });
    if (!variables.includes(name)) variables.push(name);
    i = end;
  }
  if (lit) parts.push(lit);
  const first = parts[0];
  const m = typeof first === "string" ? /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(first) : null;
  if (!m) throw new Error("unsupported URI template: it must start with a literal scheme such as file:// or https://");
  const flat = parts.map((p) => (typeof p === "string" ? p : p.op ? RESERVED : SIMPLE)).join("");
  const after = flat.slice(m[0].length);
  let authority: string | null = null;
  if (after.startsWith("//")) {
    const auth = /^\/\/([^/?#]*)/.exec(after)![1];
    if (auth.includes(RESERVED))
      throw new Error(
        "unsupported URI template: a reserved expansion ({+var} or {#var}) is not allowed in the host part",
      );
    authority = auth.includes(SIMPLE) ? null : auth;
  }
  return { parts, variables, scheme: m[1].toLowerCase(), authority };
}

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const RESERVED_CHARS = /^[:/?#[\]@!$&'()*+,;=]$/;

/** Percent-encodes a value: unreserved characters stay; for `{+var}` / `{#var}` reserved ones and existing %XX triplets stay too. */
function encodeValue(v: string, reserved: boolean): string {
  let out = "";
  for (let i = 0; i < v.length;) {
    if (reserved && v[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(v.slice(i + 1, i + 3))) {
      out += v.slice(i, i + 3);
      i += 3;
      continue;
    }
    const ch = String.fromCodePoint(v.codePointAt(i)!);
    i += ch.length;
    if (UNRESERVED.test(ch) || (reserved && RESERVED_CHARS.test(ch))) out += ch;
    else
      out += [...new TextEncoder().encode(ch)].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
  }
  return out;
}

/** Whether a value contains a `.` or `..` path segment, also hidden behind one or two rounds of percent-decoding. */
function traverses(v: string): boolean {
  let cur = v;
  for (let i = 0; i < 3; i++) {
    if (cur.split(/[/\\]/).some((seg) => seg === ".." || seg === ".")) return true;
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return false;
    }
    if (next === cur) return false;
    cur = next;
  }
  return false;
}

/**
 * Expands a template with the given arguments. Every variable must be given and nothing else may be; values are strings
 * (numbers and booleans are converted) without control characters and without `.`/`..` path segments; simple expansion
 * percent-encodes everything but unreserved characters; the result must keep the template's scheme and its literal host.
 */
export function expandUriTemplate(template: string, args: unknown): string {
  const { parts, variables, scheme, authority } = parseUriTemplate(template);
  const a = args === undefined || args === null ? {} : args;
  if (typeof a !== "object" || Array.isArray(a)) throw new Error("arguments must be an object of variable values");
  const given = a as Record<string, unknown>;
  for (const k of Object.keys(given))
    if (!variables.includes(k))
      throw new Error(`unknown template variable "${k.slice(0, 40)}" (expected: ${variables.join(", ") || "none"})`);
  const values: Record<string, string> = {};
  for (const v of variables) {
    const raw = given[v];
    const val = typeof raw === "number" || typeof raw === "boolean" ? String(raw) : raw;
    if (typeof val !== "string") throw new Error(`template variable "${v}" is missing (a string is required)`);
    if (val.length > MAX_TEMPLATE_ARG) throw new Error(`template variable "${v}" is too long`);
    if (/[\u0000-\u001f\u007f]/.test(val)) throw new Error(`template variable "${v}" contains control characters`);
    if (traverses(val)) throw new Error(`template variable "${v}" contains a path traversal segment`);
    values[v] = val;
  }
  let out = "";
  for (const p of parts)
    out += typeof p === "string" ? p : (p.op === "#" ? "#" : "") + encodeValue(values[p.name], p.op !== "");
  if (out.length > MAX_TEMPLATE_URI) throw new Error("the expanded URI is too long");
  // Defence in depth: whatever the expansion did, the result must still be the template's scheme and literal host.
  let u: URL;
  try {
    u = new URL(out);
  } catch {
    throw new Error("the expanded URI is not a valid URI");
  }
  if (u.protocol !== `${scheme}:`) throw new Error("the expanded URI left the template's scheme");
  if (authority !== null) {
    const got = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(out)?.[1];
    if (got !== authority) throw new Error("the expanded URI left the template's host");
  }
  return out;
}
