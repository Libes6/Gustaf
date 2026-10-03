import { FilePen, FileText, FolderTree, Monitor, Search, SquareTerminal, Undo2, Wrench } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { actionKind, undoBlocker, type ActionEntry } from "../agent/actionLog";
import { clearActionLog, undoLogEntry, useActionLog, type UndoOutcome } from "../agent/actionLogStore";
import { useT, type Key } from "../i18n";
import "../styles/rules.css";

const ICONS: Record<string, typeof Wrench> = { read_file: FileText, list_dir: FolderTree, search: Search, edit_file: FilePen, write_file: FilePen, run_command: SquareTerminal, computer: Monitor };
const TOOL_LABEL: Record<string, Key> = { read_file: "actionRead", list_dir: "actionList", search: "actionSearch", edit_file: "actionEdit", write_file: "actionWrite", run_command: "actionCommand", computer: "actionComputer" };
const STATUS_LABEL: Record<ActionEntry["status"], Key> = {
  running: "action_running", success: "action_success", error: "action_error", blocked: "action_blocked", declined: "action_declined", cancelled: "action_cancelled", interrupted: "action_interrupted",
};
const UNDO_MESSAGE: Record<string, Key> = { busy: "undoBusy", later: "undoLater", changed: "undoChanged", closed: "undoClosed", unsupported: "undoUnsupported", done: "undoDone", none: "undoNone" };

type Filter = "all" | "commands" | "edits" | "problems";
const FILTERS: { id: Filter; label: Key }[] = [
  { id: "all", label: "logFilterAll" },
  { id: "commands", label: "logFilterCommands" },
  { id: "edits", label: "logFilterEdits" },
  { id: "problems", label: "logFilterProblems" },
];
const PROBLEMS = new Set<ActionEntry["status"]>(["error", "blocked", "declined", "cancelled", "interrupted"]);
const matches = (f: Filter, e: ActionEntry) => f === "all" || (f === "commands" ? actionKind(e.tool) === "command" : f === "edits" ? actionKind(e.tool) === "edit" : PROBLEMS.has(e.status));

const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const duration = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Chronological record of what the agent did, with the allow/ask/deny decision behind each command and an undo for file edits. */
export function ActionLog() {
  const t = useT();
  const { entries, active } = useActionLog();
  const [filter, setFilter] = useState<Filter>("all");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const shown = useMemo(() => entries.filter((e) => matches(filter, e)).reverse(), [entries, filter]);
  const time = (at: number) => new Date(at).toLocaleTimeString(t.locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const day = (at: number) => new Intl.DateTimeFormat(t.locale, { dateStyle: "medium" }).format(at);

  const approval = (e: ActionEntry): string | undefined => {
    if (e.status === "blocked") return e.rule ? t("logBlockedBy", { rule: e.rule }) : undefined;
    if (e.status === "declined") return t("logDeclined");
    if (e.approval === "rule") return e.rule ? t("logAllowedRule", { rule: e.rule }) : t("logAllowedRules");
    if (e.approval === "mode") return t("logFullAccess");
    if (e.approval === "user") return e.rule ? t("logApprovedRule", { rule: e.rule }) : t("logApproved");
    return undefined;
  };
  const undoText = (r: UndoOutcome) => (r.ok ? "" : r.reason === "failed" ? t("undoFailed", { message: r.message ?? "" }) : t(UNDO_MESSAGE[r.reason]));

  const undo = async (e: ActionEntry) => {
    setWorking(e.id);
    setNotes((n) => ({ ...n, [e.id]: "" }));
    try {
      const r = await undoLogEntry(e.id);
      if (!r.ok) setNotes((n) => ({ ...n, [e.id]: undoText(r) }));
    } catch (err) {
      setNotes((n) => ({ ...n, [e.id]: t("undoFailed", { message: String((err as Error)?.message ?? err) }) }));
    } finally {
      setWorking(null);
    }
  };

  let lastDay = "";
  return (
    <>
      <h4 aria-level={2}>{t("actionLog")}</h4>
      <p className="h4-sub">{t("actionLogLead")}</p>
      <div className="log-bar">
        <div className="seg" role="group" aria-label={t("actionLog")}>
          {FILTERS.map((f) => (
            <button key={f.id} className={filter === f.id ? "active" : ""} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{t(f.label)}</button>
          ))}
        </div>
        <span className="grow" />
        {entries.length > 0 && (
          <button className="btn-soft" onClick={() => (confirm ? (clearActionLog(), setConfirm(false)) : setConfirm(true))} onBlur={() => setConfirm(false)}>
            {t(confirm ? "logClearConfirm" : "logClear")}
          </button>
        )}
      </div>
      <div className="card">
        {!shown.length && <div className="card-row d">{t("actionLogEmpty")}</div>}
        {shown.map((e) => {
          const Icon = ICONS[e.tool] ?? Wrench;
          const label = TOOL_LABEL[e.tool] ? t(TOOL_LABEL[e.tool]) : e.tool;
          const d = day(e.at);
          const header = d !== lastDay ? <div className="log-day">{d}</div> : null;
          lastDay = d;
          const block = e.undo ? undoBlocker(entries, e, active) : "none";
          const blockText = block === "running" ? t("undoBusy") : block === "later" ? t("undoLater") : undefined;
          const sub = [e.source === "scheduled" ? t("logSourceScheduled") : undefined, e.project ? folderName(e.project) : undefined, approval(e), e.durationMs !== undefined && e.status !== "running" ? duration(e.durationMs) : undefined].filter(Boolean).join(" · ");
          return (
            <Fragment key={e.id}>
              {header}
              <div className="card-row log-row">
                <span className="log-time">{time(e.at)}</span>
                <Icon size={14} className="log-icon" aria-hidden />
                <div className="log-main">
                  <div className="log-head">
                    <span className="log-tool">{label}</span>
                    <span className="log-summary" title={e.summary}>{e.summary}</span>
                  </div>
                  {sub && <div className="log-sub">{sub}</div>}
                  {e.status === "error" && e.detail && <div className="log-sub problem">{e.detail}</div>}
                  {notes[e.id] && <div className="log-note" role="alert">{notes[e.id]}</div>}
                </div>
                <span className={`log-status ${e.status}`}>{t(STATUS_LABEL[e.status])}</span>
                {e.undo && (
                  <span className="log-actions">
                    {e.undo.undone ? (
                      <span className="done">{t("logUndone")}</span>
                    ) : (
                      <button className="btn-soft" disabled={!!block || working === e.id} title={blockText ?? t("logUndoTitle")} onClick={() => undo(e)}>
                        <Undo2 size={12} /> {t("logUndo")}
                      </button>
                    )}
                  </span>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
    </>
  );
}
