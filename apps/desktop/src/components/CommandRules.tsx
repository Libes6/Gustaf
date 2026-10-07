import { CircleCheck, CircleHelp, OctagonX, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { saveRulesConfig, useRulesConfig } from "../agent/rulesStore";
import {
  BUILTIN_RULES,
  MAX_RULES,
  decideCommand,
  describeRule,
  legacyAllowRules,
  newRuleId,
  validatePattern,
  type Decision,
  type Effect,
  type MatchKind,
  type PatternError,
  type Rule,
} from "../agent/rules";
import { useT, type Key } from "../i18n";
import { useApp } from "../state";
import { ActionLog } from "./ActionLog";
import "../styles/rules.css";

const EFFECT_KEY: Record<Effect, Key> = { allow: "cmdEffectAllow", ask: "cmdEffectAsk", deny: "cmdEffectDeny" };
const MATCH_KEY: Record<MatchKind, Key> = { prefix: "cmdMatchPrefix", glob: "cmdMatchGlob", exact: "cmdMatchExact" };
const ERROR_KEY: Record<PatternError | "duplicate" | "tooMany", Key> = {
  empty: "cmdErrEmpty",
  tooLong: "cmdErrTooLong",
  compound: "cmdErrCompound",
  unsupported: "cmdErrUnsupported",
  duplicate: "cmdErrDuplicate",
  tooMany: "cmdErrTooMany",
};
const BUILTIN_KEY: Record<string, Key> = {
  privilege: "cmdBuiltinPrivilege",
  "rm-root": "cmdBuiltinRmRoot",
  "chmod-root": "cmdBuiltinChmodRoot",
  "curl-sh": "cmdBuiltinCurlSh",
  disk: "cmdBuiltinDisk",
  power: "cmdBuiltinPower",
  "fork-bomb": "cmdBuiltinForkBomb",
};
const ORDER: Record<Effect, number> = { deny: 0, ask: 1, allow: 2 };
const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

type Row = { rule: Rule; legacy: boolean };

/** Command rules (allow / ask / deny, global or per project), the built-in protections, a preview box and the action log. */
export function CommandRules() {
  return (
    <>
      <RulesEditor />
      <ActionLog />
    </>
  );
}

function RulesEditor() {
  const t = useT();
  const app = useApp();
  const config = useRulesConfig();
  const projects = app.projects.filter((p) => p.path);
  const [effect, setEffect] = useState<Effect>("allow");
  const [match, setMatch] = useState<"prefix" | "glob">("prefix");
  const [pattern, setPattern] = useState("");
  const [scope, setScope] = useState("");
  const [error, setError] = useState<keyof typeof ERROR_KEY | null>(null);

  const rows: Row[] = useMemo(() => {
    const own = config.rules.map((rule) => ({ rule, legacy: false }));
    const old = legacyAllowRules(app.allowlist).map((rule) => ({ rule, legacy: true }));
    return [...own, ...old].sort((a, b) => ORDER[a.rule.effect] - ORDER[b.rule.effect]);
  }, [config.rules, app.allowlist]);

  const add = () => {
    const check = validatePattern(match, pattern);
    if (!check.ok) return setError(check.error);
    const project = scope || undefined;
    if (
      config.rules.some(
        (r) =>
          r.effect === effect &&
          r.match === match &&
          r.pattern === check.pattern &&
          (r.project ?? "") === (project ?? ""),
      )
    )
      return setError("duplicate");
    if (config.rules.length >= MAX_RULES) return setError("tooMany");
    saveRulesConfig({
      ...config,
      rules: [
        ...config.rules,
        { id: newRuleId(), effect, match, pattern: check.pattern, ...(project ? { project } : {}) },
      ],
    });
    setPattern("");
    setError(null);
  };
  const remove = ({ rule, legacy }: Row) =>
    legacy
      ? app.setAllowlist((list) => list.filter((entry) => entry.trim() !== rule.pattern))
      : saveRulesConfig({ ...config, rules: config.rules.filter((r) => r.id !== rule.id) });
  const scopeLabel = (rule: Rule) =>
    rule.project ? t("cmdScopeProject", { name: folderName(rule.project) }) : t("cmdScopeAll");

  return (
    <>
      <h4 aria-level={2}>{t("cmdRules")}</h4>
      <p className="h4-sub">{t("cmdRulesLead")}</p>
      <div className="card">
        <div className="card-row rules-form">
          <select
            className="input"
            aria-label={t("cmdRules")}
            value={effect}
            onChange={(e) => setEffect(e.target.value as Effect)}
          >
            {(["allow", "ask", "deny"] as const).map((e) => (
              <option key={e} value={e}>
                {t(EFFECT_KEY[e])}
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label={t("cmdPatternLabel")}
            value={match}
            onChange={(e) => setMatch(e.target.value as "prefix" | "glob")}
          >
            {(["prefix", "glob"] as const).map((m) => (
              <option key={m} value={m}>
                {t(MATCH_KEY[m])}
              </option>
            ))}
          </select>
          <input
            className="input rules-pattern"
            aria-label={t("cmdPatternLabel")}
            aria-invalid={!!error}
            placeholder={t("cmdPatternPlaceholder")}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={pattern}
            onChange={(e) => (setPattern(e.target.value), setError(null))}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <select
            className="input"
            aria-label={t("cmdScopeAll")}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="">{t("cmdScopeAll")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.path!}>
                {folderName(p.name || p.path!)}
              </option>
            ))}
          </select>
          <button className="btn-soft" onClick={add}>
            {t("cmdAddRule")}
          </button>
        </div>
        {error && (
          <div className="rules-error" role="alert">
            {t(ERROR_KEY[error])}
          </div>
        )}
        <div className="card-row d">{t("cmdPatternHint")}</div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        {!rows.length && <div className="card-row d">{t("cmdNoRules")}</div>}
        {rows.map((row) => (
          <div key={row.rule.id} className="card-row rule-row">
            <span className={`rule-badge ${row.rule.effect}`}>{t(EFFECT_KEY[row.rule.effect])}</span>
            <code className="rule-pattern">{row.rule.pattern}</code>
            <span className="rule-meta">
              {row.legacy ? t("cmdFromAllowlist") : `${t(MATCH_KEY[row.rule.match])} · ${scopeLabel(row.rule)}`}
            </span>
            <button
              className="icon-btn"
              title={t("cmdDeleteRule")}
              aria-label={`${t("cmdDeleteRule")}: ${row.rule.pattern}`}
              onClick={() => remove(row)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <h4 aria-level={2}>{t("cmdBuiltin")}</h4>
      <p className="h4-sub">{t("cmdBuiltinLead")}</p>
      <div className="card">
        {BUILTIN_RULES.map((b) => {
          const on = !config.disabledBuiltins.includes(b.id);
          const name = BUILTIN_KEY[b.id] ? t(BUILTIN_KEY[b.id]) : b.id;
          return (
            <div key={b.id} className="card-row rule-row">
              <span className="rule-badge deny">{t("cmdEffectDeny")}</span>
              <div className="grow">
                <div className="t">{name}</div>
                <div className="rule-builtin-example">{b.example}</div>
              </div>
              <button
                role="switch"
                aria-checked={on}
                aria-label={t("cmdBuiltinToggle", { name })}
                className={`toggle${on ? " on" : ""}`}
                onClick={() =>
                  saveRulesConfig({
                    ...config,
                    disabledBuiltins: on
                      ? [...config.disabledBuiltins, b.id]
                      : config.disabledBuiltins.filter((x) => x !== b.id),
                  })
                }
              />
            </div>
          );
        })}
      </div>

      <TryCommand />
    </>
  );
}

const BADGE: Record<Decision, string> = { allow: "allow", ask: "ask", deny: "deny", default: "" };

/** Shows what the current rules do with a command, without running anything. */
function TryCommand() {
  const t = useT();
  const app = useApp();
  const config = useRulesConfig();
  const [text, setText] = useState("");
  const [project, setProject] = useState("");
  const result = useMemo(
    () =>
      text.trim()
        ? decideCommand(text, { config, allowlist: app.allowlist, project: project || null }, app.access)
        : null,
    [text, project, config, app.allowlist, app.access],
  );
  const verdict =
    result &&
    (app.access === "readonly"
      ? { cls: "block", Icon: OctagonX, label: t("cmdVerdictReadonly") }
      : result.action === "block"
        ? { cls: "block", Icon: OctagonX, label: t("cmdVerdictBlock") }
        : result.action === "ask"
          ? { cls: "ask", Icon: CircleHelp, label: t("cmdVerdictAsk") }
          : { cls: "run", Icon: CircleCheck, label: t("cmdVerdictRun") });
  return (
    <>
      <h4 aria-level={2}>{t("cmdTry")}</h4>
      <p className="h4-sub">{t("cmdTryLead")}</p>
      <div className="card rules-try">
        <div className="card-row rules-form">
          <input
            className="input rules-pattern"
            aria-label={t("cmdTry")}
            placeholder={t("cmdTryPlaceholder")}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <select
            className="input"
            aria-label={t("cmdTryProject")}
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="">{t("cmdScopeAll")}</option>
            {app.projects
              .filter((p) => p.path)
              .map((p) => (
                <option key={p.id} value={p.path!}>
                  {folderName(p.name || p.path!)}
                </option>
              ))}
          </select>
        </div>
        {result && verdict && (
          <div className="card-row" style={{ display: "block" }}>
            <div className={`try-verdict ${verdict.cls}`}>
              <verdict.Icon size={15} aria-hidden /> {verdict.label}
            </div>
            {result.evaluation.rule && (
              <div className="d">{t("cmdVerdictRule", { rule: describeRule(result.evaluation.rule) })}</div>
            )}
            {result.evaluation.decision === "default" && app.access !== "readonly" && (
              <div className="d">{t("cmdVerdictDefault")}</div>
            )}
            {result.evaluation.parseError && <div className="d">{t("cmdVerdictParse")}</div>}
            {result.evaluation.segments.length > 1 && (
              <>
                <div className="d" style={{ marginTop: 8 }}>
                  {t("cmdSegments")}
                </div>
                <ul className="try-segments">
                  {result.evaluation.segments.map((s, i) => (
                    <li key={i}>
                      <span className={`rule-badge ${BADGE[s.decision]}`}>
                        {s.decision === "default" ? "–" : t(EFFECT_KEY[s.decision])}
                      </span>
                      <code>{s.text}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
