import { getSetting, setSetting } from "../lib/api";

// How a Codex turn talks to the CLI: `exec` (codex exec --json, one process per turn, subagents read from rollout files)
// or `app-server` (JSON-RPC over stdio, native subagent lifecycle; providers/codexAppServer.ts). Default stays `exec` until
// the app-server path has been run against a real Codex; app-server falls back to exec when it cannot start.
export type CodexTransport = "exec" | "app-server";
export const TRANSPORT_SETTING = "codexTransport";
export const codexTransport = (): Promise<CodexTransport> => getSetting<string>(TRANSPORT_SETTING, "exec").then((v) => (v === "app-server" ? "app-server" : "exec")).catch(() => "exec");
export const setCodexTransport = (v: CodexTransport) => setSetting(TRANSPORT_SETTING, v);
