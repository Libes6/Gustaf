import { SettingRow } from "./SettingRow";
import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n";
import { useApp } from "../state";
import { DEFAULT_CHECK_TIMEOUT_MS, MAX_CHECKS, MAX_FIX_ATTEMPTS, MAX_CHECK_TIMEOUT_MS, MIN_CHECK_TIMEOUT_MS, PROJECT_DONE_FILE, defaultSettings, type CheckIssue, type DoneFile, type VerificationSettings as Settings } from "../agent/verificationCore";
import { loadVerificationView, saveVerificationSettings, suggestChecks } from "../agent/verificationStore";

type Row = { name: string; command: string; seconds: string };
const toRow = (c: { name: string; command: string; timeoutMs: number }): Row => ({ name: c.name, command: c.command, seconds: String(Math.round(c.timeoutMs / 1000)) });

/**
 * Settings > Git and commands: the per-project "definition of done" (docs/features/verification-gates.md). The checks are
 * edited here and saved per project; the read-only `.gustaf/done.json` of the project runs only with its own switch (off by
 * default, with a warning). "Suggest checks" only fills in rows from the installed scripts: nothing runs from this page.
 */
export function VerificationSettings() {
  const t = useT();
  const app = useApp();
  const projects = app.projects.filter((p) => p.path);
  const [root, setRoot] = useState(projects[0]?.path ?? "");
  const [rows, setRows] = useState<Row[]>([]);
  const [settings, setSettings] = useState<Settings>(defaultSettings());
  const [file, setFile] = useState<DoneFile | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const reload = useCallback(async () => {
    if (!root) return;
    const v = await loadVerificationView(root, { readFile: true });
    setSettings(v.settings);
    setRows(v.settings.checks.map(toRow));
    setFile(v.file);
  }, [root]);
  useEffect(() => {
    let live = true;
    setSaved(false);
    setError("");
    setNote("");
    reload().catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [reload]);

  const edit = (next: Row[]) => {
    setRows(next);
    setSaved(false);
  };
  const change = (i: number, patch: Partial<Row>) => edit(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const patchSettings = (patch: Partial<Settings>) => {
    setSettings({ ...settings, ...patch });
    setSaved(false);
  };

  const suggest = async () => {
    setError("");
    setNote("");
    try {
      const found = (await suggestChecks(root)).filter((s) => !rows.some((r) => r.command.trim() === s.command));
      if (!found.length) return setNote(t("verifSuggestNone"));
      edit([...rows, ...found.map((s) => toRow({ name: s.name, command: s.command, timeoutMs: s.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS }))].slice(0, MAX_CHECKS));
      setNote(t("verifSuggestNote"));
    } catch (e) {
      setError(String(e));
    }
  };

  const save = async () => {
    setError("");
    setNote("");
    if (rows.some((r) => !r.command.trim())) return setError(t("verifNeedCommand"));
    const checks = rows.map((r) => {
      const ms = Math.round(Number(r.seconds) * 1000);
      return { name: r.name.trim(), command: r.command.trim(), timeoutMs: Number.isFinite(ms) ? Math.min(MAX_CHECK_TIMEOUT_MS, Math.max(MIN_CHECK_TIMEOUT_MS, ms)) : DEFAULT_CHECK_TIMEOUT_MS };
    });
    try {
      await saveVerificationSettings(root, { ...settings, checks });
      setSaved(true);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const issueLabel = (i: CheckIssue) => `${PROJECT_DONE_FILE}${i.index === null ? "" : ` #${i.index + 1}`}: ${i.message}`;

  return (
    <>
      <h4>{t("verifTitle")}</h4>
      <p className="lead">{t("verifLead")}</p>
      {!projects.length ? (
        <p>{t("verifNoProject")}</p>
      ) : (
        <>
          <select className="input" aria-label={t("searchProject")} value={root} onChange={(e) => setRoot(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.path!}>{p.name}</option>
            ))}
          </select>
          <div className="card" aria-label={t("verifTitle")}>
            {!rows.length && <div className="card-row d">{t("verifNone")}</div>}
            {rows.map((r, i) => (
              <div className="verify-edit-row" key={i}>
                <input className="input" aria-label={t("verifName")} placeholder={t("verifName")} value={r.name} maxLength={60} onChange={(e) => change(i, { name: e.target.value })} />
                <input className="input" aria-label={t("verifCommand")} placeholder="npm test" spellCheck={false} value={r.command} onChange={(e) => change(i, { command: e.target.value })} />
                <input className="input" aria-label={t("verifTimeout")} type="number" min={MIN_CHECK_TIMEOUT_MS / 1000} max={MAX_CHECK_TIMEOUT_MS / 1000} value={r.seconds} onChange={(e) => change(i, { seconds: e.target.value })} />
                <button className="btn-soft" aria-label={t("verifRemove", { name: r.name || r.command })} onClick={() => edit(rows.filter((_, k) => k !== i))}>×</button>
              </div>
            ))}
            <div className="card-row">
              <button className="btn-soft" disabled={rows.length >= MAX_CHECKS} onClick={() => edit([...rows, { name: "", command: "", seconds: String(DEFAULT_CHECK_TIMEOUT_MS / 1000) }])}>{t("verifAdd")}</button>
              <button className="btn-soft" onClick={suggest}>{t("verifSuggest")}</button>
            </div>
          </div>
          <SettingRow id="verifFixAttempts" title={<label htmlFor="verify-fix">{t("verifFixAttempts")}</label>}>
            <select id="verify-fix" className="input" style={{ width: "auto" }} value={settings.maxFixAttempts} onChange={(e) => patchSettings({ maxFixAttempts: Number(e.target.value) })}>
              {Array.from({ length: MAX_FIX_ATTEMPTS + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </SettingRow>
          <div className="card">
            <SettingRow id="verifFileEnable" title={t("verifFileEnable", { file: PROJECT_DONE_FILE })}>
              <input type="checkbox" aria-label={t("verifFileEnable", { file: PROJECT_DONE_FILE })} checked={settings.useProjectFile} onChange={(e) => patchSettings({ useProjectFile: e.target.checked })} />
            </SettingRow>
            <p className="hint" role="note">{t("verifFileWarning")}</p>
            {!file && <p className="hint">{t("verifFileNone", { file: PROJECT_DONE_FILE })}</p>}
            {file && !settings.useProjectFile && <p className="hint">{t("verifFileOff")}</p>}
            {file && file.checks.length > 0 && (
              <div aria-label={t("verifFileChecks")}>
                {file.checks.map((c, i) => (
                  <div className="card-row" key={i}>
                    <strong>{c.name}</strong>
                    <code className="grow" style={{ overflowWrap: "anywhere" }}>{c.command}</code>
                    <span className="hint">{Math.round(c.timeoutMs / 1000)} s</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {file && file.issues.length > 0 && (
            <div className="error-box" role="alert">
              <strong>{t("verifSkipped")}</strong>
              <ul>
                {file.issues.map((i, k) => (
                  <li key={k}>{issueLabel(i)}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="card-row">
            <button className="btn btn-primary" onClick={save}>{t("save")}</button>
            {saved && <span role="status">{t("verifSaved")}</span>}
          </div>
          {note && <p className="hint" role="status">{note}</p>}
        </>
      )}
      {error && <div className="error-box" role="alert">{error}</div>}
    </>
  );
}
