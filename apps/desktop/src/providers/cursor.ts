import { resolveKey, type KeySource } from "../lib/keys";
import { mergeActivity, type Activity } from "./activities";
import { cursorActivity, cursorRunFailure, settleActivities } from "./cursorEvents";
import { capabilitiesOf, interrupted } from "./lifecycle";
import { restartableTurn } from "./turnRestart";
import { resolveResource } from "@tauri-apps/api/path";
import { resumePoint, runScript, spawnLines } from "./cli";
import { sidecarFailure, withImagePaths } from "./cliArgs";
import { attachments } from "../lib/api";
import type { Adapter, ProviderConfig, TurnInput } from "./types";
import { pickLevel, reportedEffort, sdkEffort, specLevels } from "./reasoning";

declare const __SIDECAR__: string;

async function sidecarPath() {
  return import.meta.env?.DEV ? __SIDECAR__ : resolveResource("sidecar/cursor-agent.mjs");
}

// ponytail: runs the sidecar with the user's own `node` (>= 22.13) from a login shell; ship a bundled runtime if users lack Node.
async function call(req: object, onEvent: (e: any) => void, signal?: AbortSignal) {
  let reported = false;
  const relay = (e: any) => {
    if (e?.type === "error") reported = true;
    onEvent(e);
  };
  const { code, stderr } = await spawnLines(runScript({ executable: "node", args: [await sidecarPath()] }), relay, {
    signal,
    stdin: JSON.stringify(req) + "\n",
  });
  const failure = sidecarFailure({ code, stderr, reported, aborted: !!signal?.aborted });
  if (failure) throw new Error(failure);
}

/** Cursor SDK agent: it runs its own tools in the project; we only relay text and tool activity. */
export function cursorAgent(cfg: ProviderConfig, key: KeySource): Adapter {
  return {
    supportsComputer: false,
    supportsReasoning: (model) => specLevels(reportedEffort(cfg.id, model)).length > 0,
    reasoningLevels: (model) => specLevels(reportedEffort(cfg.id, model)),

    async listModels() {
      let list: { id: string; name: string; parameters?: unknown }[] = [];
      let error = "";
      await call({ type: "models", apiKey: await resolveKey(key) }, (e) => {
        if (e.type === "models") list = e.list;
        if (e.type === "error") error = e.message;
      });
      if (error) throw new Error(error);
      return list.map((m) => ({
        id: m.id,
        name: m.name,
        providerId: cfg.id,
        created: 0,
        tools: true,
        images: false,
        effort: sdkEffort(m.parameters),
      }));
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
        // The effort parameter the model reported, set to the chosen level (the nearest one the model offers).
        const spec = reportedEffort(cfg.id, t.model);
        const level = pickLevel(t.reasoning, specLevels(spec));
        const params = spec && level ? [{ id: spec.param, value: spec.values[level]! }] : undefined;
        const emit = (s: string) => {
          text += s;
          t.onText(s);
        };
        let status: string | undefined;
        let runError = "";
        // One sidecar per turn: a follow-up cancels the run softly and the loop resumes the agent with it (turnRestart.ts).
        const turn = restartableTurn(t, {
          enabled: capabilitiesOf(cfg).followUp === "restart",
          ended: () => status !== undefined,
        });
        try {
          await call(
            { type: "send", apiKey: await resolveKey(key), model: t.model, params, cwd: t.cwd, agentId, prompt },
            (e) => {
              if (e.type === "agent") agentId = e.agentId;
              else if (e.type === "text") emit(e.text);
              else if (e.type === "tool") {
                const next = cursorActivity(e);
                const merged = mergeActivity(activities.get(next.id), next);
                activities.set(next.id, merged);
                t.onActivity?.(merged);
              } else if (e.type === "done") {
                status = e.status;
                runError = e.error ?? "";
              } else if (e.type === "error") error = e.message;
            },
            turn.signal,
          );
        } finally {
          await turn.close();
        }
        const output = () => ({
          parts: [...settleActivities(activities.values()), { type: "text" as const, text }],
          responseId: agentId,
        });
        if (turn.stopped()) throw interrupted(output());
        // Cancelled for a follow-up: what it produced so far is the turn's result.
        if (turn.restarted()) return output();
        const failure = cursorRunFailure({ status, error, runError });
        if (failure) throw new Error(failure);
        return output();
      } finally {
        if (saved && t.chatId) await attachments.clear(t.chatId).catch(() => {});
      }
    },
  };
}
