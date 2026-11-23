// @effect-diagnostics nodeBuiltinImport:off -- Diagnostics reads the tail of local log files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const LINE_CHARS = 4000;
const SECTION_BYTES = 100 * 1024;
const TRACE_TAIL_BYTES = 2 * 1024 * 1024;
const REDACTED = "[redacted]";

const SENSITIVE_KEYS = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "api-key",
  "authorization",
  "cookie",
  "credential",
  "private_key",
  "privatekey",
] as const;

const TOKEN_PREFIXES = [
  "sk-",
  "sk_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "glpat-",
  "xoxb-",
  "xoxp-",
  "gdt_",
  "AKIA",
  "AIza",
  "eyJ",
] as const;

const MIN_TOKEN_TAIL = 16;

function isWordChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    ch === "_" ||
    ch === "-"
  );
}

function isValueChar(ch: string): boolean {
  if (/\s/.test(ch)) return false;
  return !`"'\`,;&}])<>`.includes(ch);
}

function isTokenTailChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    ch === "_" ||
    ch === "-" ||
    ch === "."
  );
}

function isKnownToken(run: string): boolean {
  return TOKEN_PREFIXES.some((prefix) => {
    if (!run.startsWith(prefix)) return false;
    const rest = run.slice(prefix.length);
    if (rest.length < MIN_TOKEN_TAIL) return false;
    for (let i = 0; i < rest.length; i += 1) {
      if (!isTokenTailChar(rest[i]!)) return false;
    }
    return true;
  });
}

function secretValueStart(chars: readonly string[], startAt: number, key: string): number | null {
  let at = startAt;
  if (key === "bearer") {
    const start = at;
    while (at < chars.length && chars[at] === " ") at += 1;
    return at > start && at < chars.length && isValueChar(chars[at]!) ? at : null;
  }
  if (!SENSITIVE_KEYS.some((sensitive) => key.includes(sensitive))) {
    return null;
  }
  if (at < chars.length && (chars[at] === '"' || chars[at] === "'")) {
    at += 1;
  }
  while (at < chars.length && chars[at] === " ") at += 1;
  if (at >= chars.length || (chars[at] !== "=" && chars[at] !== ":")) {
    return null;
  }
  at += 1;
  while (at < chars.length && (chars[at] === " " || chars[at] === '"' || chars[at] === "'")) {
    at += 1;
  }
  if (at < chars.length && isValueChar(chars[at]!) && chars[at] !== "{" && chars[at] !== "[") {
    return at;
  }
  return null;
}

export function redactLine(line: string): string {
  const chars = Array.from(line);
  let out = "";
  let i = 0;
  while (i < chars.length) {
    if (!isWordChar(chars[i]!)) {
      out += chars[i]!;
      i += 1;
      continue;
    }
    let end = i;
    while (end < chars.length && isWordChar(chars[end]!)) end += 1;
    const word = chars.slice(i, end).join("");
    const lower = word.toLowerCase();
    const valueStart = secretValueStart(chars, end, lower);
    if (valueStart !== null) {
      let valueEnd = valueStart;
      while (valueEnd < chars.length && isValueChar(chars[valueEnd]!)) valueEnd += 1;
      // "Authorization: Bearer tok" — redact the full "Bearer tok" value.
      const prefixValue = chars.slice(valueStart, valueEnd).join("").toLowerCase();
      if (prefixValue === "bearer") {
        let next = valueEnd;
        while (next < chars.length && chars[next] === " ") next += 1;
        if (next > valueEnd && next < chars.length && isValueChar(chars[next]!)) {
          while (next < chars.length && isValueChar(chars[next]!)) next += 1;
          valueEnd = next;
        }
      }
      out += chars.slice(i, valueStart).join("");
      out += REDACTED;
      i = valueEnd;
      continue;
    }
    let tokenEnd = end;
    while (tokenEnd < chars.length && isTokenTailChar(chars[tokenEnd]!)) tokenEnd += 1;
    const tokenCandidate = chars.slice(i, tokenEnd).join("");
    if (isKnownToken(tokenCandidate)) {
      out += REDACTED;
      i = tokenEnd;
      continue;
    }
    out += word;
    i = end;
  }
  return out;
}

export function redactText(text: string, homeDir?: string): string {
  const normalized = homeDir && homeDir.length > 1 ? text.replaceAll(homeDir, "~") : text;
  return normalized.split("\n").map(redactLine).join("\n");
}

export function failedSpans(trace: string): string {
  return trace
    .split("\n")
    .filter((line) => line.includes('"exit":{"_tag":"Failure"'))
    .map((line) => line.slice(0, LINE_CHARS))
    .join("\n");
}

export function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  // Advance past UTF-8 continuation bytes (10xxxxxx).
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  const tail = buf.subarray(start).toString("utf8");
  const newline = tail.indexOf("\n");
  return newline >= 0 ? tail.slice(newline + 1) : tail;
}

function readFileTail(filePath: string, maxBytes: number): string | null {
  try {
    const stat = NodeFS.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    const fd = NodeFS.openSync(filePath, "r");
    try {
      const length = Math.min(stat.size, maxBytes);
      const offset = Math.max(0, stat.size - length);
      const buffer = Buffer.alloc(length);
      const bytesRead = NodeFS.readSync(fd, buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function collectDiagnostics(logDir: string, homeDir?: string): string | null {
  const desktopLog = readFileTail(NodePath.join(logDir, "desktop.log"), TRACE_TAIL_BYTES) ?? "";
  const serverTrace = readFileTail(NodePath.join(logDir, "server.trace.ndjson"), TRACE_TAIL_BYTES);
  const failures = serverTrace ? failedSpans(serverTrace) : "";

  const sections: Array<string> = [];
  for (const [title, text] of [
    ["Shell and server output", desktopLog],
    ["Recent failed server operations", failures],
  ] as const) {
    if (text.trim().length > 0) {
      const redacted = redactText(text, homeDir);
      sections.push(`== ${title} ==\n${tailBytes(redacted, SECTION_BYTES)}`);
    }
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}
