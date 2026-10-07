import { useEffect, useMemo, useState } from "react";
import { useT } from "../i18n";
import { db } from "../lib/api";
import { localDayKey, type UsageRecord } from "../lib/budgets";
import { AGENTS_SERIES, USAGE_RANGES, dailyUsage, niceMax, rangeStart, splitCellKey, stackSeries, type GroupBy, type Metric, type UsageRange } from "../lib/usageDaily";
import { loadAgentUsage } from "../agent/agentRuns";
import { useApp } from "../state";
import "../styles/usage.css";

// Settings > Usage: per-day chart built from the provider-reported usage stored with each chat message (one bounded query for the whole range)
// plus the background-agent ledger. Inline SVG, no chart library.

const METRICS: Metric[] = ["tokens", "input", "output", "cached", "requests"];
const GROUPS: GroupBy[] = ["provider", "model"];
const PALETTE = ["#4f8ef7", "#e8863a", "#3fb68b", "#c466d9", "#e5b934", "#e0605e", "#4cc3d9", "#8a7cf0"];
const AGENT_COLOR = "#8b8f98";
const ROW_LIMIT = 200000;

type Row = { created_at: number; meta: string | null };
const parseRow = (r: Row): UsageRecord => {
  const meta = r.meta ? JSON.parse(r.meta) : null;
  return { role: "assistant", createdAt: r.created_at, meta: meta && typeof meta === "object" ? meta : null };
};

/** One grouped read of the range: only the `meta` of assistant/compacted messages, never the message bodies. */
async function loadRange(from: number, to: number): Promise<UsageRecord[]> {
  const rows = await db.select<Row>(
    `select created_at, case when json_valid(content) then json_extract(content, '$.meta') end as meta from messages
     where created_at >= ? and created_at < ? and (role = 'assistant' or content like '%"compacted":true%') order by created_at limit ${ROW_LIMIT}`,
    [from, to],
  );
  return rows.map(r => { try { return parseRow(r); } catch { return { createdAt: r.created_at, unreadable: true }; } });
}

