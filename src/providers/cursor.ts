import { mergeActivity, type Activity } from "./activities";
import { resolveResource } from "@tauri-apps/api/path";
import { resumePoint, shq, spawnLines } from "./cli";
import { withImagePaths } from "./cliArgs";
import { attachments } from "../lib/api";
import type { Adapter, ProviderConfig, TurnInput } from "./types";

declare const __SIDECAR__: string;

async function sidecarPath() {
  return import.meta.env.DEV ? __SIDECAR__ : resolveResource("sidecar/cursor-agent.mjs");
}

// ponytail: runs the sidecar with the user's own `node` (>= 22.13) from a login shell; ship a bundled runtime if users lack Node.
async function call(req: object, onEvent: (e: any) => void, signal?: AbortSignal) {
  const { stderr } = await spawnLines(`exec node ${shq(await sidecarPath())}`, onEvent, { signal, stdin: JSON.stringify(req) + "\n" });
  if (/command not found: node|Cannot find package/.test(stderr)) throw new Error(`Cursor sidecar: ${stderr.slice(0, 300)}`);
}

/** Cursor SDK agent: it runs its own tools in the project; we only relay text and tool activity. */
export function cursorAgent(cfg: ProviderConfig, key: string): Adapter {
  return {
    supportsComputer: false,
    supportsReasoning: () => false,

    async listModels() {
      let list: { id: string; name: string }[] = [];
      let error = "";
      await call({ type: "models", apiKey: key }, (e) => {
        if (e.type === "models") list = e.list;
        if (e.type === "error") error = e.message;
      });
      if (error) throw new Error(error);
      return list.map((m) => ({ id: m.id, name: m.name, providerId: cfg.id, created: 0, tools: true, images: false }));
    },

    async turn(t: TurnInput) {
      const point = resumePoint(t, cfg.id, true);
      // Images (attachments, Computer Use screenshots) go to disk and the prompt points at them; removed when the turn ends.
      const saved = point.images.length && t.chatId ? await attachments.save(t.chatId, point.images) : undefined;
      try {
      const prompt = saved ? withImagePaths(point.prompt, saved.files) : point.prompt;
      let agentId = point.session;
      let text = "";
      const activities = new Map<string, Activity>();
      let error = "";
      const emit = (s: string) => {
        text += s;
        t.onText(s);
      };
      await call(
        { type: "send", apiKey: key, model: t.model, cwd: t.cwd, agentId, prompt },
        (e) => {
          if (e.type === "agent") agentId = e.agentId;
          else if (e.type === "text") emit(e.text);
          else if (e.type === "tool") {
            const next: Activity = { type: "activity", id: e.id ?? `${e.name}:${JSON.stringify(e.args ?? {})}`, name: e.name, args: e.args ?? {}, status: e.status === "error" ? "error" : e.status === "running" ? "running" : "unknown", output: e.output };
            const merged = mergeActivity(activities.get(next.id), next);
            activities.set(next.id, merged);
            t.onActivity?.(merged);
          }
          else if (e.type === "error") error = e.message;
        },
        t.signal,
      );
      if (error) throw new Error(error);
      return { parts: [...activities.values(), { type: "text" as const, text }], responseId: agentId };
      } finally {
        if (saved && t.chatId) await attachments.clear(t.chatId).catch(() => {});
      }
    },
  };
}
