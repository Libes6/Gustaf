// Command rules for the agent's `run_command` tool: allow / ask / deny patterns, built-in deny defaults and the decision logic.
// Pure (no Tauri, no React) so it is unit-tested in tests/rules.test.mjs; persistence lives in rulesStore.ts.
//
// A command line is parsed into simple commands first and every simple command is judged on its own, so a rule for
// `git status` can never allow `git status && rm -rf x`. The parser splits at `;` `&&` `||` `|` `&`, newlines and
// parentheses, removes quotes and escapes, and looks into `$(…)`, backticks, `<(…)`, `bash -c "…"`, `eval`, heredocs for
// shells and into wrappers such as `sudo`, `env`, `xargs` and `find -exec`.
//
// This is a guardrail against obvious mistakes, not a sandbox: a command built at run time (`eval "$x"`, a script the
// project owns, `python -c …`) is judged by what its text says, not by what it will do.

export type Effect = "allow" | "ask" | "deny";
/** `exact` is only produced when old "always allowed" entries that are not a single simple command are migrated. */
export type MatchKind = "prefix" | "glob" | "exact";
export type Rule = {
  id: string;
  effect: Effect;
  match: MatchKind;
  pattern: string;
  /** Project folder; absent = all projects. */ project?: string;
};
export type RulesConfig = { version: 1; rules: Rule[]; disabledBuiltins: string[] };
export type Access = "readonly" | "auto" | "full";

export const COMMAND_RULES_SETTING = "commandRules";
export const MAX_RULES = 500;
export const MAX_PATTERN = 300;
const MAX_EXACT = 4000;
const MAX_COMMAND = 200_000;
const MAX_DEPTH = 6;
const MAX_SEGMENTS = 2000;

// ---------------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------------

export type Redirect = { op: string; target: string };
export type Segment = {
  /** Source text of the command (clipped), for display. */
  text: string;
  /** Words after quote removal; leading `VAR=value` assignments, redirections and shell keywords (`do`, `then`…) removed. */
  words: string[];
  assignments: string[];
  redirects: Redirect[];
  /** True when a redirection writes a file (other than /dev/null and friends). */
  writes: boolean;
  /** Programs (lowercase basenames) of the earlier commands of the same pipeline. */
  pipeFrom: string[];
  /** Programs of the commands inside `$(…)`, backticks and `<(…)` of this command, at any depth. */
  nested: string[];
  origin: "command" | "substitution" | "wrapper" | "script";
};
export type ParsedCommand = {
  raw: string;
  segments: Segment[];
  /** Set when the text could not be parsed completely. */ error?: string;
};

type Pending = { delim: string; quoted: boolean; strip: boolean; feedsShell: boolean; owner?: Segment };
type Cmd = {
  start: number;
  words: string[];
  redirects: Redirect[];
  heredocs: { delim: string; quoted: boolean; strip: boolean }[];
  hereString?: string;
  nested: string[];
};
type Ctx = { out: Segment[]; errors: string[] };

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "coproc"]);
const CLOSERS = new Set(["fi", "done", "esac", "}"]);
const WORD_END = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);
const NON_FILE_TARGET = /^\/dev\/(?:null|stdout|stderr|stdin|tty|fd\/\d+)$/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh", "ash"]);

const clip = (s: string, n = 500) => (s.length > n ? s.slice(0, n) + "…" : s);
const fail = (ctx: Ctx, message: string) => {
  if (!ctx.errors.includes(message)) ctx.errors.push(message);
};
/** Lowercase basename of a command word: `/usr/bin/Git` -> `git`. */
export const progName = (word: string | undefined) => (word ?? "").split("/").pop()!.toLowerCase();

/** `$'…'` with the escapes the shell decodes, so `$'\x72\x6d'` is seen as `rm`. */
function ansiC(ctx: Ctx, src: string, i: number): { text: string; end: number } {
  const simple = new Map<string, string>([
    ["n", "\n"],
    ["t", "\t"],
    ["r", "\r"],
    ["a", "\x07"],
    ["b", "\b"],
    ["e", "\x1b"],
    ["E", "\x1b"],
    ["f", "\f"],
    ["v", "\v"],
    ["\\", "\\"],
    ["'", "'"],
    ['"', '"'],
    ["?", "?"],
  ]);
  let j = i + 2;
  let text = "";
  while (j < src.length && src[j] !== "'") {
    if (src[j] === "\\" && j + 1 < src.length) {
      const d = src[j + 1];
      if (simple.has(d)) {
        text += simple.get(d);
        j += 2;
      } else if (d === "x") {
        const m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(j + 2, j + 4));
        text += m ? String.fromCharCode(parseInt(m[0], 16)) : "\\x";
        j += 2 + (m ? m[0].length : 0);
      } else if (/[0-7]/.test(d)) {
        const m = /^[0-7]{1,3}/.exec(src.slice(j + 1, j + 4))!;
        text += String.fromCharCode(parseInt(m[0], 8) & 255);
        j += 1 + m[0].length;
      } else if (d === "u" || d === "U") {
        const max = d === "u" ? 4 : 8;
        const m = new RegExp(`^[0-9a-fA-F]{1,${max}}`).exec(src.slice(j + 2, j + 2 + max));
        let ch = "\\" + d;
        if (m) {
          try {
            ch = String.fromCodePoint(parseInt(m[0], 16));
          } catch {
            ch = "?";
          }
        }
        text += ch;
        j += 2 + (m ? m[0].length : 0);
      } else {
        text += "\\" + d;
        j += 2;
      }
    } else text += src[j++];
  }
  if (j >= src.length) {
    fail(ctx, "unterminated $'…' string");
    return { text, end: src.length };
  }
  return { text, end: j + 1 };
}

