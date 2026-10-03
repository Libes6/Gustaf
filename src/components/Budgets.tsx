import { Info, OctagonAlert, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useT, type Key } from "../i18n";
import { db, getSetting, setSetting } from "../lib/api";
import {
  BUDGETS_SETTING, DEFAULT_BUDGETS, buildAlerts, evaluateBudget, localDayStart, nextLocalDayStart, normalizeBudgets, parseTokenLimit,
  parseUsageRow, parseWarnPercent, summarizeUsage, type BudgetAlert, type BudgetSettings, type BudgetStatus, type UsageTotals,
  localDayKey, withExtraTokens,
} from "../lib/budgets";
import { loadAgentUsage } from "../agent/agentRuns";
import { ledgerChat, ledgerDay } from "../agent/agentRunsModel";
import { useApp } from "../state";
import "../styles/budgets.css";

// ---- settings: stored in the app `settings` table under "budgets", shared by the banner and the settings page ----
let current: BudgetSettings = DEFAULT_BUDGETS;
let loading: Promise<void> | undefined;
let edited = false;
const listeners = new Set<() => void>();
const publish = (next: BudgetSettings) => { current = next; listeners.forEach(l => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const loadSettings = () => { loading ??= getSetting<unknown>(BUDGETS_SETTING, null).then(v => { if (!edited) publish(normalizeBudgets(v)); }).catch(() => {}); };
const saveBudgets = (next: BudgetSettings) => { edited = true; publish(next); setSetting(BUDGETS_SETTING, next).catch(() => {}); };
function useBudgetSettings() {
  useEffect(() => { loadSettings(); }, []);
  return useSyncExternalStore(subscribe, () => current);
}

function useNow(everyMs = 60_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, everyMs);
    addEventListener("focus", tick);
    return () => { clearInterval(id); removeEventListener("focus", tick); };
  }, [everyMs]);
  return now;
}

// ---- usage: provider-reported tokens already stored with each chat message (meta.usage) ----
type Row = { role: string; created_at: number; content: string };
const SELECT = "select role, created_at, content from messages where";
const FILTER = `(role = 'assistant' or content like '%"compacted":true%')`;
type Loaded = { dayStart: number; chatId: number | null; day?: UsageTotals; chat?: UsageTotals; failed: boolean };

/** Re-reads after each recorded request and when a chat finishes running; a failed read stays "unavailable". */
function useBudgetUsage(enabled: boolean, chatId: number | null, dayStart: number, tokenStats: unknown, busy: string) {
  const [state, setState] = useState<Loaded>({ dayStart, chatId, failed: false });
  useEffect(() => {
    if (!enabled) { setState(s => s.day || s.chat || s.failed ? { dayStart, chatId, failed: false } : s); return; }
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const dayRows = await db.select<Row>(`${SELECT} created_at >= ? and ${FILTER}`, [dayStart]);
        const chatRows = chatId === null ? undefined : await db.select<Row>(`${SELECT} chat_id = ? and ${FILTER}`, [chatId]);
        // Background subagents' replies are not stored as messages: their tokens come from the agent usage ledger.
        const agents = await loadAgentUsage();
        if (live) setState({
          dayStart, chatId, failed: false,
          day: withExtraTokens(summarizeUsage(dayRows.map(parseUsageRow), { from: dayStart, to: nextLocalDayStart(dayStart) }), ledgerDay(agents, localDayKey(dayStart))),
          chat: chatRows && withExtraTokens(summarizeUsage(chatRows.map(parseUsageRow)), ledgerChat(agents, chatId)),
        });
      } catch { if (live) setState({ dayStart, chatId, failed: true }); }
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [enabled, dayStart, chatId, tokenStats, busy]);
  const fresh = state.dayStart === dayStart && state.chatId === chatId;
  return { day: fresh ? state.day : undefined, chat: fresh ? state.chat : undefined, failed: fresh && state.failed };
}

const busyKey = (items: { busy?: boolean }[]) => items.map(s => s.busy ? "1" : "0").join("");

