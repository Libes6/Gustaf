import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { db } from "./api";
import { loadMessages } from "./data";
import { startMobileSend, stopMobileRun, type MobileSendDeps, type SendResult } from "./mobileRun";
import { getLiveRun } from "./liveRuns";
import { depsFor } from "./scheduledRuntime";
import type { AppState } from "../state";

// Commands from a paired phone (src-tauri/src/mobile_server/commands.rs forwards them as the `mobile-command` event and waits
// for `mobile_command_reply`): send a message, stop a run, start a chat. The run itself is lib/mobileRun.ts.

type Command = { id: number; kind: string; payload: Record<string, unknown> };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function mobileDeps(getApp: () => AppState): MobileSendDeps {
  return {
    ...depsFor(getApp),
    loadChat: async (chatId) => {
      const [row] = await db.select<{ project_id: number | null; workspace_task_id: string | null }>(
        "select project_id, workspace_task_id from chats where id = ?",
        [chatId],
      );
      return row ? { projectId: row.project_id, workspace: !!row.workspace_task_id } : null;
    },
    loadHistory: (chatId) => loadMessages(chatId),
    defaultTarget: () => {
      const app = getApp();
      const sel = app.selection;
      if (sel && app.providers.some((p) => p.id === sel.providerId && !p.disabled))
        return { providerId: sel.providerId, model: sel.model };
      const p = app.providers.find((x) => !x.disabled);
      const model = p && app.models.find((m) => m.providerId === p.id)?.id;
      return p && model ? { providerId: p.id, model } : null;
    },
    access: () => getApp().access,
  };
}

/** Stop reaches runs started from a phone and scheduled/live runs; a run typed into the chat on the desktop is stopped there. */
function stop(chatId: number): SendResult {
  if (stopMobileRun(chatId)) return { ok: true, chatId };
  const live = getLiveRun(chatId);
  if (live) {
    live.abort();
    return { ok: true, chatId };
  }
  return { ok: false, code: "not_found", message: "Nothing to stop, or it was started on the desktop" };
}

export async function handleMobileCommand(cmd: Command, getApp: () => AppState): Promise<SendResult> {
  const p = cmd.payload;
  try {
    if (cmd.kind === "send") {
      const chatId = num(p.chatId);
      const body = text(p.text);
      if (chatId === undefined || !body)
        return { ok: false, code: "bad_request", message: "chatId and text are required" };
      return await startMobileSend(mobileDeps(getApp), {
        chatId,
        text: body,
        providerId: text(p.providerId),
        model: text(p.model),
      });
    }
    if (cmd.kind === "newChat") {
      const projectId = num(p.projectId);
      const body = text(p.text);
      if (projectId === undefined || !body)
        return { ok: false, code: "bad_request", message: "projectId and text are required" };
      return await startMobileSend(mobileDeps(getApp), { projectId, text: body, title: text(p.title) });
    }
    if (cmd.kind === "stop") {
      const chatId = num(p.chatId);
      return chatId === undefined ? { ok: false, code: "bad_request", message: "chatId is required" } : stop(chatId);
    }
    return { ok: false, code: "bad_request", message: `Unknown command ${cmd.kind}` };
  } catch (e) {
    return { ok: false, code: "failed", message: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}

/** Listens for phone commands for as long as the app runs; returns the stop function. */
export function startMobileCommands(getApp: () => AppState): () => void {
  let off: (() => void) | undefined;
  let stopped = false;
  void listen<Command>("mobile-command", async (e) => {
    const cmd = e.payload;
    const r = await handleMobileCommand(cmd, getApp);
    const data = r.ok ? { chatId: r.chatId } : undefined;
    void invoke("mobile_command_reply", {
      id: cmd.id,
      ok: r.ok,
      code: r.ok ? null : r.code,
      message: r.ok ? null : r.message,
      data,
    }).catch(() => {});
  }).then((un) => (stopped ? un() : (off = un)));
  return () => {
    stopped = true;
    off?.();
  };
}
