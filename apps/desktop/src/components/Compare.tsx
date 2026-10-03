import { Check, Play, RotateCw, Search, Square, X, MessageSquarePlus } from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useT } from "../i18n";
import { displayKeys } from "../lib/platform";
import {
  MAX_COLUMNS, MIN_COLUMNS, anyRunning, canContinue, canRun, compareChatTitle, compareReducer, continueMessages, elapsedMs, emptyCompare,
  estimateOutput, startCompare, toggleTarget, type Column, type CompareRun, type CompareTarget,
} from "../lib/compare";
import { addMessage, createChat } from "../lib/data";
import { useDialogFocus } from "../lib/useDialogFocus";
import { getAdapter } from "../providers";
import { retryNoticeVars } from "../providers/retry";
import { modelKey, useApp, type Model } from "../state";
import { LiveMeter } from "./LiveMeter";
import { Markdown } from "./Markdown";
import { ModelIcon } from "./ModelIcon";
import "../styles/compare.css";

/**
 * Model comparison: one prompt, 2-4 models, answers streamed side by side. Read-only (no tools, no project writes);
 * nothing is stored unless the user continues one answer in a normal chat. The logic is in lib/compare.ts.
 */
export function Compare({ onClose }: { onClose: () => void }) {
  const t = useT();
  const app = useApp();
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef);
  const [state, dispatch] = useReducer(compareReducer, emptyCompare);
  const [prompt, setPrompt] = useState("");
  const [chosen, setChosen] = useState<CompareTarget[]>(() => {
    const m = app.models.find((x) => x.providerId === app.selection?.providerId && x.id === app.selection?.model);
    return m ? [toTarget(m, app)] : [];
  });
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [continuing, setContinuing] = useState<string | null>(null);
  const run = useRef<CompareRun | null>(null);
  const appRef = useRef(app);
  appRef.current = app;
  const busy = anyRunning(state);

  // Closing the view cancels every request that is still running; nothing is kept.
  useEffect(() => () => run.current?.stopAll(), []);
  // Like the model picker: refresh lists older than 10 minutes when the comparison opens.
  useEffect(() => void Promise.resolve(app.ensureModels?.()).catch(() => {}), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);

  const models = useMemo(() => {
    const s = filter.trim().toLowerCase();
    return app.models
      .filter((m) => !app.hiddenModels.includes(modelKey(m)) && !app.providers.find((p) => p.id === m.providerId)?.disabled)
      .filter((m) => !s || m.id.toLowerCase().includes(s) || m.name.toLowerCase().includes(s))
      .sort((a, b) => a.providerId.localeCompare(b.providerId) || b.created - a.created || a.name.localeCompare(b.name));
  }, [app.models, app.hiddenModels, app.providers, filter]);
  const providerName = (id: string) => app.providers.find((p) => p.id === id)?.name ?? id;
  const project = app.projects.find((p) => p.id === app.draftProject);

  function start() {
    if (!canRun(prompt, chosen, busy)) return;
    setError("");
    run.current?.stopAll();
    run.current = startCompare(chosen, prompt.trim(), {
      getAdapter: async (target) => {
        const provider = appRef.current.providers.find((p) => p.id === target.providerId);
        if (!provider) throw new Error(t("compareNoProvider"));
        return getAdapter(provider);
      },
      dispatch,
      onRequest: (target) => appRef.current.bumpUsage(target.providerId),
      onUsage: (target, usage) => appRef.current.recordTokens(target.providerId, target.model, usage),
      cwd: project?.path ?? undefined,
    });
  }

  async function continueInChat(c: Column) {
    if (continuing || !canContinue(c)) return;
    setContinuing(c.key);
    setError("");
    try {
      const projectId = app.draftProject ?? null;
      const id = await createChat(projectId, compareChatTitle(state.prompt, t("newChat")));
      for (const m of continueMessages(state.prompt, c)) await addMessage(id, m);
      app.setSelection({ providerId: c.providerId, model: c.model });
      await app.reload();
      app.openChat(id, projectId);
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setContinuing(null);
    }
  }

  const cols = state.columns;
  return (
    <div className="overlay compare-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <section ref={dialogRef} className="compare" role="dialog" aria-modal="true" aria-label={t("compareTitle")}>
        <header className="compare-head">
          <h2>{t("compareTitle")}</h2>
          <span className="compare-sub">{t("compareReadOnly")}</span>
          <span className="grow" />
          <button className="icon-btn" title={t("compareClose")} aria-label={t("compareClose")} onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="compare-setup">
          <textarea
            autoFocus
            className="compare-prompt"
            rows={3}
            value={prompt}
            placeholder={t("comparePrompt")}
            aria-label={t("comparePrompt")}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start(); } }}
          />
          <div className="compare-models">
            <div className="compare-chosen" aria-live="polite">
              {chosen.map((c) => (
                <span key={c.key} className="compare-chip">
                  {c.label}
                  <button aria-label={t("compareRemove", { name: c.label })} onClick={() => setChosen(toggleTarget(chosen, c))} disabled={busy}>
                    <X size={11} />
                  </button>
                </span>
              ))}
              <span className="compare-count">{t("compareCount", { count: chosen.length, min: MIN_COLUMNS, max: MAX_COLUMNS })}</span>
            </div>
            <label className="compare-filter">
              <Search size={13} />
              <input value={filter} placeholder={t("compareFilter")} aria-label={t("compareFilter")} onChange={(e) => setFilter(e.target.value)} />
            </label>
            <div className="compare-list" role="group" aria-label={t("compareModels")}>
              {models.map((m) => {
                const on = chosen.some((c) => c.key === modelKey(m));
                const full = !on && chosen.length >= MAX_COLUMNS;
                return (
                  <button
                    key={modelKey(m)}
                    className={`compare-opt${on ? " on" : ""}`}
                    role="checkbox"
                    aria-checked={on}
                    disabled={busy || full}
                    title={full ? t("compareLimit", { max: MAX_COLUMNS }) : undefined}
                    onClick={() => setChosen(toggleTarget(chosen, toTarget(m, app)))}
                  >
                    <span className="compare-check">{on && <Check size={12} />}</span>
                    <ModelIcon model={m.id} provider={app.providers.find((p) => p.id === m.providerId)} size={14} />
                    <span className="compare-opt-name">{m.name}</span>
                    <span className="compare-opt-prov">{providerName(m.providerId)}</span>
                  </button>
                );
              })}
              {!models.length && <div className="compare-none">{t("compareNoModels")}</div>}
            </div>
          </div>
          <div className="compare-actions">
            {busy ? (
              <button className="btn btn-soft" onClick={() => run.current?.stopAll()}>
                <Square size={12} /> {t("compareStopAll")}
              </button>
            ) : (
              <button className="btn btn-primary" disabled={!canRun(prompt, chosen)} onClick={start}>
                <Play size={13} /> {t("compareRun")}
              </button>
            )}
            <span className="compare-hint">{t("compareShortcut", { keys: displayKeys("⌘↵") })}</span>
          </div>
          {error && <div className="compare-error" role="alert">{error}</div>}
        </div>

        {cols.length > 0 && (
          <div className="compare-cols" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
            {cols.map((c) => (
              <ColumnView
                key={c.key}
                c={c}
                provider={app.providers.find((p) => p.id === c.providerId)}
                providerName={providerName(c.providerId)}
                continuing={continuing === c.key}
                onStop={() => run.current?.stop(c.key)}
                onRerun={() => void run.current?.rerun(c.key)}
                onContinue={() => void continueInChat(c)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function toTarget(m: Model, app: { providers: { id: string; name: string }[] }): CompareTarget {
  const provider = app.providers.find((p) => p.id === m.providerId);
  return { key: modelKey(m), providerId: m.providerId, model: m.id, label: provider ? `${m.name} · ${provider.name}` : m.name };
}

function ColumnView({ c, provider, providerName, continuing, onStop, onRerun, onContinue }: {
  c: Column;
  provider: ReturnType<typeof useApp>["providers"][number] | undefined;
  providerName: string;
  continuing: boolean;
  onStop: () => void;
  onRerun: () => void;
  onContinue: () => void;
}) {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement>(null);
  const running = c.status === "running";
  useEffect(() => {
    const el = bodyRef.current;
    if (el && running) el.scrollTop = el.scrollHeight;
  }, [c.text, running]);
  return (
    <article className={`compare-col ${c.status}`} aria-label={c.label}>
      <header className="compare-col-head">
        <ModelIcon model={c.model} provider={provider} size={16} />
        <div className="compare-col-title">
          <strong title={c.model}>{c.model}</strong>
          <span>{providerName}</span>
        </div>
        <span className={`compare-status ${c.status}`}>{t(`compareStatus_${c.status}`)}</span>
      </header>
      <div className="compare-col-body" ref={bodyRef}>
        {c.text ? <Markdown text={c.text} /> : running && !c.retry ? <div className="compare-wait">{t("compareWaiting")}</div> : null}
        {c.retry && <div className="compare-retry">{t("retryingIn", retryNoticeVars(c.retry))}</div>}
        {c.status === "error" && c.error && (
          <div className="compare-col-error" role="alert">
            <div>{c.error.message}</div>
            {c.error.kind && <div className="compare-error-note">{c.error.retryable ? t("compareRetryable") : t("compareNotRetryable")}</div>}
          </div>
        )}
        {c.status === "stopped" && !c.text && <div className="compare-wait">{t("compareStoppedEmpty")}</div>}
      </div>
      <footer className="compare-col-foot">
        <Meter c={c} />
        <span className="grow" />
        {running && (
          <button className="btn btn-soft" onClick={onStop}>
            <Square size={11} /> {t("stop")}
          </button>
        )}
        {(c.status === "error" || c.status === "stopped") && (
          <button className="btn btn-soft" onClick={onRerun}>
            <RotateCw size={12} /> {t("compareRerun")}
          </button>
        )}
        {canContinue(c) && (
          <button className="btn btn-soft" disabled={continuing} onClick={onContinue}>
            <MessageSquarePlus size={13} /> {t("compareContinue")}
          </button>
        )}
      </footer>
    </article>
  );
}

/** Live estimate while running (the chat's LiveMeter), then the provider's own counts, or the estimate when it reports none. */
function Meter({ c }: { c: Column }) {
  const t = useT();
  if (c.status === "running") return <LiveMeter stats={{ start: c.start, chars: c.chars, input: c.input }} />;
  const seconds = (elapsedMs(c, 0) / 1000).toFixed(1);
  if (c.usage) return <span className="live-meter" title={t("compareUsageHint")}>{t("compareUsage", { input: t.num(c.usage.input), output: t.num(c.usage.output), seconds })}</span>;
  return <span className="live-meter" title={t("liveMeterHint")}>{t("liveMeter", { input: t.num(c.input), output: t.num(estimateOutput(c)), seconds })}</span>;
}
