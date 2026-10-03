import { useState } from "react";
import { useT, type Key } from "../i18n";
import { getRunner, useRunnerVersion } from "../lib/scheduledRuntime";
import {
  capAccess,
  createSchedule,
  editSchedule,
  MAX_PROMPT,
  MAX_SCHEDULES,
  MAX_TITLE,
  MIN_INTERVAL_MINUTES,
  setEnabled,
  validateDraft,
  type Draft,
  type DraftIssue,
  type RunStatus,
  type Schedule,
  type ScheduledPrompt,
} from "../lib/scheduledPrompts";
import { updateScheduled, useScheduled } from "../lib/scheduledPromptsStore";
import { modelKey, useApp } from "../state";
import "../styles/scheduled.css";

// Settings: scheduled prompts. The list, a toggle that confirms a schedule (nothing runs before it is switched on),
// "Run now", and the creation/edit form. The scheduling logic is in lib/scheduledPrompts.ts, runs in lib/scheduledRun.ts.

const STATUS: Record<RunStatus, Key> = {
  running: "scheduledStatusRunning",
  success: "scheduledStatusSuccess",
  failed: "scheduledStatusFailed",
  attention: "scheduledStatusAttention",
  stopped: "scheduledStatusStopped",
  missed: "scheduledStatusMissed",
  interrupted: "scheduledStatusInterrupted",
};
const ISSUE: Record<DraftIssue, Key> = {
  title: "scheduledIssueTitle",
  prompt: "scheduledIssuePrompt",
  promptLong: "scheduledIssuePromptLong",
  provider: "scheduledIssueProvider",
  interval: "scheduledIssueInterval",
  time: "scheduledIssueTime",
  once: "scheduledIssueOnce",
  limit: "scheduledIssueLimit",
};

/** `datetime-local` value (local time, minutes) of a timestamp, and back. */
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

type Form = {
  title: string;
  prompt: string;
  projectId: string;
  model: string;
  access: "readonly" | "auto";
  kind: Schedule["kind"];
  at: string;
  every: string;
  unit: "minutes" | "hours";
  time: string;
};

