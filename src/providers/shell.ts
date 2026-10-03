// Pure helpers that pick the shell per OS and build the scripts that cli.ts runs through it (no Tauri imports: unit-tested).
//   macOS   zsh (login shell, so the user's PATH from ~/.zprofile applies)
//   Linux   bash (login shell)
//   Windows Windows PowerShell 5.1 (`powershell.exe`, present on every supported Windows)
// The scope names must match the `shell:allow-spawn` / `shell:allow-execute` entries in src-tauri/capabilities.
import type { Platform } from "../lib/platform.ts";

export type ShellKind = "posix" | "powershell";
export type ShellName = "zsh" | "bash" | "sh" | "powershell";
export type ShellSpec = { name: ShellName; kind: ShellKind; args: (script: string) => string[] };

/** Output and pipe encoding: PowerShell 5.1 defaults to the OEM code page / ASCII, which corrupts non-ASCII text. */
const PS_PRELUDE =
  "$OutputEncoding = [Text.UTF8Encoding]::new($false); try { [Console]::OutputEncoding = $OutputEncoding } catch {}; $ProgressPreference = 'SilentlyContinue'; ";

export function shellFor(platform: Platform): ShellSpec {
  switch (platform) {
    case "macos":
      return { name: "zsh", kind: "posix", args: (s) => ["-lc", s] };
    case "windows":
      return { name: "powershell", kind: "powershell", args: (s) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PS_PRELUDE + s] };
    default:
      return { name: "bash", kind: "posix", args: (s) => ["-lc", s] };
  }
}

/** POSIX single-quote quoting. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** PowerShell single-quoted string literal (only `'` needs doubling; also the typographic quotes PowerShell treats as quotes). */
export const psq = (s: string) => `'${s.replace(/['‘’‚‛]/g, (c) => c + c)}'`;

/**
 * One argument for a native Windows program called from Windows PowerShell 5.1, which joins arguments into a command
 * line itself: it wraps an argument that contains whitespace in double quotes but does not escape embedded quotes.
 * This applies the CommandLineToArgvW rules (backslashes before a quote are doubled, `"` becomes `\"`, trailing
 * backslashes are doubled when the argument gets wrapped) so the program receives the exact string.
 */
export function winArg(s: string): string {
  let out = "";
  let slashes = 0;
  for (const ch of s) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    if (ch === '"') out += "\\".repeat(slashes * 2 + 1) + '"';
    else out += "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  out += "\\".repeat(/\s/.test(s) ? slashes * 2 : slashes);
  return out;
}

export const quote = (kind: ShellKind, s: string) => (kind === "powershell" ? psq(s) : shq(s));

export const isWinShim = (path: string) => /\.(cmd|bat)$/i.test(path);

/** Directory part of a path with either separator (`""` when there is none). */
export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? "" : i === 0 ? path.slice(0, 1) : path.slice(0, i);
}

const isAbsolute = (path: string) => path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");

export type Invocation = {
  executable: string;
  args?: string[];
  /** Last argument that may be large or hostile (the user's prompt). */
  prompt?: string;
  /** Environment for the program (`env K=V` / `$env:K`). */
  env?: Record<string, string>;
  /** Put the executable's directory first on PATH (needed for Node-based shims that find `node` next to themselves). */
  prependExecutableDir?: boolean;
  /** Redirect stdin from the null device (CLIs that otherwise wait for piped input). */
  nullStdin?: boolean;
};

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/**
 * A script that runs one program with quoted arguments and ends with its exit code.
 * On Windows a `.cmd`/`.bat` shim is run by cmd.exe, which would interpret `&`, `|`, `%`... inside the prompt, so the
 * prompt is piped in on stdin instead (`claude -p` and `codex exec` read it from there when no prompt argument is given).
 */
export function invocationScript(kind: ShellKind, inv: Invocation): string {
  const args = inv.args ?? [];
  const dir = inv.prependExecutableDir && isAbsolute(inv.executable) ? dirname(inv.executable) : "";
  if (kind === "posix") {
    const parts = [...args, ...(inv.prompt != null ? [inv.prompt] : [])].map(shq).join(" ");
    const env = Object.entries(inv.env ?? {}).map(([k, v]) => `${k}=${shq(v)}`);
    return (
      (dir ? `export PATH=${shq(dir)}:"$PATH"; ` : "") +
      `exec ${env.length ? `env ${env.join(" ")} ` : ""}${shq(inv.executable)}${parts ? " " + parts : ""}${inv.nullStdin ? " < /dev/null" : ""}`
    );
  }
  const shim = isWinShim(inv.executable);
  const viaStdin = shim && inv.prompt != null;
  const argv = [...args, ...(inv.prompt != null && !viaStdin ? [inv.prompt] : [])].map((a) => psq(winArg(a))).join(" ");
  let s = "";
  if (dir) s += `$env:PATH = ${psq(dir)} + ';' + $env:PATH; `;
  for (const [k, v] of Object.entries(inv.env ?? {})) s += `$env:${k.replace(/[^A-Za-z0-9_]/g, "_")} = ${psq(v)}; `;
  const call = `& ${psq(inv.executable)}${argv ? " " + argv : ""}`;
  if (viaStdin) s += `$prompt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psq(b64(inv.prompt!))})); $prompt | ${call}`;
  else if (inv.nullStdin) s += `$null | ${call}`;
  else s += call;
  return s + "; exit $LASTEXITCODE";
}