/** Reads `$(…)`, `$((…))`, `${…}`, `$name` or `` `…` `` at `src[i]`; null when `src[i]` is a plain `$`. */
function expansion(
  ctx: Ctx,
  src: string,
  i: number,
  depth: number,
  nested: string[],
): { raw: string; end: number } | null {
  const n = src.length;
  const c = src[i];
  const d = src[i + 1];
  if (c === "$" && !(d === "(" || d === "{" || (d !== undefined && /[A-Za-z0-9_@*#?$!-]/.test(d)))) return null;
  if ((c === "`" || d === "(" || d === "{") && depth + 1 > MAX_DEPTH) {
    fail(ctx, "commands are nested too deeply");
    return { raw: src.slice(i), end: n };
  }
  if (c === "`") {
    let j = i + 1;
    while (j < n && src[j] !== "`") j += src[j] === "\\" ? 2 : 1;
    const closed = j < n;
    if (!closed) fail(ctx, "unterminated backtick");
    const body = src.slice(i + 1, closed ? j : n).replace(/\\([`$\\])/g, "$1");
    nested.push(...scriptAt(ctx, body, 0, null, depth + 1, "substitution").progs);
    const end = closed ? j + 1 : n;
    return { raw: src.slice(i, end), end };
  }
  if (d === "(" && src[i + 2] === "(") {
    // Arithmetic expansion: contents are not commands, but may contain substitutions.
    let j = i + 3;
    let level = 2;
    while (j < n && level > 0) {
      const ch = src[j];
      if (ch === "(") (level++, j++);
      else if (ch === ")") (level--, j++);
      else if (ch === "$" || ch === "`") j = expansion(ctx, src, j, depth, nested)?.end ?? j + 1;
      else if (ch === "'" || ch === '"') {
        const q = src.indexOf(ch, j + 1);
        j = q < 0 ? n : q + 1;
      } else j += ch === "\\" ? 2 : 1;
    }
    if (level > 0) fail(ctx, "unterminated arithmetic expansion");
    j = Math.min(j, n);
    return { raw: src.slice(i, j), end: j };
  }
  if (d === "(") {
    const r = scriptAt(ctx, src, i + 2, ")", depth + 1, "substitution");
    nested.push(...r.progs);
    return { raw: src.slice(i, r.end), end: r.end };
  }
  if (d === "{") {
    let j = i + 2;
    let level = 1;
    while (j < n && level > 0) {
      const ch = src[j];
      if (ch === "{") (level++, j++);
      else if (ch === "}") (level--, j++);
      else if (ch === "$" || ch === "`") j = expansion(ctx, src, j, depth, nested)?.end ?? j + 1;
      else if (ch === "'") {
        const q = src.indexOf("'", j + 1);
        j = q < 0 ? n : q + 1;
      } else if (ch === '"') j = scanDouble(ctx, src, j, depth, nested).end;
      else j += ch === "\\" ? 2 : 1;
    }
    if (level > 0) fail(ctx, "unterminated ${…}");
    j = Math.min(j, n);
    return { raw: src.slice(i, j), end: j };
  }
  if (/[A-Za-z_]/.test(d)) {
    let j = i + 2;
    while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
    return { raw: src.slice(i, j), end: j };
  }
  return { raw: src.slice(i, i + 2), end: i + 2 };
}

/** Reads a double-quoted string at `src[i]` (which is `"`); expansions inside are parsed for nested commands. */
function scanDouble(ctx: Ctx, src: string, i: number, depth: number, nested: string[]): { text: string; end: number } {
  let j = i + 1;
  let text = "";
  const n = src.length;
  while (j < n) {
    const c = src[j];
    if (c === '"') return { text, end: j + 1 };
    if (c === "\\") {
      const d = src[j + 1];
      if (d === undefined) ((text += "\\"), j++);
      else if (d === "\n") j += 2;
      else {
        text += '$`"\\'.includes(d) ? d : "\\" + d;
        j += 2;
      }
      continue;
    }
    if (c === "$" || c === "`") {
      const e = expansion(ctx, src, j, depth, nested);
      if (e) {
        text += e.raw;
        j = e.end;
        continue;
      }
    }
    text += c;
    j++;
  }
  fail(ctx, "unterminated double quote");
  return { text, end: n };
}

function readWord(
  ctx: Ctx,
  src: string,
  start: number,
  depth: number,
  nested: string[],
): { text: string; end: number; quoted: boolean } {
  const n = src.length;
  let i = start;
  let text = "";
  let quoted = false;
  while (i < n) {
    const c = src[i];
    if (WORD_END.has(c)) break;
    if (c === "\\") {
      const d = src[i + 1];
      if (d === undefined) ((text += c), i++);
      else if (d === "\n") i += 2;
      else {
        text += d;
        quoted = true;
        i += 2;
      }
    } else if (c === "'") {
      const e = src.indexOf("'", i + 1);
      quoted = true;
      if (e < 0) {
        fail(ctx, "unterminated single quote");
        text += src.slice(i + 1);
        i = n;
      } else {
        text += src.slice(i + 1, e);
        i = e + 1;
      }
    } else if (c === '"') {
      const r = scanDouble(ctx, src, i, depth, nested);
      text += r.text;
      i = r.end;
      quoted = true;
    } else if (c === "$" && src[i + 1] === "'") {
      const r = ansiC(ctx, src, i);
      text += r.text;
      i = r.end;
      quoted = true;
    } else if (c === "$" && src[i + 1] === '"') {
      i++; // $"…" is a quoted string too
    } else if (c === "$" || c === "`") {
      const e = expansion(ctx, src, i, depth, nested);
      if (e) ((text += e.raw), (i = e.end));
      else ((text += c), i++);
    } else text += src[i++];
  }
  return { text, end: i, quoted };
}

const isWrite = (r: Redirect) => {
  const op = r.op.replace(/^\d+/, "");
  if (op.includes(">")) return !(op.endsWith("&") && /^(?:\d+|-)$/.test(r.target)) && !NON_FILE_TARGET.test(r.target);
  return op === "<>";
};

// Wrappers run another command given in their arguments: the inner command is judged as well.
type WrapperSpec = { args?: readonly string[]; assign?: boolean; skip?: number };
const WRAPPERS = new Map<string, WrapperSpec>([
  ["sudo", { args: ["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-T", "-U", "-D", "-R"] }],
  ["doas", { args: ["-u", "-C"] }],
  ["env", { args: ["-u", "-C", "-S"], assign: true }],
  ["nice", { args: ["-n"] }],
  ["ionice", { args: ["-c", "-n", "-p"] }],
  ["nohup", {}],
  ["time", {}],
  ["command", {}],
  ["builtin", {}],
  ["exec", { args: ["-a"] }],
  ["timeout", { args: ["-s", "-k"], skip: 1 }],
  ["stdbuf", {}],
  ["setsid", {}],
  ["caffeinate", { args: ["-t", "-w"] }],
  ["xargs", { args: ["-I", "-n", "-P", "-L", "-s", "-E", "-d", "-a", "-J"] }],
  ["noglob", {}],
  ["nocorrect", {}],
]);
const EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

function unwrap(prog: string, words: string[]): string[] | null {
  const spec = WRAPPERS.get(prog);
  if (!spec) return null;
  if (prog === "command" && words.some((w) => w === "-v" || w === "-V")) return null; // only looks the command up
  let k = 1;
  while (k < words.length) {
    const w = words[k];
    if (w === "--") {
      k++;
      break;
    }
    if (spec.assign && ASSIGNMENT.test(w)) k++;
    else if (w.length > 1 && w.startsWith("-")) k += spec.args?.includes(w) ? 2 : 1;
    else break;
  }
  for (let s = spec.skip ?? 0; s > 0 && k < words.length; s--) k++;
  return k < words.length ? words.slice(k) : null;
}

function findExecs(words: string[]): string[][] {
  const out: string[][] = [];
  for (let k = 1; k < words.length; k++) {
    if (!EXEC_FLAGS.has(words[k])) continue;
    let e = k + 1;
    while (e < words.length && words[e] !== ";" && words[e] !== "+") e++;
    if (e > k + 1) out.push(words.slice(k + 1, e));
    k = e;
  }
  return out;
}

/** Commands started by `words` through wrappers (`sudo x`, `env A=1 x`, `xargs x`, `find -exec x`), at any depth. */
function innerCommands(words: string[], depth = 0): string[][] {
  if (depth > 4 || !words.length) return [];
  const prog = progName(words[0]);
  const direct = prog === "find" ? findExecs(words) : [unwrap(prog, words)].filter((w): w is string[] => !!w);
  return direct.flatMap((w) => [w, ...innerCommands(w, depth + 1)]);
}

/** Script text run by `sh -c "…"`, `bash -lc "…"` or `eval …`. */
function scriptOf(words: string[]): string | undefined {
  const prog = progName(words[0]);
  if (prog === "eval") return words.length > 1 ? words.slice(1).join(" ") : undefined;
  if (!SHELLS.has(prog)) return undefined;
  for (let k = 1; k < words.length; k++) {
    const w = words[k];
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w)) return words[k + 1];
    if (w === "-o" || w === "-O" || w === "+o") k++;
    else if (!w.startsWith("-") && !w.startsWith("+")) return undefined;
  }
  return undefined;
}

function buildSegments(
  ctx: Ctx,
  cmd: Cmd,
  src: string,
  end: number,
  pipe: string[],
  depth: number,
  origin: Segment["origin"],
): { main?: Segment; progs: string[]; feedsShell: boolean } {
  const words = [...cmd.words];
  const assignments: string[] = [];
  for (;;) {
    if (words.length && ASSIGNMENT.test(words[0])) assignments.push(words.shift()!);
    else if (words.length && KEYWORDS.has(words[0])) words.shift();
    else break;
  }
  const writes = cmd.redirects.some(isWrite);
  const empty = !words.length && !assignments.length && !cmd.redirects.length;
  if (empty || (words.length === 1 && CLOSERS.has(words[0]) && !assignments.length && !writes))
    return { progs: [], feedsShell: false };

  const main: Segment = {
    text: clip(src.slice(Math.max(cmd.start, 0), end).trim()),
    words,
    assignments,
    redirects: cmd.redirects,
    writes,
    pipeFrom: [...pipe],
    nested: cmd.nested,
    origin,
  };
  ctx.out.push(main);
  const progs: string[] = words.length ? [progName(words[0])] : [];
  const inner = words.length ? innerCommands(words) : [];
  for (const w of inner) {
    ctx.out.push({
      text: clip(w.join(" ")),
      words: w,
      assignments: [],
      redirects: [],
      writes: false,
      pipeFrom: [...pipe],
      nested: [],
      origin: "wrapper",
    });
    progs.push(progName(w[0]));
  }
  for (const w of words.length ? [words, ...inner] : []) {
    const script = scriptOf(w);
    if (script !== undefined && depth + 1 <= MAX_DEPTH)
      progs.push(...scriptAt(ctx, script, 0, null, depth + 1, "script").progs);
  }
  const feedsShell = (words.length ? [words, ...inner] : []).some((w) => SHELLS.has(progName(w[0])));
  if (cmd.hereString !== undefined && feedsShell && depth + 1 <= MAX_DEPTH)
    scriptAt(ctx, cmd.hereString, 0, null, depth + 1, "script");
  return { main, progs, feedsShell };
}

function scriptAt(
  ctx: Ctx,
  src: string,
  start: number,
  closer: ")" | null,
  depth: number,
  origin: Segment["origin"],
): { end: number; progs: string[] } {
  const n = src.length;
  if (depth > MAX_DEPTH) {
    fail(ctx, "commands are nested too deeply");
    return { end: n, progs: [] };
  }
  const progs: string[] = [];
  const pending: Pending[] = [];
  let cmd: Cmd = { start: -1, words: [], redirects: [], heredocs: [], nested: [] };
  let pipe: string[] = [];
  let parens = 0;
  let afterPipe = false;
  let i = start;

  const finish = (sep: string, at: number) => {
    // A pipe at the end of a line continues on the next one: `curl x |⏎sh` is still a download piped into a shell.
    if (sep === "\n" && afterPipe && cmd.start < 0) return;
    const built = buildSegments(ctx, cmd, src, at, pipe, depth, origin);
    for (const h of cmd.heredocs) pending.push({ ...h, feedsShell: built.feedsShell, owner: built.main });
    progs.push(...built.progs);
    afterPipe = sep === "|" || sep === "|&";
    // A subshell keeps the pipeline going too: `(curl x) | sh`.
    pipe = afterPipe || sep === "(" || sep === ")" ? [...pipe, ...built.progs] : [];
    cmd = { start: -1, words: [], redirects: [], heredocs: [], nested: [] };
    if (ctx.out.length > MAX_SEGMENTS) {
      fail(ctx, "too many commands");
      i = n;
    }
  };
  const mark = (at: number) => {
    if (cmd.start < 0) cmd.start = at;
  };

  /** Heredoc bodies start on the line after the command that names them. */
  const consumeBodies = (from: number): number => {
    let at = from;
    for (const p of pending) {
      let body = "";
      while (at < n) {
        const e = src.indexOf("\n", at);
        const line = src.slice(at, e < 0 ? n : e);
        at = e < 0 ? n : e + 1;
        if ((p.strip ? line.replace(/^\t+/, "") : line) === p.delim) break;
        body += line + "\n";
      }
      if (p.feedsShell) {
        if (depth + 1 <= MAX_DEPTH) scriptAt(ctx, body, 0, null, depth + 1, "script");
      } else if (!p.quoted) {
        // Unquoted heredocs still expand `$(…)` and backticks.
        const found: string[] = [];
        for (let k = 0; k < body.length;) {
          if (body[k] === "\\") k += 2;
          else if (body[k] === "$" || body[k] === "`") k = expansion(ctx, body, k, depth, found)?.end ?? k + 1;
          else k++;
        }
        p.owner?.nested.push(...found);
      }
    }
    pending.length = 0;
    return at;
  };

  const redirect = (at: number, fd: string): number => {
    let j = at;
    const c = src[j];
    let op: string;
    if ((c === "<" || c === ">") && src[j + 1] === "(") {
      // Process substitution: a command whose output/input is used as a file name.
      const r = scriptAt(ctx, src, j + 2, ")", depth + 1, "substitution");
      cmd.nested.push(...r.progs);
      cmd.words.push(src.slice(j, r.end));
      return r.end;
    }
    if (c === "&") {
      op = src[j + 2] === ">" ? "&>>" : "&>";
      j += op.length;
    } else if (c === ">") {
      op = ">";
      j++;
      while (j < n && op.length < 3 && (src[j] === ">" || src[j] === "&" || src[j] === "|")) op += src[j++];
    } else if (src.startsWith("<<<", j)) ((op = "<<<"), (j += 3));
    else if (src.startsWith("<<-", j)) ((op = "<<-"), (j += 3));
    else if (src.startsWith("<<", j)) ((op = "<<"), (j += 2));
    else if (src.startsWith("<&", j)) ((op = "<&"), (j += 2));
    else if (src.startsWith("<>", j)) ((op = "<>"), (j += 2));
    else ((op = "<"), j++);
    while (src[j] === " " || src[j] === "\t") j++;
    let target = "";
    let quoted = false;
    if ((src[j] === "<" || src[j] === ">") && src[j + 1] === "(") {
      const r = scriptAt(ctx, src, j + 2, ")", depth + 1, "substitution");
      cmd.nested.push(...r.progs);
      target = src.slice(j, r.end);
      j = r.end;
    } else {
      const w = readWord(ctx, src, j, depth, cmd.nested);
      target = w.text;
      quoted = w.quoted;
      j = w.end;
    }
    if (!target && !quoted) fail(ctx, "redirection without a target");
    if (op === "<<" || op === "<<-") cmd.heredocs.push({ delim: target, quoted, strip: op === "<<-" });
    else if (op === "<<<") cmd.hereString = target;
    cmd.redirects.push({ op: fd + op, target });
    return j;
  };

  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t") i++;
    else if (c === "\n") {
      finish("\n", i);
      i = consumeBodies(i + 1);
    } else if (c === "\\" && src[i + 1] === "\n") i += 2;
    else if (c === "#") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === ";") {
      finish(";", i);
      i += src[i + 1] === ";" || src[i + 1] === "&" || src[i + 1] === "|" ? 2 : 1;
    } else if (c === "&" && src[i + 1] === "&") {
      finish("&&", i);
      i += 2;
    } else if (c === "&" && src[i + 1] === ">") {
      mark(i);
      i = redirect(i, "");
    } else if (c === "&") {
      finish("&", i);
      i++;
    } else if (c === "|") {
      const sep = src[i + 1] === "|" ? "||" : src[i + 1] === "&" ? "|&" : "|";
      finish(sep, i);
      i += sep.length;
    } else if (c === "(") {
      finish("(", i);
      parens++;
      i++;
    } else if (c === ")") {
      finish(")", i);
      if (parens > 0) parens--;
      else if (closer === ")") return { end: i + 1, progs };
      i++;
    } else if (c === "<" || c === ">") {
      mark(i);
      i = redirect(i, "");
    } else {
      mark(i);
      const w = readWord(ctx, src, i, depth, cmd.nested);
      if (/^\d+$/.test(w.text) && !w.quoted && (src[w.end] === "<" || src[w.end] === ">")) i = redirect(w.end, w.text);
      else {
        cmd.words.push(w.text);
        i = w.end > i ? w.end : i + 1;
      }
    }
  }
  finish("end", n);
  if (closer) fail(ctx, "unterminated command substitution");
  return { end: n, progs };
}

/** Splits a command line into its simple commands. Never throws; `error` is set when the text is not fully understood. */
export function parseCommand(raw: string): ParsedCommand {
  if (raw.length > MAX_COMMAND) return { raw, segments: [], error: "command is too long" };
  const ctx: Ctx = { out: [], errors: [] };
  scriptAt(ctx, raw, 0, null, 0, "command");
  return ctx.errors.length ? { raw, segments: ctx.out, error: ctx.errors[0] } : { raw, segments: ctx.out };
}

// ---------------------------------------------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------------------------------------------

type GlobToken = { kind: "star" } | { kind: "any" } | { kind: "char"; ch: string };
const globCache = new Map<string, GlobToken[]>();
const wordsCache = new Map<string, string[] | null>();

function globTokens(pattern: string): GlobToken[] {
  let t = globCache.get(pattern);
  if (!t) {
    t = [];
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "\\" && i + 1 < pattern.length) t.push({ kind: "char", ch: pattern[++i] });
      else if (c === "*") {
        if (t[t.length - 1]?.kind !== "star") t.push({ kind: "star" });
      } else if (c === "?") t.push({ kind: "any" });
      else t.push({ kind: "char", ch: c });
    }
    if (globCache.size > 1000) globCache.clear();
    globCache.set(pattern, t);
  }
  return t;
}