function Toggle({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`toggle${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}

export function ScheduledPromptsSection() {
  const t = useT();
  const app = useApp();
  const list = useScheduled();
  useRunnerVersion();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [issues, setIssues] = useState<DraftIssue[]>([]);
  const [note, setNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const runner = getRunner();

  const models = app.models.filter((m) => !app.hiddenModels.includes(modelKey(m)) || (app.selection?.providerId === m.providerId && app.selection.model === m.id));
  const encode = (providerId: string, model: string) => `${providerId}\n${model}`;
  const when = (ms: number) => t.date(ms);

  const describe = (s: Schedule) => {
    switch (s.kind) {
      case "once": return t("scheduledDescOnce", { when: when(s.at) });
      case "interval": return s.everyMinutes % 60 === 0 ? t("scheduledDescEveryHour", { n: s.everyMinutes / 60 }) : t("scheduledDescEveryMin", { n: s.everyMinutes });
      case "daily": return t("scheduledDescDaily", { time: s.time });
      case "weekdays": return t("scheduledDescWeekdays", { time: s.time });
    }
  };

  const open = (s?: ScheduledPrompt) => {
    const sel = app.selection;
    const iv = s?.schedule.kind === "interval" ? s.schedule.everyMinutes : 60;
    setNote("");
    setIssues([]);
    setEditing(s?.id ?? "new");
    setForm({
      title: s?.title ?? "",
      prompt: s?.prompt ?? "",
      projectId: s?.projectId != null ? String(s.projectId) : "",
      model: s ? encode(s.providerId, s.model) : sel ? encode(sel.providerId, sel.model) : "",
      access: s?.access ?? capAccess(app.access),
      kind: s?.schedule.kind ?? "daily",
      at: s?.schedule.kind === "once" ? toLocalInput(s.schedule.at) : toLocalInput(Date.now() + 3_600_000),
      every: String(iv % 60 === 0 ? iv / 60 : iv),
      unit: iv % 60 === 0 ? "hours" : "minutes",
      time: s && (s.schedule.kind === "daily" || s.schedule.kind === "weekdays") ? s.schedule.time : "09:00",
    });
  };
  const close = () => {
    setEditing(null);
    setForm(null);
  };

  const draftOf = (f: Form): Draft => {
    const i = f.model.indexOf("\n");
    const schedule: Schedule =
      f.kind === "once" ? { kind: "once", at: new Date(f.at).getTime() }
      : f.kind === "interval" ? { kind: "interval", everyMinutes: Math.round(Number(f.every.replace(",", ".")) * (f.unit === "hours" ? 60 : 1)) }
      : { kind: f.kind, time: f.time };
    return { title: f.title, prompt: f.prompt, projectId: f.projectId ? Number(f.projectId) : null, providerId: i > 0 ? f.model.slice(0, i) : "", model: i > 0 ? f.model.slice(i + 1) : "", access: f.access, schedule };
  };

  const save = () => {
    if (!form) return;
    const draft = draftOf(form);
    const others = list.filter((s) => s.id !== editing).length;
    const found = validateDraft(draft, Date.now(), others);
    // A one-off that is already on keeps its time check only when its time changed; an unchanged past one is edited elsewhere.
    setIssues(found);
    if (found.length) return;
    if (editing === "new") updateScheduled((l) => [...l, createSchedule(draft, crypto.randomUUID(), Date.now())]);
    else updateScheduled((l) => l.map((s) => (s.id === editing ? editSchedule(s, draft) : s)));
    setNote(t("scheduledSavedOff"));
    close();
  };

  const toggle = (s: ScheduledPrompt, on: boolean) => {
    const now = Date.now();
    if (!setEnabled(s, on, now)) return setNote(t("scheduledIssueOnce"));
    setNote("");
    updateScheduled((l) => l.map((x) => (x.id === s.id ? setEnabled(x, on, now) ?? x : x)));
  };

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const issueText = (i: DraftIssue) => t(ISSUE[i], { max: i === "promptLong" ? MAX_PROMPT : MAX_SCHEDULES, min: MIN_INTERVAL_MINUTES });
  const projectName = (id: number | null) => (id === null ? t("scheduledNoProject") : app.projects.find((p) => p.id === id)?.name ?? "?");
  const modelName = (s: ScheduledPrompt) => app.models.find((m) => m.providerId === s.providerId && m.id === s.model)?.name ?? s.model;

  return (
    <>
      <h4>{t("scheduledTitle")}</h4>
      <p className="h4-sub">{t("scheduledLead")}</p>
      <p className="h4-sub sched-safety">{t("scheduledSafety")}</p>
      <div className="card">
        {!list.length && !form && <div className="card-row d">{t("scheduledNone")}</div>}
        {list.map((s) => {
          const running = runner?.isRunning(s.id) ?? false;
          return (
            <div className="sched-row" key={s.id}>
              <div className="sched-line">
                <div className="grow">
                  <div className="t">⏰ {s.title}</div>
                  <div className="d">{describe(s.schedule)} · {projectName(s.projectId)} · {modelName(s)} · {t(s.access === "auto" ? "scheduledAccessAuto" : "scheduledAccessReadonly").split(" (")[0]}</div>
                </div>
                <Toggle on={s.enabled} label={t("scheduledEnabled", { title: s.title })} onChange={(v) => toggle(s, v)} />
              </div>
              <div className="d sched-meta">
                {s.enabled ? (s.nextRunAt ? t("scheduledNext", { when: when(s.nextRunAt) }) : t("scheduledNextNone")) : t("scheduledNotConfirmed")}
              </div>
              {s.lastStatus && (
                <div className={`d sched-meta sched-${s.lastStatus}`}>
                  {t("scheduledLast", { status: t(STATUS[s.lastStatus]), when: s.lastRunAt ? when(s.lastRunAt) : "—" })}
                  {s.lastError ? ` · ${s.lastError}` : ""}
                </div>
              )}
              <div className="sched-actions">
                {running ? (
                  <button className="btn-soft" onClick={() => runner?.stop(s.id)}>{t("scheduledStop")}</button>
                ) : (
                  <button className="btn-soft" disabled={!runner} onClick={() => runner?.runNow(s.id)}>{t("scheduledRunNow")}</button>
                )}
                {s.lastChatId !== undefined && <button className="btn-soft" onClick={() => { app.openChat(s.lastChatId!, s.projectId); app.setView("chat"); }}>{t("scheduledOpenChat")}</button>}
                <button className="btn-soft" disabled={running} onClick={() => open(s)}>{t("scheduledEdit")}</button>
                <button
                  className="btn-soft btn-danger"
                  disabled={running}
                  onBlur={() => setConfirmDelete(null)}
                  onClick={() => (confirmDelete === s.id ? (updateScheduled((l) => l.filter((x) => x.id !== s.id)), setConfirmDelete(null)) : setConfirmDelete(s.id))}
                >
                  {t(confirmDelete === s.id ? "scheduledDeleteConfirm" : "scheduledDelete")}
                </button>
              </div>
            </div>
          );
        })}
        {form && (
          <div className="sched-form">
            <label className="field"><span>{t("scheduledFieldTitle")}</span>
              <input className="input" maxLength={MAX_TITLE} value={form.title} onChange={(e) => set("title", e.target.value)} />
            </label>
            <label className="field"><span>{t("scheduledFieldPrompt")}</span>
              <textarea className="input sched-prompt" value={form.prompt} onChange={(e) => set("prompt", e.target.value)} />
            </label>
            <div className="sched-grid">
              <label className="field"><span>{t("scheduledFieldProject")}</span>
                <select className="input" value={form.projectId} onChange={(e) => set("projectId", e.target.value)}>
                  <option value="">{t("scheduledNoProject")}</option>
                  {app.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label className="field"><span>{t("scheduledFieldModel")}</span>
                <select className="input" value={form.model} onChange={(e) => set("model", e.target.value)}>
                  {!models.some((m) => encode(m.providerId, m.id) === form.model) && <option value={form.model}>{form.model.split("\n")[1] ?? ""}</option>}
                  {models.map((m) => <option key={modelKey(m)} value={encode(m.providerId, m.id)}>{app.providers.find((p) => p.id === m.providerId)?.name ?? m.providerId} · {m.name}</option>)}
                </select>
              </label>
              <label className="field"><span>{t("scheduledFieldAccess")}</span>
                <select className="input" value={form.access} onChange={(e) => set("access", capAccess(e.target.value))}>
                  <option value="readonly">{t("scheduledAccessReadonly")}</option>
                  <option value="auto">{t("scheduledAccessAuto")}</option>
                </select>
              </label>
              <label className="field"><span>{t("scheduledFieldSchedule")}</span>
                <select className="input" value={form.kind} onChange={(e) => set("kind", e.target.value as Schedule["kind"])}>
                  <option value="daily">{t("scheduledKindDaily")}</option>
                  <option value="weekdays">{t("scheduledKindWeekdays")}</option>
                  <option value="interval">{t("scheduledKindInterval")}</option>
                  <option value="once">{t("scheduledKindOnce")}</option>
                </select>
              </label>
            </div>
            {form.kind === "once" && (
              <label className="field"><span>{t("scheduledAt")}</span>
                <input className="input sched-narrow" type="datetime-local" value={form.at} onChange={(e) => set("at", e.target.value)} />
              </label>
            )}
            {form.kind === "interval" && (
              <label className="field"><span>{t("scheduledEvery")}</span>
                <div className="sched-inline">
                  <input className="input sched-num" inputMode="decimal" value={form.every} onChange={(e) => set("every", e.target.value)} />
                  <select className="input sched-narrow" value={form.unit} onChange={(e) => set("unit", e.target.value as Form["unit"])}>
                    <option value="minutes">{t("scheduledUnitMinutes")}</option>
                    <option value="hours">{t("scheduledUnitHours")}</option>
                  </select>
                </div>
              </label>
            )}
            {(form.kind === "daily" || form.kind === "weekdays") && (
              <label className="field"><span>{t("scheduledTime")}</span>
                <input className="input sched-narrow" type="time" value={form.time} onChange={(e) => set("time", e.target.value)} />
              </label>
            )}
            {issues.length > 0 && <div className="sched-issues" role="alert">{issues.map((i) => <div key={i}>{issueText(i)}</div>)}</div>}
            <div className="sched-actions">
              <button className="btn btn-primary" onClick={save}>{t("scheduledSave")}</button>
              <button className="btn btn-ghost" onClick={close}>{t("scheduledCancel")}</button>
            </div>
          </div>
        )}
      </div>
      {note && <p className="d sched-note" role="status">{note}</p>}
      {!form && (
        <button className="btn-soft sched-add" disabled={list.length >= MAX_SCHEDULES} onClick={() => open()}>{t("scheduledAdd")}</button>
      )}
    </>
  );
}
