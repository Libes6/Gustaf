import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useT, type Key } from "../i18n";
import { refKey, sameRef, type AgentSettings, type ModelRef } from "../agent/agentSettings";
import { saveAgentSettings, useAgentSettings } from "../agent/agentSettingsStore";
import { AGENT_TYPES, DEFAULT_BUDGETS, type AgentType, type Budget } from "../agent/subagentCore";
import { parseTokenLimit } from "../lib/budgets";
import { runsOwnTools } from "../lib/modelRouting";
import { useApp } from "../state";
import "../styles/agents.css";

// Settings > Usage: models, limits, orchestration default and notifications of background agents (stored as "agentSettings").

const TYPE_KEY: Record<AgentType, Key> = { explore: "agentTypeExplore", plan: "agentTypePlan", general: "agentTypeGeneral", review: "agentTypeReview" };
const FIELDS: { key: keyof Budget; label: Key }[] = [
  { key: "maxSteps", label: "agentBudgetSteps" },
  { key: "maxToolCalls", label: "agentBudgetToolCalls" },
  { key: "maxMs", label: "agentBudgetMinutes" },
  { key: "maxTokens", label: "agentBudgetTokens" },
];

const encode = (r: ModelRef | null | undefined) => (r ? `${r.providerId}\n${r.model}` : "");
const decode = (v: string): ModelRef | null => {
  const i = v.indexOf("\n");
  return i > 0 ? { providerId: v.slice(0, i), model: v.slice(i + 1) } : null;
};

/** Shown value of a budget field: minutes for the wall time, the raw number otherwise. */
const show = (k: keyof Budget, v: number | undefined) => (v === undefined ? "" : k === "maxMs" ? String(Math.round((v / 60_000) * 10) / 10) : String(v));
function parseField(k: keyof Budget, text: string): { ok: true; value: number | undefined } | { ok: false } {
  const s = text.trim();
  if (!s) return { ok: true, value: undefined };
  if (k === "maxTokens") {
    const p = parseTokenLimit(s);
    return p.ok ? { ok: true, value: p.value ?? undefined } : { ok: false };
  }
  const n = Number(s.replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return { ok: false };
  if (k === "maxMs") return { ok: true, value: Math.max(1, Math.round(n * 60_000)) };
  return Number.isInteger(n) ? { ok: true, value: n } : { ok: false };
}

function BudgetCell({ type, field, label, settings, onBad }: { type: AgentType; field: keyof Budget; label: string; settings: AgentSettings; onBad: (bad: boolean) => void }) {
  const value = settings.budgets[type]?.[field];
  const [text, setText] = useState(show(field, value));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(show(field, value)), [value, field]);
  const commit = () => {
    const p = parseField(field, text);
    setBad(!p.ok);
    onBad(!p.ok);
    if (!p.ok || p.value === value) return;
    const next = { ...settings.budgets[type] };
    if (p.value === undefined) delete next[field];
    else next[field] = p.value;
    saveAgentSettings({ ...settings, budgets: { ...settings.budgets, [type]: next } });
  };
  return (
    <input className="input agent-budget-input" aria-label={label} aria-invalid={bad} inputMode="numeric" placeholder={show(field, DEFAULT_BUDGETS[type][field])} value={text}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
  );
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}

