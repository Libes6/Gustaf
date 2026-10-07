import { invoke } from "@tauri-apps/api/core";
import { fsx, getSetting, setSetting } from "../lib/api";
import { normalizeProjectPath } from "./rules";
export type DiagnosticsConfig = { enabled: boolean; command: string; timeoutMs: number; engine?: "command" | "lsp" };
export const diagnosticsKey = (root: string) => `diagnostics:${normalizeProjectPath(root)}`;
export function normalizeDiagnostics(value: unknown): DiagnosticsConfig {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    engine: v.engine === "lsp" ? "lsp" : "command",
    enabled: v.enabled === true,
    command: typeof v.command === "string" ? v.command.trim().slice(0, 4000) : "",
    timeoutMs:
      typeof v.timeoutMs === "number" && Number.isFinite(v.timeoutMs)
        ? Math.max(1000, Math.min(120000, Math.round(v.timeoutMs)))
        : 30000,
  };
}
export const loadDiagnostics = async (root: string) =>
  normalizeDiagnostics(await getSetting(diagnosticsKey(root), null));
export const saveDiagnostics = (root: string, value: DiagnosticsConfig) =>
  setSetting(diagnosticsKey(root), normalizeDiagnostics(value));
/** Only named existing scripts, or the installed TypeScript binary. Never use npx (which may install packages). */
export async function detectDiagnostics(root: string): Promise<string> {
  try {
    const raw = await fsx.read(root, "package.json", 1, 2000);
    const manifest = JSON.parse(raw.replace(/^\s*\d+\|/gm, ""));
    const scripts = manifest.scripts ?? {};
    for (const name of ["typecheck", "check:types", "lint"])
      if (typeof scripts[name] === "string") return `npm run ${name}`;
    if (manifest.devDependencies?.typescript || manifest.dependencies?.typescript)
      return "node node_modules/typescript/bin/tsc --noEmit";
  } catch {
    /* not a JS project */
  }
  return "";
}
export const diagnosticResult = (output: string) =>
  output.length > 16000 ? output.slice(0, 16000) + "\n[diagnostics output truncated]" : output;

export type LanguageServer = { language: "typescript" | "rust" | "python"; command: string; args: string[] };
export type FileDiagnostic = {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source?: string;
  code?: string;
};
export type LspReport = {
  status: "complete" | "unavailable" | "timeout";
  server?: LanguageServer;
  diagnostics: FileDiagnostic[];
  detail: string;
  root?: string;
};
export const detectLanguageServers = (root: string) => invoke<LanguageServer[]>("lsp_detect", { root });
/** Host obtains approval to launch the detected executable before invoking this check. No server installation. */
export async function runLspDiagnostics(root: string, path: string, timeoutMs = 30000): Promise<LspReport> {
  return { ...(await invoke<LspReport>("lsp_diagnostics", { root, path, timeoutMs })), root };
}
export function languageForPath(path: string): LanguageServer["language"] | null {
  if (/\.(ts|tsx|js|jsx)$/.test(path)) return "typescript";
  if (/\.rs$/.test(path)) return "rust";
  if (/\.py$/.test(path)) return "python";
  return null;
}
export function formatLspReport(report: LspReport): string {
  return JSON.stringify(report);
}
export function parseLspReport(output: string | undefined): LspReport | null {
  if (!output) return null;
  try {
    const marker = "\nDiagnostics:\n";
    const value = JSON.parse(
      output.includes(marker) ? output.slice(output.lastIndexOf(marker) + marker.length) : output,
    );
    if (!value || !Array.isArray(value.diagnostics) || !["complete", "unavailable", "timeout"].includes(value.status))
      return null;
    if (
      !value.diagnostics.every(
        (d: FileDiagnostic) =>
          typeof d.path === "string" &&
          typeof d.message === "string" &&
          Number.isInteger(d.line) &&
          d.line > 0 &&
          Number.isInteger(d.column) &&
          d.column > 0,
      )
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
