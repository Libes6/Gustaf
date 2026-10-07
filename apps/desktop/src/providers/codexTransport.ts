import { getSetting, setSetting } from "../lib/api";

// How a Codex turn talks to the CLI: `exec` (codex exec --json, one process per turn, subagents read from rollout files)
// or `app-server` (JSON-RPC over stdio, native subagent lifecycle; providers/codexAppServer.ts). Default: app-server;
// app-server is the default (verified against codex 0.160.1 and in the app); it falls back to exec when it cannot start, and the Settings toggle switches back.
export type CodexTransport = "exec" | "app-server";
export const TRANSPORT_SETTING = "codexTransport";
export const codexTransport = (): Promise<CodexTransport> =>
  getSetting<string>(TRANSPORT_SETTING, "app-server")
    .then((v) => (v === "exec" ? "exec" : "app-server"))
    .catch(() => "app-server");
export const setCodexTransport = (v: CodexTransport) => setSetting(TRANSPORT_SETTING, v);