export function AgentSettingsSection() {
  const t = useT();
  const app = useApp();
  const s = useAgentSettings();
  const [badCells, setBadCells] = useState<Set<string>>(new Set());
  const enabled = app.providers.filter((p) => !p.disabled);
  const label = (r: ModelRef) => {
    const p = app.providers.find((x) => x.id === r.providerId);
    const m = app.models.find((x) => x.providerId === r.providerId && x.id === r.model);
    return `${p?.name ?? r.providerId} · ${m?.name ?? r.model}`;
  };
  // Subagents need our own tool loop: API providers whose model supports tools.
  const agentModels = app.models.filter((m) => m.tools !== false && enabled.some((p) => p.id === m.providerId && !runsOwnTools(p))).map((m) => ({ providerId: m.providerId, model: m.id }));
  const anyModels = app.models.filter((m) => enabled.some((p) => p.id === m.providerId)).map((m) => ({ providerId: m.providerId, model: m.id }));
  const options = (list: ModelRef[], current: ModelRef | null | undefined) => {
    const all = current && !list.some((r) => sameRef(r, current)) ? [current, ...list] : list;
    return all.map((r) => <option key={refKey(r)} value={encode(r)}>{label(r)}</option>);
  };
  const setModel = (type: AgentType, ref: ModelRef | null) => {
    const models = { ...s.models };
    if (ref) models[type] = ref;
    else delete models[type];
    saveAgentSettings({ ...s, models });
  };
  const flag = (id: string) => (bad: boolean) => setBadCells((prev) => {
    if (prev.has(id) === bad) return prev;
    const next = new Set(prev);
    if (bad) next.add(id);
    else next.delete(id);
    return next;
  });

  return (
    <>
      <h4 aria-level={2}>{t("agentSettings")}</h4>
      <p className="h4-sub">{t("agentSettingsLead")}</p>
      <div className="card">
        {AGENT_TYPES.map((type) => (
          <div className="card-row" key={type}>
            <div className="grow">
              <div className="t">{t("agentModelForType", { type: t(TYPE_KEY[type]) })}</div>
              {type === "explore" && <div className="d">{t("agentModelForTypeDesc")}</div>}
            </div>
            <select className="input narrow" aria-label={t("agentModelForType", { type: t(TYPE_KEY[type]) })} value={encode(s.models[type])} onChange={(e) => setModel(type, decode(e.target.value))}>
              <option value="">{t("agentModelSameAsChat")}</option>
              {options(agentModels, s.models[type])}
            </select>
          </div>
        ))}
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("agentAllowedModels")}</div>
            <div className="d">{t("agentAllowedModelsDesc")}</div>
            {!!s.allowedModels.length && (
              <div className="agent-chips">
                {s.allowedModels.map((r) => (
                  <span className="agent-chip" key={refKey(r)}>
                    {label(r)}
                    <button className="icon-btn" aria-label={t("agentAllowedRemove", { model: label(r) })} title={t("agentAllowedRemove", { model: label(r) })} onClick={() => saveAgentSettings({ ...s, allowedModels: s.allowedModels.filter((x) => !sameRef(x, r)) })}><X size={12} /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <select className="input narrow" aria-label={t("agentAllowedAdd")} value="" onChange={(e) => { const r = decode(e.target.value); if (r) saveAgentSettings({ ...s, allowedModels: [...s.allowedModels, r] }); }}>
            <option value="">{t("agentAllowedAdd")}</option>
            {options(agentModels.filter((r) => !s.allowedModels.some((x) => sameRef(x, r))), null)}
          </select>
        </div>
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("agentCheapModel")}</div>
            <div className="d">{t("agentCheapModelDesc")}</div>
          </div>
          <select className="input narrow" aria-label={t("agentCheapModel")} value={encode(s.cheapModel)} onChange={(e) => saveAgentSettings({ ...s, cheapModel: decode(e.target.value) })}>
            <option value="">{t("agentModelSameAsChat")}</option>
            {options(anyModels, s.cheapModel)}
          </select>
        </div>
      </div>

      <div className="card">
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("agentBudgets")}</div>
            <div className="d">{t("agentBudgetsDesc")}</div>
            {badCells.size > 0 && <div className="budget-error" role="alert">{t("agentBudgetInvalid")}</div>}
            <table className="agent-budgets">
              <thead>
                <tr><th />{FIELDS.map((f) => <th key={f.key} scope="col">{t(f.label)}</th>)}</tr>
              </thead>
              <tbody>
                {AGENT_TYPES.map((type) => (
                  <tr key={type}>
                    <th scope="row">{t(TYPE_KEY[type])}</th>
                    {FIELDS.map((f) => (
                      <td key={f.key}><BudgetCell type={type} field={f.key} label={`${t(TYPE_KEY[type])}: ${t(f.label)}`} settings={s} onBad={flag(`${type}.${f.key}`)} /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("agentStopOnBudget")}</div>
            <div className="d">{t("agentStopOnBudgetDesc")}</div>
          </div>
          <Toggle on={s.stopOnBudget} label={t("agentStopOnBudget")} onChange={(v) => saveAgentSettings({ ...s, stopOnBudget: v })} />
        </div>
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("agentCancelDependents")}</div>
            <div className="d">{t("agentCancelDependentsDesc")}</div>
          </div>
          <Toggle on={s.cancelDependents} label={t("agentCancelDependents")} onChange={(v) => saveAgentSettings({ ...s, cancelDependents: v })} />
        </div>
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("agentNotifications")}</div>
            <div className="d">{t("agentNotificationsDesc")}</div>
          </div>
          <Toggle on={s.notifications} label={t("agentNotifications")} onChange={(v) => saveAgentSettings({ ...s, notifications: v })} />
        </div>
      </div>
    </>
  );
}
