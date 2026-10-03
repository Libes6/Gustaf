import { useSyncExternalStore } from "react";
import { nativeInstructionFiles } from "../agent/instructions";
import { translate, type Key } from "../i18n";
import { getAdapter } from "../providers";
import { retryNoticeVars } from "../providers/retry";
import type { AppState } from "../state";
import { db, review } from "./api";
import { beginApproval, notifyUnfocused } from "./attention";
import { checkpoint } from "./checkpoints";
import { beginLiveRun } from "./liveRuns";
import { addMessage, createChat } from "./data";
import { runsOwnTools } from "./modelRouting";
import { prepareShadowCopy } from "./reviewSetupStore";
import { openScheduledApproval } from "./scheduledApprovals";
import { createRunner, executeScheduledRun, type Runner, type ScheduledRunDeps } from "./scheduledRun";
import { getScheduled, updateScheduled } from "./scheduledPromptsStore";

// Glue between the scheduled-prompt runner and the app: builds the injected dependencies from the current app state,
// keeps the one Runner alive for the session and exposes it to the settings section. Started by ScheduledPromptsRuntime.

let runner: Runner | null = null;
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const bump = () => {
  version++;
  listeners.forEach((l) => l());
};

export const getRunner = () => runner;
/** Re-renders when a scheduled run starts or ends. */
export const useRunnerVersion = () => useSyncExternalStore(subscribe, () => version);

function depsFor(getApp: () => AppState): ScheduledRunDeps {
  const t = (key: Key, vars?: Record<string, string | number>) => translate(getApp().locale, key, vars);
  return {
    now: Date.now,
    resolve: async (providerId, model) => {
      const app = getApp();
      const provider = app.providers.find((p) => p.id === providerId && !p.disabled);
      if (!provider) return { error: t("scheduledNoProvider") };
      const info = app.models.find((m) => m.providerId === providerId && m.id === model);
      return { adapter: await getAdapter(provider), supportsTools: info?.tools, nativeInstructions: nativeInstructionFiles(provider), ownTools: runsOwnTools(provider) };
    },
    projectRoot: (projectId) => {
      if (projectId === null) return null;
      const project = getApp().projects.find((p) => p.id === projectId);
      return project ? project.path : undefined;
    },
    allowlist: () => getApp().allowlist,
    reasoning: () => getApp().reasoning,
    findChat: async (projectId, title, preferredId) => {
      if (preferredId) {
        const [row] = await db.select<{ id: number }>("select id from chats where id = ? and archived = 0", [preferredId]);
        if (row) return row.id;
      }
      const rows = await db.select<{ id: number }>(
        projectId === null ? "select id from chats where title = ? and project_id is null and archived = 0 order by updated_at desc limit 1" : "select id from chats where title = ? and project_id = ? and archived = 0 order by updated_at desc limit 1",
        projectId === null ? [title] : [title, projectId],
      );
      return rows[0]?.id ?? null;
    },
    createChat,
    addMessage,
    prepareReview: async (root, approve) => {
      const app = getApp();
      const made = await prepareShadowCopy(root, { access: "auto", allowlist: app.allowlist, approve });
      const error = made.setup === "declined" ? t("reviewSetupDeclined") : made.setup && !made.setup.ok ? t("reviewSetupFailed", { code: made.setup.timedOut ? t("reviewTimedOut") : String(made.setup.code ?? "?"), output: made.setup.output.slice(-600) }) : undefined;
      return { review: made.review, error };
    },
    finishReview: (id) => review.finish(id),
    checkpoint,
    beginApproval,
    askUser: openScheduledApproval,
    live: beginLiveRun,
    retryNotice: (info) => t("retryingIn", retryNoticeVars(info)),
    recordUsage: (providerId, model, usage) => getApp().recordTokens(providerId, model, usage),
    bumpUsage: (providerId) => getApp().bumpUsage(providerId),
    recordResult: (providerId, error) => getApp().recordProviderResult(providerId, error),
    onLimits: (providerId, windows) => getApp().recordLimits(providerId, windows),
    note: (kind, detail) => t(kind === "failed" ? "scheduledNoteFailed" : kind === "attention" ? "scheduledNoteAttention" : "scheduledNoteStopped", { detail: detail ?? "" }),
    chatChanged: () => void getApp().reload(),
  };
}

/** Creates the runner (once per start) for the given app state getter; returns the periodic check and a cleanup. */
export function startScheduledRuntime(getApp: () => AppState): () => void {
  const deps = depsFor(getApp);
  const t = (key: Key, vars?: Record<string, string | number>) => translate(getApp().locale, key, vars);
  runner = createRunner(
    { get: getScheduled, update: updateScheduled },
    async (sc, signal) => {
      const result = await executeScheduledRun(sc, deps, signal);
      const body = result.status === "success" ? t("scheduledNotifyDone") : result.status === "attention" ? t("scheduledNotifyAttention") : result.status === "failed" ? result.error?.slice(0, 180) ?? "" : "";
      if (body) void notifyUnfocused(t("scheduledNotifyTitle", { title: sc.title }), body);
      return result;
    },
    Date.now,
    bump,
  );
  const tick = () => runner?.tick();
  const timer = setInterval(tick, 30_000);
  addEventListener("focus", tick);
  tick();
  return () => {
    clearInterval(timer);
    removeEventListener("focus", tick);
    for (const id of runner?.running() ?? []) runner?.stop(id);
    runner = null;
    bump();
  };
}
