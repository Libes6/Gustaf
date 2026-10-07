import { ArrowDown, ArrowUp, Check, CircleSlash, GripVertical, Loader2, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { useDialogFocus } from "../lib/useDialogFocus";
import type { QueueItem } from "../lib/mergeQueue";
import {
  STRATEGIES,
  conflictKindKey,
  currentBatch,
  errorView,
  haltingItem,
  hasUnfinished,
  itemErrorText,
  moveItem,
  orderedSelection,
  recentResults,
  statusKey,
  statusTone,
  strategyHintKey,
  strategyKey,
  summarizeQueue,
  toggleInOrder,
} from "../lib/mergeQueueView";
import {
  answerQueueApproval,
  cancelQueue,
  clearQueueError,
  continueQueue,
  defaultTestCommand,
  loadDefaultStrategy,
  loadQueue,
  resumeQueue,
  startQueue,
  useQueueRun,
  type QueuePolicy,
} from "../lib/mergeQueueStore";
import type { MergeStrategy } from "../lib/mergeQueue";
import "../styles/gitCommit.css";
import "../styles/workspaces.css";

/** One workspace of the project as the dialog needs it. */
export type QueueWorkspace = {
  taskId: string;
  title: string;
  branch: string;
  /** The branch it merges into (its base branch), when known. */
  target: string | null;
  ahead: number | null;
  dirty: boolean;
  active: boolean;
};

/**
 * The project's merge queue: pick workspaces and order them, choose how to merge and an optional test command, start.
 * The loop itself lives in `lib/mergeQueueStore.ts`, so closing this dialog does not stop it; reopening shows the
 * persisted queue. The test command runs through the command rules and approval (an approval card appears here).
 */
export function MergeQueueDialog({
  root,
  projectName,
  workspaces,
  preselect,
  policy,
  onClose,
  onResolve,
  onArchive,
}: {
  root: string;
  projectName: string;
  workspaces: readonly QueueWorkspace[];
  preselect?: string | null;
  policy: QueuePolicy;
  onClose: () => void;
  /** Opens the workspace chat with a drafted conflict instruction (never sent). */
  onResolve: (item: QueueItem) => void;
  onArchive: (taskId: string) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, onClose);
  const run = useQueueRun(root);
  const candidates = useMemo(() => workspaces.filter((w) => w.active), [workspaces]);
  const eligible = (w: QueueWorkspace) => !w.dirty && w.ahead !== 0;
  const [order, setOrder] = useState<string[]>(() => candidates.map((w) => w.taskId));
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(preselect && candidates.some((w) => w.taskId === preselect && eligible(w)) ? [preselect] : []),
  );
  const [strategy, setStrategy] = useState<MergeStrategy>("merge");
  const [command, setCommand] = useState("");
  const touched = useRef(false);
  const [compose, setCompose] = useState(false);
  const [started, setStarted] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadQueue(root);
    void loadDefaultStrategy(root).then((s) => {
      if (!cancelled) setStrategy(s);
    });
    void defaultTestCommand(root).then((c) => {
      if (!cancelled && !touched.current) setCommand(c);
    });
    return () => {
      cancelled = true;
    };
  }, [root]);
  // Workspaces that appear later join the end of the list.
  useEffect(() => {
    setOrder((o) => [
      ...o.filter((id) => candidates.some((w) => w.taskId === id)),
      ...candidates.map((w) => w.taskId).filter((id) => !o.includes(id)),
    ]);
  }, [candidates]);

  const state = run.state;
  const byTask = useMemo(() => new Map(workspaces.map((w) => [w.taskId, w])), [workspaces]);
  const batch = currentBatch(state, started);
  const summary = summarizeQueue({ ...(state ?? { version: 1, halted: false, updatedAt: 0 }), items: batch });
  const unfinished = hasUnfinished(state);
  const halted = !!state?.halted;
  const progress = !compose && (unfinished || halted || run.busy || (started.length > 0 && batch.length > 0));
  const failed = haltingItem(state);
  const err = run.error ? errorView(run.error) : null;
  const ordered = order.map((id) => candidates.find((w) => w.taskId === id)).filter((w): w is QueueWorkspace => !!w);

  const start = () => {
    const ids = orderedSelection(order, checked);
    if (!ids.length) return;
    setCompose(false);
    setStarted(ids);
    void startQueue(root, { taskIds: ids, strategy, testCommand: command }, policy);
  };
  const toggle = (id: string) => {
    const n = toggleInOrder(order, checked, id);
    setOrder(n.order);
    setChecked(n.checked);
  };
  const move = (from: number, to: number) => setOrder((o) => moveItem(o, from, to));
  const nameOf = (id: string) => byTask.get(id)?.title ?? id;
  const testingFor = (id: string) => (run.testing?.taskId === id ? run.testing : null);

  const statusChip = (item: QueueItem) => {
    const tone = statusTone(item.status);
    const icon =
      tone === "active" ? (
        <Loader2 size={12} className="spin" aria-hidden="true" />
      ) : tone === "ok" ? (
        <Check size={12} aria-hidden="true" />
      ) : tone === "fail" ? (
        <XCircle size={12} aria-hidden="true" />
      ) : tone === "skipped" ? (
        <CircleSlash size={12} aria-hidden="true" />
      ) : null;
    return (
      <span className={`mq-status ${tone}`} data-status={item.status}>
        {icon} {t(statusKey(item.status))}
      </span>
    );
  };

  return createPortal(
    <div
      className="review-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        className="review-dialog ws-dialog mq-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("mqTitle")}
      >
        <header>
          <strong>
            {t("mqTitle")} · {projectName}
          </strong>
          <button className="icon-btn" title={t("mqClose")} aria-label={t("mqClose")} onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="git-body">
          {err && (
            <div className="error-box git-error mq-error" role="alert">
              <div>{t(err.key, err.vars)}</div>
              {err.retryable && (
                <div className="mq-error-actions">
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      clearQueueError(root);
                      if (unfinished) void continueQueue(root, policy);
                    }}
                  >
                    {t(unfinished ? "mqTryAgain" : "dismiss")}
                  </button>
                </div>
              )}
              {!err.retryable && (
                <div className="mq-error-actions">
                  <button className="btn btn-ghost" onClick={() => clearQueueError(root)}>
                    {t("dismiss")}
                  </button>
                </div>
              )}
            </div>
          )}

          {run.approval && (
            <div className="approval mq-approval" role="alertdialog" aria-label={t("approveCommand")}>
              <div className="q">{t("mqApprove", { name: nameOf(run.approval.taskId) })}</div>
              <pre>{run.approval.command}</pre>
              <div className="git-note muted">{t("mqApproveWhere", { path: run.approval.cwd })}</div>
              <div className="btns">
                <button className="btn btn-ghost" onClick={() => answerQueueApproval(root, false)}>
                  {t("deny")}
                </button>
                <button className="btn btn-primary" onClick={() => answerQueueApproval(root, true)}>
                  {t("allow")}
                </button>
              </div>
            </div>
          )}

          {progress ? (
            <>
              <div className="git-note muted" role="status" aria-live="polite">
                {run.busy
                  ? t("mqRunning")
                  : halted
                    ? t("mqHalted")
                    : summary.done
                      ? t("mqDone", { merged: summary.merged, total: summary.total })
                      : unfinished
                        ? t("mqPaused")
                        : ""}
              </div>
              <ol className="mq-items" aria-label={t("mqItems")}>
                {batch.map((item) => {
                  const ws = byTask.get(item.taskId);
                  return (
                    <li key={item.taskId} className={`mq-item ${statusTone(item.status)}`} data-task={item.taskId}>
                      <div className="mq-item-head">
                        <span className="mq-name">{nameOf(item.taskId)}</span>
                        <span className="mq-branch">
                          {item.branch} → {item.targetBranch}
                        </span>
                        {statusChip(item)}
                      </div>
                      {testingFor(item.taskId) && (
                        <div className="git-note muted">
                          {t("mqTesting", { command: testingFor(item.taskId)!.command })}
                        </div>
                      )}
                      {item.status === "failed" && (
                        <div className="mq-fail">
                          {item.conflicts.length > 0 ? (
                            <>
                              <div className="git-note bad">
                                {t("mqConflictsIn", { count: item.conflicts.length, target: item.targetBranch })}
                              </div>
                              <ul className="mq-files">
                                {item.conflicts.map((c) => (
                                  <li key={c.path}>
                                    <span className="path">{c.path}</span>
                                    <span className="kind">{t(conflictKindKey(c.kind))}</span>
                                  </li>
                                ))}
                              </ul>
                              {ws && (
                                <button className="btn btn-soft" onClick={() => onResolve(item)}>
                                  {t("mqResolve")}
                                </button>
                              )}
                            </>
                          ) : (
                            <pre className="mq-output">
                              {(run.lastTest?.taskId === item.taskId && !run.lastTest.ok
                                ? run.lastTest.output
                                : itemErrorText(item)) || t("mqFailedNoDetail")}
                            </pre>
                          )}
                        </div>
                      )}
                      {item.status === "skipped" && item.error && <div className="git-note muted">{item.error}</div>}
                      {item.status === "merged" && ws?.active && (
                        <button className="btn btn-ghost mq-archive" onClick={() => onArchive(item.taskId)}>
                          {t("mqArchiveAfter")}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            </>
          ) : (
            <>
              <div className="git-note muted">{t("mqIntro")}</div>
              {!ordered.length && <div className="hint">{t("mqNoWorkspaces")}</div>}
              <ol className="mq-list" aria-label={t("mqPick")}>
                {ordered.map((w, i) => {
                  const ok = eligible(w);
                  return (
                    <li
                      key={w.taskId}
                      className={`mq-pick${dragging === w.taskId ? " dragging" : ""}`}
                      draggable={checked.has(w.taskId)}
                      data-task={w.taskId}
                      onDragStart={(e) => {
                        setDragging(w.taskId);
                        e.dataTransfer.setData("text/mq", w.taskId);
                      }}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(e) => {
                        if (dragging) e.preventDefault();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const from = order.indexOf(e.dataTransfer.getData("text/mq") || dragging || "");
                        if (from >= 0) move(from, i);
                        setDragging(null);
                      }}
                    >
                      <GripVertical size={14} className="grip" aria-hidden="true" />
                      <label>
                        <input
                          type="checkbox"
                          checked={checked.has(w.taskId)}
                          disabled={!ok}
                          onChange={() => toggle(w.taskId)}
                        />
                        <span className="mq-name">{w.title}</span>
                        <span className="mq-branch">
                          {w.branch}
                          {w.target ? ` → ${w.target}` : ""}
                        </span>
                        {w.dirty && <span className="mq-hint">{t("mqDirtyHint")}</span>}
                        {!w.dirty && w.ahead === 0 && <span className="mq-hint">{t("mqNothingToMerge")}</span>}
                      </label>
                      <button
                        className="icon-btn"
                        title={t("mqMoveUp")}
                        aria-label={t("mqMoveUpTitle", { title: w.title })}
                        disabled={i === 0}
                        onClick={() => move(i, i - 1)}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        className="icon-btn"
                        title={t("mqMoveDown")}
                        aria-label={t("mqMoveDownTitle", { title: w.title })}
                        disabled={i === ordered.length - 1}
                        onClick={() => move(i, i + 1)}
                      >
                        <ArrowDown size={14} />
                      </button>
                    </li>
                  );
                })}
              </ol>
              <fieldset className="mq-strategy">
                <legend>{t("mqStrategy")}</legend>
                {STRATEGIES.map((s) => (
                  <label key={s}>
                    <input
                      type="radio"
                      name="mq-strategy"
                      value={s}
                      checked={strategy === s}
                      onChange={() => setStrategy(s)}
                    />
                    <span>{t(strategyKey(s))}</span>
                    <span className="mq-hint">{t(strategyHintKey(s))}</span>
                  </label>
                ))}
              </fieldset>
              <div>
                <label htmlFor="mq-test">{t("mqTestCommand")}</label>
                <input
                  id="mq-test"
                  className="input"
                  value={command}
                  placeholder={t("mqTestPlaceholder")}
                  onChange={(e) => {
                    touched.current = true;
                    setCommand(e.target.value);
                  }}
                />
                <div className="git-note muted">{t("mqTestHint")}</div>
              </div>
              {recentResults(state).length > 0 && (
                <div className="mq-recent">
                  <strong>{t("mqRecent")}</strong>
                  <ul>
                    {recentResults(state).map((i) => (
                      <li key={`${i.taskId}-${i.finishedAt}`}>
                        <span className="mq-name">{nameOf(i.taskId)}</span> {statusChip(i)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
        <div className="review-actions git-actions">
          <span className="grow" />
          {progress ? (
            <>
              {(run.busy || unfinished || halted) && (
                <button className="btn btn-ghost" onClick={() => void cancelQueue(root)}>
                  {t("mqCancel")}
                </button>
              )}
              {halted && !run.busy && (
                <>
                  <button className="btn btn-ghost" onClick={() => void resumeQueue(root, policy, { retry: false })}>
                    {t("mqSkipContinue")}
                  </button>
                  <button
                    className="btn btn-primary"
                    title={failed ? t("mqResumeHint") : undefined}
                    onClick={() => void resumeQueue(root, policy)}
                  >
                    {t("mqResume")}
                  </button>
                </>
              )}
              {!halted && !run.busy && unfinished && !run.approval && (
                <button className="btn btn-primary" onClick={() => void continueQueue(root, policy)}>
                  {t("mqContinue")}
                </button>
              )}
              {!run.busy && !unfinished && !halted && (
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setCompose(true);
                    setStarted([]);
                  }}
                >
                  {t("mqNew")}
                </button>
              )}
              <button className="btn btn-ghost" onClick={onClose}>
                {t("mqClose")}
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={onClose}>
                {t("cancel")}
              </button>
              <button className="btn btn-primary" disabled={!checked.size || run.busy} onClick={start}>
                {t("mqStart")}
              </button>
            </>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