/** `*` matches any text (spaces too), `?` one character, `\` escapes. Anchored; runs in O(pattern x text). */
export function wildcardMatch(pattern: string, text: string): boolean {
  const tokens = globTokens(pattern);
  let p = 0;
  let t = 0;
  let star = -1;
  let from = 0;
  while (t < text.length) {
    const tok = tokens[p];
    if (tok && tok.kind !== "star" && (tok.kind === "any" || tok.ch === text[t])) {
      p++;
      t++;
    } else if (tok?.kind === "star") {
      star = p++;
      from = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++from;
    } else return false;
  }
  while (tokens[p]?.kind === "star") p++;
  return p === tokens.length;
}

const normalizeSpaces = (s: string) => s.trim().replace(/\s+/g, " ");

/** Glob over the command with quotes removed and spaces collapsed; a trailing ` *` also matches the bare command. */
export function globMatches(pattern: string, text: string): boolean {
  const p = normalizeSpaces(pattern);
  return wildcardMatch(p, text) || (p.endsWith(" *") && wildcardMatch(p.slice(0, -2), text));
}

/** The words of a prefix pattern, or null when it is not a single simple command. */
export function prefixWords(pattern: string): string[] | null {
  if (wordsCache.has(pattern)) return wordsCache.get(pattern)!;
  const parsed = parseCommand(pattern);
  const [seg] = parsed.segments;
  const ok =
    !parsed.error &&
    parsed.segments.length === 1 &&
    !seg.assignments.length &&
    !seg.redirects.length &&
    !seg.nested.length &&
    seg.words.length > 0;
  const words = ok ? seg.words : null;
  if (wordsCache.size > 1000) wordsCache.clear();
  wordsCache.set(pattern, words);
  return words;
}

