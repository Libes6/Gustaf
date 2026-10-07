import { invoke } from "@tauri-apps/api/core";
import { fsx, getSetting, setSetting } from "./api";
import { normalizeProjectPath } from "../agent/rules";
export type PreviewConfig = { command: string; url: string };
export type PreviewInfo = {
  id: number;
  root: string;
  command: string;
  url: string;
  previewUrl: string;
  state: string;
  error: string | null;
  logs: string;
  console: { kind: string; message: string }[];
  instrumented: boolean;
};
export const previewKey = (root: string) => `preview:${normalizeProjectPath(root)}`;
export const normalizePreview = (value: unknown): PreviewConfig => {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    command: typeof v.command === "string" ? v.command.slice(0, 4000) : "",
    url: typeof v.url === "string" ? v.url.slice(0, 2000) : "http://127.0.0.1:3000/",
  };
};
export function previewUrlError(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
      u.username ||
      u.password ||
      u.hash ||
      !u.port ||
      Number(u.port) < 1024
      ? "Use an HTTP loopback dev-server URL with a port above 1023"
      : "";
  } catch {
    return "Invalid preview URL";
  }
}
export const loadPreview = async (root: string) => normalizePreview(await getSetting(previewKey(root), null));
export const savePreview = (root: string, config: PreviewConfig) =>
  setSetting(previewKey(root), normalizePreview(config));
export async function detectPreview(root: string): Promise<PreviewConfig> {
  try {
    const text = await fsx.read(root, "package.json", 1, 2000);
    const json = JSON.parse(text.replace(/^\s*\d+\|/gm, ""));
    const script = json.scripts?.dev;
    if (typeof script === "string" && /\bvite\b/.test(script))
      return { command: "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort", url: "http://127.0.0.1:5173/" };
    if (typeof script === "string" && /\bnext\s+dev\b/.test(script))
      return { command: "npm run dev -- --hostname 127.0.0.1 --port 3000", url: "http://127.0.0.1:3000/" };
    if (typeof script === "string") return { command: "npm run dev", url: "http://127.0.0.1:3000/" };
    if (typeof json.scripts?.start === "string") return { command: "npm run start", url: "http://127.0.0.1:3000/" };
  } catch {
    /* A non-Node project needs its own user command. */
  }
  return normalizePreview(null);
}
export const preview = {
  start: (root: string, config: PreviewConfig) => invoke<PreviewInfo>("preview_start", { root, ...config }),
  status: (id: number) => invoke<PreviewInfo>("preview_status", { id }),
  stop: (id: number) => invoke<void>("preview_stop", { id }),
  list: (root: string) => invoke<PreviewInfo[]>("preview_list", { root }),
};
export const cleanPreviewLogs = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