// ---- banner ----
const ALERT_KEYS = {
  day: { warning: "alertDayWarning", exceeded: "alertDayExceeded", unavailable: "alertDayUnavailable" },
  chat: { warning: "alertChatWarning", exceeded: "alertChatExceeded", unavailable: "alertChatUnavailable" },
} as const satisfies Record<"day" | "chat", Record<string, Key>>;

function alertText(t: ReturnType<typeof useT>, a: BudgetAlert, provider: string) {
  if (a.kind === "quota") {
    const key: Key = a.level === "exhausted" ? a.resetsAt ? "alertQuotaExhausted" : "alertQuotaExhaustedNoReset" : a.resetsAt ? "alertQuotaWarning" : "alertQuotaWarningNoReset";
    return t(key, { provider, label: a.label, percent: Math.min(99, Math.round(a.usedPercent)), time: a.resetsAt ? t.date(a.resetsAt * 1000) : "" });
  }
  return t(ALERT_KEYS[a.kind][a.level], { percent: Math.floor(a.percent ?? 0), used: t.num(a.tokens ?? 0), limit: t.num(a.limit) });
}

const severity = (a: BudgetAlert) => a.level === "exceeded" || a.level === "exhausted" ? "exceeded" : a.level === "warning" ? "warning" : "info";

/** Non-blocking: never prevents sending. Dismissal is per alert key, so a worse state or a new day shows it again. */
export function BudgetBanner() {
  const app = useApp();
  const t = useT();
  const settings = useBudgetSettings();
  const now = useNow();
  const providerId = app.selection?.providerId;
  const usage = useBudgetUsage(settings.dayTokens !== null || settings.chatTokens !== null, app.activeChat, localDayStart(now), app.tokenStats, busyKey(app.sessions.items));
  const alerts = useMemo(
    () => buildAlerts({ settings, now, day: usage.day, chatId: app.activeChat, chat: usage.chat, quotaProviders: providerId ? [providerId] : [], limits: app.limits }),
    [settings, now, usage.day, usage.chat, app.activeChat, providerId, app.limits],
  );
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const visible = app.view === "chat" ? alerts.filter(a => !dismissed.has(a.key)) : [];
  if (!visible.length) return null;
  return <div className="budget-alerts">
    {visible.map(a => {
      const level = severity(a);
      const Icon = level === "exceeded" ? OctagonAlert : level === "warning" ? TriangleAlert : Info;
      return <div key={a.key} className={`budget-alert ${level}`} role={level === "exceeded" ? "alert" : "status"}>
        <Icon size={15} aria-hidden />
        <div className="msg">{alertText(t, a, a.kind === "quota" ? app.providers.find(p => p.id === a.providerId)?.name ?? a.providerId : "")}</div>
        <button className="dismiss" aria-label={t("dismiss")} title={t("dismiss")} onClick={() => setDismissed(s => new Set(s).add(a.key))}><X size={13} /></button>
      </div>;
    })}
  </div>;
}

// ---- settings block (shown on the Usage page) ----
function describe(t: ReturnType<typeof useT>, scope: string, status: BudgetStatus, totals: UsageTotals | undefined, failed: boolean) {
  if (failed) return t("budgetStatusUnread", { scope });
  if (!totals) return "";
  const vars = { scope, used: t.num(status.tokens ?? 0), limit: t.num(status.limit ?? 0), percent: Math.floor(status.percent ?? 0) };
  switch (status.level) {
    case "off": return totals.counted || !totals.missing ? t("budgetStatusUsed", vars) : t("budgetStatusUnavailable", vars);
    case "unavailable": return t("budgetStatusUnavailable", vars);
    case "partial": return t("budgetStatusPartial", vars);
    case "warning": return t("budgetStatusWarning", vars);
    case "exceeded": return t("budgetStatusExceeded", vars);
    default: return t("budgetStatusOk", vars);
  }
}

const parsePercent = (text: string): { ok: true; value: number } | { ok: false } => {
  const value = parseWarnPercent(text);
  return value === undefined ? { ok: false } : { ok: true, value };
};