// ---- CLI discovery ----

export type CliName = "codex" | "claude" | "cursor-agent";

/** Where a CLI may live when it is not on the shell's PATH, per OS. `~` is the home directory. */
export function cliCandidates(platform: Platform, id: CliName): string[] {
  if (platform === "windows") {
    // %APPDATA%\npm is where `npm i -g` puts `.cmd` shims; the others are the per-user installer locations.
    const w: Record<CliName, string[]> = {
      claude: ["%USERPROFILE%\\.local\\bin\\claude.exe", "%APPDATA%\\npm\\claude.cmd"],
      codex: ["%APPDATA%\\npm\\codex.cmd", "%USERPROFILE%\\.local\\bin\\codex.exe"],
      "cursor-agent": ["%LOCALAPPDATA%\\cursor-agent\\cursor-agent.cmd", "%USERPROFILE%\\.local\\bin\\cursor-agent.exe"],
    };
    return w[id];
  }
  const nvm = `$NVM:versions/node/*/bin/${id}`;
  const common = [`~/.local/bin/${id}`, `~/.npm-global/bin/${id}`, `~/.volta/bin/${id}`, nvm];
  const system = platform === "macos" ? [`/opt/homebrew/bin/${id}`, `/usr/local/bin/${id}`] : [`/usr/local/bin/${id}`, `/usr/bin/${id}`];
  const extra: string[] = [];
  if (id === "claude") extra.push("~/.claude/local/claude");
  if (id === "codex" && platform === "macos") extra.push("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
  return [...common, ...extra, ...system];
}

/** A candidate as a POSIX shell word (home and nvm directories stay expandable; the rest is quoted). */
function posixWord(c: string, zsh: boolean): string {
  let w: string;
  if (c.startsWith("~/")) w = `"$HOME"/${c.slice(2)}`;
  else if (c.startsWith("$NVM:")) w = `"\${NVM_DIR:-$HOME/.nvm}"/${c.slice(5)}`;
  else w = shq(c);
  // zsh aborts on a glob without matches unless it carries the (N) qualifier; bash/sh keep the literal text, which `test -x` rejects.
  return zsh && c.includes("*") ? w + "(N)" : w;
}

/** `%VAR%` placeholders as PowerShell double-quoted string interpolation. */
const psPath = (c: string) => `"${c.replace(/%([A-Za-z]+)%/g, "$$env:$1")}"`;

/**
 * Script that prints the path of a CLI and exits 0, or exits 1. Looks on PATH first, then at `cliCandidates`.
 * `verify` also requires `--version` to succeed (used for Codex, whose PATH entry may be a broken shim).
 */
export function findCliScript(platform: Platform, id: CliName, verify = false): string {
  const cands = cliCandidates(platform, id);
  if (platform === "windows") return `${PS_FIND_FN}$p = Find-Cli ${psq(id)} @(${cands.map(psPath).join(", ")}) ${verify ? "$true" : "$false"}; if ($p) { $p; exit 0 } else { exit 1 }`;
  const zsh = platform === "macos";
  const ok = (p: string) => (verify ? `[ -x ${p} ] && ${p} --version >/dev/null 2>&1` : `[ -x ${p} ]`);
  return (
    `p=$(command -v ${shq(id)} 2>/dev/null); if [ -n "$p" ] && ${verify ? `"$p" --version >/dev/null 2>&1` : "true"}; then echo "$p"; exit 0; fi; ` +
    `for c in ${cands.map((c) => posixWord(c, zsh)).join(" ")}; do if ${ok('"$c"')}; then echo "$c"; exit 0; fi; done; exit 1`
  );
}

const PS_FIND_FN =
  "function Find-Cli([string]$name, [string[]]$cands, [bool]$verify) { $all = @(); " +
  "$c = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $all += $c.Source }; $all += $cands; " +
  "foreach ($p in $all) { if (-not (Test-Path -LiteralPath $p)) { continue }; if ($verify) { & $p --version *> $null; if ($LASTEXITCODE -ne 0) { continue } }; return $p } }; ";

/** Script printing `<id>\t<first line of --version>` for each CLI that is found and starts. */
export function detectScript(platform: Platform, ids: readonly CliName[]): string {
  if (platform === "windows") {
    const blocks = ids.map(
      (id) =>
        `$p = Find-Cli ${psq(id)} @(${cliCandidates(platform, id).map(psPath).join(", ")}) $false; ` +
        `if ($p) { $v = & $p --version 2>$null | Select-Object -First 1; if ($LASTEXITCODE -eq 0) { ${psq(id)} + [char]9 + $v } }`,
    );
    return PS_FIND_FN + blocks.join("; ");
  }
  const blocks = ids.map(
    (id) =>
      `p=$(${findCliScript(platform, id)}); if [ -n "$p" ] && v=$("$p" --version 2>/dev/null); then v=$(printf '%s\\n' "$v" | head -n 1); printf '%s\\t%s\\n' ${shq(id)} "$v"; fi`,
  );
  return `${blocks.join("; ")}; true`;
}