export function UsageCharts() {
  const t = useT();
  const app = useApp();
  const [range, setRange] = useState<UsageRange>(30);
  const [metric, setMetric] = useState<Metric>("tokens");
  const [by, setBy] = useState<GroupBy>("provider");
  const [hover, setHover] = useState<number | null>(null);
  const [state, setState] = useState<{ records: UsageRecord[]; agentDays: Record<string, number>; day: string; range: UsageRange } | "failed" | null>(null);
  const busy = app.sessions.items.map(s => s.busy ? "1" : "0").join("");
  const today = localDayKey(Date.now());

  useEffect(() => {
    let live = true;
    const now = Date.now();
    const timer = setTimeout(async () => {
      try {
        const [records, ledger] = await Promise.all([loadRange(rangeStart(now, range), now + 1), loadAgentUsage()]);
        if (live) setState({ records, agentDays: ledger.days, day: localDayKey(now), range });
      } catch { if (live) setState("failed"); }
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [range, app.tokenStats, busy, today]);

  const data = useMemo(() => state && state !== "failed" && state.range === range ? dailyUsage(state.records, range, Date.now(), state.agentDays) : null, [state, range]);
  const stacked = useMemo(() => data ? stackSeries(data, metric, by) : null, [data, metric, by]);

  const nameOf = (key: string) => {
    if (key === AGENTS_SERIES) return t("usageAgentsSeries");
    if (by === "provider") return app.providers.find(p => p.id === key)?.name ?? (key || "?");
    const { providerId, model } = splitCellKey(key);
    const p = app.providers.find(x => x.id === providerId);
    return `${p?.name ?? providerId} · ${app.models.find(m => m.providerId === providerId && m.id === model)?.name ?? model}`;
  };
  const colorOf = (key: string, keys: string[]) => key === AGENTS_SERIES ? AGENT_COLOR : PALETTE[keys.filter(k => k !== AGENTS_SERIES).indexOf(key) % PALETTE.length];
  const unit = (n: number) => metric === "requests" ? t.num(n) : n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n);

  // Geometry: viewBox units, scaled to the card width.
  const W = 640, H = 200, L = 44, B = 22, T = 8, R = 6;
  const days = stacked?.days ?? [];
  const max = niceMax(Math.max(0, ...days.map(d => d.total)));
  const slot = (W - L - R) / Math.max(1, days.length);
  const bw = Math.max(1.5, slot * 0.72);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const every = range === 7 ? 1 : range === 30 ? 5 : 15;
  const hovered = hover !== null ? days[hover] : undefined;
  const hasData = !!stacked && stacked.total > 0;

  return <section className="usage-daily" aria-label={t("usageDaily")}>
    <h4 aria-level={2}>{t("usageDaily")}</h4>
    <div className="card usage-chart-card">
      <div className="usage-chart-controls">
        <div className="seg" role="group" aria-label={t("usageRangeLabel")}>
          {USAGE_RANGES.map(r => <button key={r} className={range === r ? "active" : ""} aria-pressed={range === r} onClick={() => { setRange(r); setHover(null); }}>{t("usageRangeDays", { count: r })}</button>)}
        </div>
        <div className="seg" role="group" aria-label={t("usageMetricLabel")}>
          {METRICS.map(m => <button key={m} className={metric === m ? "active" : ""} aria-pressed={metric === m} onClick={() => setMetric(m)}>{t(`usageMetric_${m}`)}</button>)}
        </div>
        <div className="seg" role="group" aria-label={t("usageGroupLabel")}>
          {GROUPS.map(g => <button key={g} className={by === g ? "active" : ""} aria-pressed={by === g} onClick={() => setBy(g)}>{t(`usageBy_${g}`)}</button>)}
        </div>
      </div>
      {state === "failed" && <p className="d usage-note" role="alert">{t("usageLoadFailed")}</p>}
      {stacked && !hasData && <p className="d usage-note">{t("usageEmpty")}</p>}
      {stacked && hasData && <>
        <div className="usage-chart-total"><small>{t("usageRangeTotal")}</small><strong>{t.num(stacked.total)}</strong></div>
        <div className="usage-chart-wrap" onMouseLeave={() => setHover(null)}>
          <svg className="usage-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("usageChartLabel")}>
            {[0, 0.5, 1].map(f => <g key={f}>
              <line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} className="usage-grid" />
              <text x={L - 6} y={y(max * f) + 4} textAnchor="end" className="usage-axis">{unit(max * f)}</text>
            </g>)}
            {days.map((d, i) => {
              const x = L + i * slot + (slot - bw) / 2;
              let acc = 0;
              return <g key={d.day.key} onMouseEnter={() => setHover(i)}>
                <rect x={L + i * slot} y={T} width={slot} height={H - T - B} fill="transparent" />
                {stacked.keys.map(k => {
                  const v = d.parts[k] ?? 0;
                  if (!v) return null;
                  const top = y(acc + v), h = y(acc) - top;
                  acc += v;
                  return <rect key={k} x={x} y={top} width={bw} height={Math.max(h, 0.5)} fill={colorOf(k, stacked.keys)} opacity={hover === null || hover === i ? 1 : 0.55} />;
                })}
                {(days.length - 1 - i) % every === 0 && <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="usage-axis">{new Date(d.day.start).toLocaleDateString(app.locale, { month: "short", day: "numeric" })}</text>}
              </g>;
            })}
          </svg>
          {hovered && <div className="usage-tip" style={{ left: `${Math.min(80, Math.max(2, ((L + (hover! + 0.5) * slot) / W) * 100))}%` }} role="status">
            <strong>{new Date(hovered.day.start).toLocaleDateString(app.locale, { weekday: "short", month: "short", day: "numeric" })}</strong>
            <div>{t(`usageMetric_${metric}`)}: {t.num(hovered.total)}</div>
            {stacked.keys.filter(k => hovered.parts[k]).map(k => <div key={k} className="usage-tip-row"><i style={{ background: colorOf(k, stacked.keys) }} /><span>{nameOf(k)}</span><b>{t.num(hovered.parts[k])}</b></div>)}
          </div>}
        </div>
        <ul className="usage-legend">
          {stacked.keys.map(k => <li key={k}><i style={{ background: colorOf(k, stacked.keys) }} /><span>{nameOf(k)}</span><b>{t.num(stacked.totals[k])}</b></li>)}
        </ul>
        {metric === "tokens" && stacked.keys.includes(AGENTS_SERIES) && <p className="d usage-note">{t("usageAgentsNote")}</p>}
        {!!data?.missing && <p className="d usage-note">{t("usageMissingReplies", { count: data.missing })}</p>}
      </>}
    </div>
  </section>;
}
