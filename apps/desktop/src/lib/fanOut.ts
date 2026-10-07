// One prompt to several models, each in its own git workspace (T7). For every target model a workspace chat is created
// (lib/workspaceCreate.ts) and the prompt runs there in the background with the unattended run of scheduled prompts
// (lib/scheduledRun.ts): live in the chat when it is opened, approvals asked from the user, access capped to "auto",
// no Computer Use or subagents. The runs go in parallel; each result is reported like a scheduled run.
import type { AppState } from "../state";
import { notifyUnfocused, reportChatRun } from "./attention";
import { executeScheduledRun, type RunResult } from "./scheduledRun";
import { depsFor } from "./scheduledRuntime";
import { createWorkspace } from "./workspaceCreate";
import type { ScheduleAccess, ScheduledPrompt } from "./scheduledPrompts";

export type FanTarget = { providerId: string; model: string; name: string };
export type FanResult = {
  target: FanTarget;
  chatId: number | null;
  status: RunResult["status"] | "not-created";
  error?: string;
};
export const FAN_OUT_MAX = 4;

type Created = { ok: true; chatId: number; root: string } | { ok: false; message: string };

/** The sequencing, with the environment injected (tests/fanOut.test.mjs). Workspaces are created one by one (git), runs go in parallel. */
export async function fanOutCore(
  targets: FanTarget[],
  io: {
    create(target: FanTarget): Promise<Created>;
    run(target: FanTarget, chatId: number, root: string): Promise<RunResult>;
    onCreated?(target: FanTarget, chatId: number): void;
  },
): Promise<FanResult[]> {
  const made: { target: FanTarget; created: Created }[] = [];
  for (const target of targets.slice(0, FAN_OUT_MAX)) {
    const created = await io
      .create(target)
      .catch((e): Created => ({ ok: false, message: String(e instanceof Error ? e.message : e) }));
    if (created.ok) io.onCreated?.(target, created.chatId);
    made.push({ target, created });
  }
  return Promise.all(
    made.map(async ({ target, created }): Promise<FanResult> => {
      if (!created.ok) return { target, chatId: null, status: "not-created", error: created.message };
      const r = await io.run(target, created.chatId, created.root);
      return { target, chatId: created.chatId, status: r.status, error: r.error };
    }),
  );
}

/** Starts the fan-out for the app; resolves when every run has ended. */
export function fanOut(
  getApp: () => AppState,
  o: {
    projectId: number;
    projectRoot: string;
    title: string;
    prompt: string;
    targets: FanTarget[];
    access: ScheduleAccess;
    signal: AbortSignal;
  },
) {
  const base = depsFor(getApp);
  return fanOutCore(o.targets, {
    create: async (target) => {
      const r = await createWorkspace({
        projectId: o.projectId,
        root: o.projectRoot,
        title: `${o.title} · ${target.name}`,
        slugSource: `${o.title} ${target.model}`,
        provider: target.providerId,
        model: target.model,
      });
      return r.ok ? { ok: true, chatId: r.chatId, root: r.root } : { ok: false, message: r.message };
    },
    onCreated: () => void getApp().reload(),
    run: async (target, chatId, root) => {
      const sc: ScheduledPrompt = {
        id: `fanout-${crypto.randomUUID()}`,
        title: `${o.title} · ${target.name}`,
        prompt: o.prompt,
        projectId: o.projectId,
        providerId: target.providerId,
        model: target.model,
        access: o.access,
        schedule: { kind: "once", at: Date.now() },
        enabled: true,
        createdAt: Date.now(),
        lastChatId: chatId,
      };
      // The chat and the folder are the workspace's: never a chat found by title, never the main checkout.
      const result = await executeScheduledRun(
        sc,
        { ...base, projectRoot: () => root, findChat: async () => chatId },
        o.signal,
      );
      reportChatRun(
        result.chatId,
        result.status === "success" ? "ok" : result.status === "failed" ? "failed" : "stopped",
      );
      if (result.status !== "success") void notifyUnfocused(target.name, result.error?.slice(0, 180) ?? result.status);
      return result;
    },
  });
}