function FieldRow({ title, desc, state, level, error, children }: { title: string; desc: string; state?: string; level?: string; error?: string; children: ReactNode }) {
  return <div className="card-row">
    <div className="grow">
      <div className="t">{title}</div>
      <div className="d">{desc}</div>
      {state && <div className={`d budget-state ${level ?? ""}`}>{state}</div>}
      {error && <div className="budget-error" role="alert">{error}</div>}
    </div>
    {children}
  </div>;
}

/** Edits as text and commits on blur/Enter; invalid input keeps the stored value and shows an error. */
function TextSetting<T>({ label, value, parse, onCommit, placeholder, invalid, suffix }: {
  label: string; value: T; parse: (text: string) => { ok: true; value: T } | { ok: false }; onCommit: (v: T) => void;
  placeholder?: string; invalid: (bad: boolean) => void; suffix?: string;
}) {
  const show = (v: T) => v === null || v === undefined ? "" : String(v);
  const [text, setText] = useState(show(value));
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(show(value)); setBad(false); invalid(false); }, [value]);
  const commit = () => {
    const parsed = parse(text);
    setBad(!parsed.ok); invalid(!parsed.ok);
    if (!parsed.ok) return;
    setText(show(parsed.value));
    if (parsed.value !== value) onCommit(parsed.value);
  };
  return <>
    <input className="input budget-input" aria-label={label} aria-invalid={bad} inputMode="numeric" placeholder={placeholder} value={text}
      onChange={e => { setText(e.target.value); setBad(false); invalid(false); }} onBlur={commit} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
    {suffix && <span className="d">{suffix}</span>}
  </>;
}

export function BudgetsSection() {
  const t = useT();
  const app = useApp();
  const settings = useBudgetSettings();
  const now = useNow();
  const usage = useBudgetUsage(true, app.activeChat, localDayStart(now), app.tokenStats, busyKey(app.sessions.items));
  const [invalid, setInvalid] = useState({ day: false, chat: false, percent: false });
  const flag = (k: keyof typeof invalid) => (bad: boolean) => setInvalid(s => s[k] === bad ? s : { ...s, [k]: bad });
  const day = evaluateBudget(settings.dayTokens, usage.day, settings.warnPercent);
  const chat = evaluateBudget(settings.chatTokens, usage.chat, settings.warnPercent);
  const chatTitle = app.chats.find(c => c.id === app.activeChat)?.title;
  const levelClass = (s: BudgetStatus) => s.level === "exceeded" ? "exceeded" : s.level === "warning" ? "warning" : "";
  return <>
    <h4>{t("budgets")}</h4>
    <p className="h4-sub">{t("budgetsLead")}</p>
    <div className="card">
      <FieldRow title={t("budgetDayLimit")} desc={t("budgetDayLimitDesc")} state={describe(t, t("budgetToday"), day, usage.day, usage.failed)} level={levelClass(day)} error={invalid.day ? t("budgetLimitInvalid") : undefined}>
        <TextSetting label={t("budgetDayLimit")} value={settings.dayTokens} parse={parseTokenLimit} placeholder={t("budgetNoLimit")} invalid={flag("day")} onCommit={v => saveBudgets({ ...settings, dayTokens: v })} />
      </FieldRow>
      <FieldRow title={t("budgetChatLimit")} desc={t("budgetChatLimitDesc")} state={app.activeChat === null ? undefined : describe(t, chatTitle ?? t("budgetThisChat"), chat, usage.chat, usage.failed)} level={levelClass(chat)} error={invalid.chat ? t("budgetLimitInvalid") : undefined}>
        <TextSetting label={t("budgetChatLimit")} value={settings.chatTokens} parse={parseTokenLimit} placeholder={t("budgetNoLimit")} invalid={flag("chat")} onCommit={v => saveBudgets({ ...settings, chatTokens: v })} />
      </FieldRow>
      <FieldRow title={t("budgetWarnAt")} desc={t("budgetWarnAtDesc")} error={invalid.percent ? t("budgetPercentInvalid") : undefined}>
        <TextSetting<number> label={t("budgetWarnAt")} value={settings.warnPercent} parse={parsePercent} invalid={flag("percent")} suffix="%" onCommit={v => saveBudgets({ ...settings, warnPercent: v })} />
      </FieldRow>
    </div>
  </>;
}