export type PatternError = "empty" | "tooLong" | "compound" | "unsupported";
export type PatternCheck = { ok: true; pattern: string } | { ok: false; error: PatternError };

/** Validates a pattern typed by the user. A pattern describes ONE command; combine commands with several rules. */
export function validatePattern(match: "prefix" | "glob", raw: string): PatternCheck {
  const pattern = raw.trim();
  if (!pattern) return { ok: false, error: "empty" };
  if (pattern.length > MAX_PATTERN) return { ok: false, error: "tooLong" };
  if (match === "glob")
    return /[;&|<>`\n]|\$\(/.test(pattern)
      ? { ok: false, error: "compound" }
      : { ok: true, pattern: normalizeSpaces(pattern) };
  const parsed = parseCommand(pattern);
  if (parsed.error) return { ok: false, error: "unsupported" };
  if (parsed.segments.length !== 1 || parsed.segments[0].nested.length)
    return { ok: false, error: parsed.segments.length ? "compound" : "empty" };
  const seg = parsed.segments[0];
  return seg.assignments.length || seg.redirects.length || !seg.words.length
    ? { ok: false, error: "unsupported" }
    : { ok: true, pattern };
}

const matchWords = (rule: Rule, words: string[]): boolean => {
  if (!words.length) return false;
  if (rule.match === "prefix") {
    const p = prefixWords(rule.pattern);
    return !!p && p.length <= words.length && p.every((w, i) => w === words[i]);
  }
  return rule.match === "glob" && globMatches(rule.pattern, words.join(" "));
};

// ---------------------------------------------------------------------------------------------------------------
// Built-in deny rules
// ---------------------------------------------------------------------------------------------------------------

export type BuiltinRule = {
  id: string;
  /** Shown in the settings next to the explanation. */
  example: string;
  test(seg: Segment, cmd: ParsedCommand): boolean;
  /** Matched against the whole command line instead of one simple command. */
  testRaw?(raw: string): boolean;
};

const HOME_CRITICAL = new Set([
  "*",
  ".*",
  "Documents",
  "Desktop",
  "Downloads",
  "Library",
  "Pictures",
  "Movies",
  "Music",
  "Public",
  "Applications",
  ".ssh",
  ".gnupg",
  ".config",
]);
const SYSTEM_DIRS = new Set([
  "System",
  "Library",
  "usr",
  "bin",
  "sbin",
  "etc",
  "var",
  "private",
  "opt",
  "Applications",
  "dev",
  "boot",
  "lib",
  "lib64",
  "root",
  "srv",
  "sys",
  "proc",
  "cores",
]);

/** True for targets whose recursive removal/permission change would wreck the machine: `/`, `~`, `$HOME`, system folders, a home folder. */
export function isDangerousTarget(target: string): boolean {
  let p = target.trim();
  if (!p) return false;
  let home = false;
  const h = /^(?:~[^/]*|\$HOME|\$\{HOME\})(?=\/|$)/.exec(p);
  if (h) {
    home = true;
    p = p.slice(h[0].length) || "/";
  } else if (!p.startsWith("/")) {
    // Relative: only a path that climbs out of the working folder is "obviously" wrong.
    const parts = p.split("/").filter((s) => s && s !== ".");
    return parts.length > 0 && parts.every((s) => s === "..");
  }
  const comps: string[] = [];
  for (const c of p.split("/")) {
    if (!c || c === ".") continue;
    if (c === "..") comps.pop();
    else comps.push(c);
  }
  const wild = comps.length > 0 && /^(?:\*+|\.\*)$/.test(comps[comps.length - 1]);
  if (home) return comps.length === 0 || (comps.length === 1 && HOME_CRITICAL.has(comps[0]));
  if (comps.length === 0) return true;
  if (comps.length === 1) return !(comps[0] === "tmp" && wild);
  if (wild && comps.length === 2 && comps[0] === "tmp") return false;
  const [a, b, c] = comps;
  if ((a === "Users" || a === "home") && comps.length === 2) return true;
  if ((a === "Users" || a === "home") && comps.length === 3 && HOME_CRITICAL.has(c)) return true;
  if (a === "Volumes" && comps.length <= 2) return true;
  const base = wild ? comps.slice(0, -1) : comps;
  if (SYSTEM_DIRS.has(a) && base.length <= 2)
    return !(a === "private" && base.length === 2 && b !== "tmp" && b !== "var" && b !== "etc");
  return false;
}

const operands = (words: string[]): string[] => {
  const out: string[] = [];
  let opts = true;
  for (const w of words.slice(1)) {
    if (opts && w === "--") opts = false;
    else if (opts && w.length > 1 && w.startsWith("-")) continue;
    else out.push(w);
  }
  return out;
};
const flagged = (words: string[], short: RegExp, long: string) => {
  for (const w of words.slice(1)) {
    if (w === "--") break;
    if (w === long || short.test(w)) return true;
  }
  return false;
};

/** Options after which an interpreter runs the text on the command line instead of a file. */
const INTERPRETER_CODE_FLAGS = new Map<string, readonly string[]>([
  ["node", ["-e", "--eval", "-p", "--print"]],
  ["perl", ["-e", "-E"]],
  ["ruby", ["-e"]],
  ["php", ["-r"]],
]);
const DOWNLOADERS = new Set(["curl", "wget", "fetch"]);
const isPython = (prog: string) => /^python[0-9.]*$/.test(prog);
const isInterpreter = (prog: string) => SHELLS.has(prog) || isPython(prog) || INTERPRETER_CODE_FLAGS.has(prog);

/** True when the command executes its standard input as a program (`bash`, `sh -s`, `python -`), not a file or `-c` text. */
function runsStdin(words: string[]): boolean {
  const prog = progName(words[0]);
  if (SHELLS.has(prog)) return scriptOf(words) === undefined && (words.includes("-s") || operands(words).length === 0);
  const codeFlags = isPython(prog) ? ["-c", "-m"] : (INTERPRETER_CODE_FLAGS.get(prog) ?? []);
  if (words.slice(1).some((w) => codeFlags.includes(w))) return false;
  const files = operands(words);
  return files.length === 0 || files[0] === "-";
}

export const BUILTIN_RULES: readonly BuiltinRule[] = [
  {
    id: "privilege",
    example: "sudo …",
    test: (s) => ["sudo", "doas", "su", "pkexec"].includes(progName(s.words[0])),
  },
  {
    id: "rm-root",
    example: "rm -rf / · rm -rf ~ · rm -rf $HOME",
    test: (s) => {
      const prog = progName(s.words[0]);
      if (prog === "rm")
        return (
          s.words.includes("--no-preserve-root") ||
          (flagged(s.words, /^-[A-Za-z]*[rR][A-Za-z]*$/, "--recursive") && operands(s.words).some(isDangerousTarget))
        );
      if (prog === "find") {
        const paths: string[] = [];
        for (const w of s.words.slice(1)) {
          if (/^-[HLPEXdsx]$/.test(w)) continue;
          if (w.startsWith("-") || w === "(" || w === "!") break;
          paths.push(w);
        }
        return s.words.some((w) => w === "-delete" || EXEC_FLAGS.has(w)) && paths.some(isDangerousTarget);
      }
      return false;
    },
  },
  {
    id: "chmod-root",
    example: "chmod -R 777 / · chown -R me ~",
    test: (s) =>
      ["chmod", "chown", "chgrp"].includes(progName(s.words[0])) &&
      flagged(s.words, /^-[A-Za-z]*R[A-Za-z]*$/, "--recursive") &&
      operands(s.words).some(isDangerousTarget),
  },
  {
    id: "curl-sh",
    example: 'curl … | sh · sh -c "$(curl …)"',
    test: (s) => {
      const prog = progName(s.words[0]);
      if (!isInterpreter(prog) && !["eval", "source", "."].includes(prog)) return false;
      if (s.nested.some((p) => DOWNLOADERS.has(p))) return true;
      return s.pipeFrom.some((p) => DOWNLOADERS.has(p)) && isInterpreter(prog) && runsStdin(s.words);
    },
  },
  {
    id: "disk",
    example: "mkfs · dd of=/dev/disk2 · diskutil eraseDisk",
    test: (s) => {
      const prog = progName(s.words[0]);
      const sub = (s.words[1] ?? "").toLowerCase();
      if (/^mkfs(?:\.|$)/.test(prog) || /^newfs(?:_|$)/.test(prog)) return true;
      if (
        prog === "diskutil" &&
        (/^(?:erase|partition|zerodisk|randomdisk|secureerase|reformat)/.test(sub) ||
          (sub === "apfs" && /^delete/i.test(s.words[2] ?? "")))
      )
        return true;
      if (prog === "dd" && s.words.some((w) => /^of=\/dev\/(?!null$|stdout$|stderr$|tty$|fd\/)/.test(w))) return true;
      return s.redirects.some((r) => isWrite(r) && /^\/dev\/(?:r?disk|sd|hd|nvme|mmcblk|vd|xvd|loop)/.test(r.target));
    },
  },
  {
    id: "power",
    example: "shutdown · reboot · halt · poweroff",
    test: (s) => ["shutdown", "reboot", "halt", "poweroff"].includes(progName(s.words[0])),
  },
  {
    id: "fork-bomb",
    example: ":(){ :|:& };:",
    test: () => false,
    testRaw: (raw) => raw.replace(/\s+/g, "").includes(":(){:|:&};:"),
  },
];

export const BUILTIN_IDS = BUILTIN_RULES.map((b) => b.id);

// ---------------------------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------------------------

export type Decision = "allow" | "ask" | "deny" | "default";
export type RuleRef = {
  id: string;
  effect: Effect;
  match: MatchKind | "builtin";
  pattern: string;
  project?: string;
  builtin?: boolean;
};
export type SegmentVerdict = { text: string; decision: Decision; rule?: RuleRef };
export type Evaluation = {
  /** `default`: no rule decided; the access mode does (ask in "ask for commands", run in "full access"). */
  decision: Decision;
  rule?: RuleRef;
  /** The simple command that caused a deny or ask. */
  segment?: string;
  segments: SegmentVerdict[];
  /** Set when the text could not be parsed completely; such a command is never allowed by a rule. */
  parseError?: string;
};

/** Shell builtins that run no program: allowed without a rule so `cd app && npm test` needs only a rule for `npm test`. */
const INERT = new Set(["cd", "pwd", "true", "false", ":"]);

const ref = (r: Rule): RuleRef => ({
  id: r.id,
  effect: r.effect,
  match: r.match,
  pattern: r.pattern,
  ...(r.project ? { project: r.project } : {}),
});
const builtinRef = (b: BuiltinRule): RuleRef => ({
  id: `builtin:${b.id}`,
  effect: "deny",
  match: "builtin",
  pattern: b.example,
  builtin: true,
});

/** Words to try for deny/ask rules: the command as written and with the program name normalised (`/bin/RM` -> `rm`). */
function wideWords(seg: Segment): string[][] {
  const prog = progName(seg.words[0]);
  return seg.words.length && prog !== seg.words[0] ? [seg.words, [prog, ...seg.words.slice(1)]] : [seg.words];
}

/**
 * Judges a command line. Every simple command in it must be allowed for the whole to be allowed; one deny anywhere
 * denies the whole, one ask anywhere asks. Deny beats ask beats allow. `exact` rules compare the whole line.
 */
export function evaluateCommand(
  command: string,
  rules: readonly Rule[],
  options: { disabledBuiltins?: readonly string[] } = {},
): Evaluation {
  const parsed = parseCommand(command);
  const off = new Set(options.disabledBuiltins ?? []);
  const builtins = BUILTIN_RULES.filter((b) => !off.has(b.id));
  const segRules = (e: Effect) => rules.filter((r) => r.effect === e && r.match !== "exact");
  const exactRules = (e: Effect) => rules.filter((r) => r.effect === e && r.match === "exact");
  const deny = segRules("deny");
  const ask = segRules("ask");
  const allow = segRules("allow");

  const judge = (seg: Segment): SegmentVerdict => {
    const base = { text: seg.text };
    if (!seg.words.length && !seg.assignments.length && !seg.writes) return { ...base, decision: "allow" };
    const wide = seg.words.length ? wideWords(seg) : [];
    for (const r of deny) if (wide.some((w) => matchWords(r, w))) return { ...base, decision: "deny", rule: ref(r) };
    for (const b of builtins) if (b.test(seg, parsed)) return { ...base, decision: "deny", rule: builtinRef(b) };
    for (const r of ask) if (wide.some((w) => matchWords(r, w))) return { ...base, decision: "ask", rule: ref(r) };
    if (seg.words.length && !seg.assignments.length && !seg.writes) {
      if (INERT.has(seg.words[0])) return { ...base, decision: "allow" };
      for (const r of allow) if (matchWords(r, seg.words)) return { ...base, decision: "allow", rule: ref(r) };
    }
    return { ...base, decision: "default" };
  };

  const segments = parsed.segments.map(judge);
  const whole = command.trim();
  const exactHit = (e: Effect) => exactRules(e).find((r) => r.pattern.trim() === whole);
  const result = (decision: Decision, rule?: RuleRef, segment?: string): Evaluation => ({
    decision,
    ...(rule ? { rule } : {}),
    ...(segment !== undefined ? { segment } : {}),
    segments,
    ...(parsed.error ? { parseError: parsed.error } : {}),
  });

  const denied = segments.find((v) => v.decision === "deny");
  if (denied) return result("deny", denied.rule, denied.text);
  const exactDeny = exactHit("deny");
  if (exactDeny) return result("deny", ref(exactDeny), whole);
  const rawBuiltin = builtins.find((b) => b.testRaw?.(command));
  if (rawBuiltin) return result("deny", builtinRef(rawBuiltin), whole);
  const asked = segments.find((v) => v.decision === "ask");
  if (asked) return result("ask", asked.rule, asked.text);
  const exactAsk = exactHit("ask");
  if (exactAsk) return result("ask", ref(exactAsk), whole);
  const exactAllow = exactHit("allow");
  if (exactAllow) return result("allow", ref(exactAllow));
  if (!parsed.error && segments.length && segments.every((v) => v.decision === "allow"))
    return result("allow", segments.find((v) => v.rule)?.rule);
  return result("default");
}

export type CommandAction = "run" | "ask" | "block";

/** What the agent does with a decision: deny always blocks, ask always asks, and an unmatched command follows the access mode. */
export function commandAction(decision: Decision, access: Access): CommandAction {
  if (decision === "deny" || access === "readonly") return "block";
  if (decision === "ask") return "ask";
  if (decision === "allow") return "run";
  return access === "full" ? "run" : "ask";
}

// ---------------------------------------------------------------------------------------------------------------
// Configuration: normalisation, scopes, migration of the old "always allowed" list
// ---------------------------------------------------------------------------------------------------------------

export const DEFAULT_RULES: RulesConfig = { version: 1, rules: [], disabledBuiltins: [] };

let idCounter = 0;
export const newRuleId = () =>
  `r${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const EFFECTS: readonly string[] = ["allow", "ask", "deny"];
const MATCHES: readonly string[] = ["prefix", "glob", "exact"];

/** Accepts whatever was persisted (possibly missing, corrupt or hand-edited) and returns a valid configuration. */
export function normalizeRulesConfig(raw: unknown): RulesConfig {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rules: Rule[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(obj.rules) ? obj.rules : [];
  for (const item of list) {
    if (rules.length >= MAX_RULES) break;
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.effect !== "string" ||
      !EFFECTS.includes(r.effect) ||
      typeof r.match !== "string" ||
      !MATCHES.includes(r.match) ||
      typeof r.pattern !== "string"
    )
      continue;
    const match = r.match as MatchKind;
    let pattern = r.pattern.trim();
    if (match === "exact") {
      if (!pattern || pattern.length > MAX_EXACT) continue;
    } else {
      const check = validatePattern(match, pattern);
      if (!check.ok) continue;
      pattern = check.pattern;
    }
    const project =
      typeof r.project === "string" && r.project.trim() && r.project.length <= 1000 ? r.project.trim() : undefined;
    const key = [r.effect, match, pattern, project ?? ""].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    const id =
      typeof r.id === "string" && r.id && r.id.length <= 80 && !rules.some((x) => x.id === r.id) ? r.id : newRuleId();
    rules.push({ id, effect: r.effect as Effect, match, pattern, ...(project ? { project } : {}) });
  }
  const disabled = Array.isArray(obj.disabledBuiltins)
    ? [...new Set(obj.disabledBuiltins.filter((x): x is string => typeof x === "string" && BUILTIN_IDS.includes(x)))]
    : [];
  return { version: 1, rules, disabledBuiltins: disabled };
}

/** Folders are compared without trailing slashes, and macOS' `/private/var`, `/private/tmp` equal `/var`, `/tmp`. */
export const normalizeProjectPath = (p: string) =>
  p
    .trim()
    .replace(/\/+$/, "")
    .replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, "");
export const sameProject = (a: string, b: string) => normalizeProjectPath(a) === normalizeProjectPath(b);

/**
 * Rules in force for a run: global rules plus the ones of `project`. When the project is unknown, project rules that
 * deny or ask still apply (the safe side) and project allow rules do not.
 */
export function applicableRules(rules: readonly Rule[], project: string | null | undefined): Rule[] {
  return rules.filter((r) => !r.project || (project ? sameProject(r.project, project) : r.effect !== "allow"));
}

/**
 * The old "always allowed" list (app setting `cmdAllowlist`, also fed by the "Always allow" button) as rules. An entry
 * that is a single simple command stays a prefix rule (`git status` allows `git status -s`); anything else, such as
 * `cd app && npm test`, only allows that exact line.
 */
export function legacyAllowRules(allowlist: readonly string[]): Rule[] {
  const out: Rule[] = [];
  for (const entry of allowlist) {
    const pattern = typeof entry === "string" ? entry.trim() : "";
    if (!pattern || pattern.length > MAX_EXACT) continue;
    const simple = pattern.length <= MAX_PATTERN && validatePattern("prefix", pattern).ok;
    out.push({ id: `legacy:${pattern}`, effect: "allow", match: simple ? "prefix" : "exact", pattern });
  }
  return out;
}

export type RunRules = { config: RulesConfig; allowlist: readonly string[]; project: string | null | undefined };

/** Decides one command for a run: rules of the project and global ones, the old allowlist and the built-in defaults. */
export function decideCommand(
  command: string,
  run: RunRules,
  access: Access,
): { action: CommandAction; evaluation: Evaluation } {
  const rules = [...applicableRules(run.config.rules, run.project), ...legacyAllowRules(run.allowlist)];
  const evaluation = evaluateCommand(command, rules, { disabledBuiltins: run.config.disabledBuiltins });
  return { action: commandAction(evaluation.decision, access), evaluation };
}

/** Label of a rule for logs and messages: `deny prefix: sudo`. */
export const describeRule = (r: RuleRef) =>
  r.builtin ? `built-in: ${r.pattern}` : `${r.effect} ${r.match}: ${r.pattern}`;

/** Message returned to the model when a command is blocked. */
export function blockedMessage(e: Evaluation, access: Access): string {
  if (access === "readonly") return "Blocked: read-only mode does not allow running commands.";
  const rule = e.rule ? describeRule(e.rule) : "a command rule";
  const part = e.segment && e.segment !== e.rule?.pattern ? ` (matched: ${e.segment})` : "";
  return `Blocked by ${rule}${part}. The user's command rules forbid this command; do not retry it or a variation. Explain what you needed to do and let the user decide.`;
}

/** Why a command asks for confirmation, for the approval card. */
export const askReason = (e: Evaluation): string | undefined =>
  e.decision === "ask" && e.rule ? describeRule(e.rule) : undefined;
