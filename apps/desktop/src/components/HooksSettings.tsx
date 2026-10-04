import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n";
import { useApp } from "../state";
import { PROJECT_HOOKS_FILE, type Hook, type HookIssue } from "../agent/hooksCore";
import { loadGlobalHooksText, loadHooksView, saveGlobalHooksText, setProjectHooksEnabled, type HooksView } from "../agent/hooksStore";

/** Settings: the effective hooks of a project with their source, skipped entries, the per-project switch and an editor for the global hooks. */
export function HooksSettings() {
  const t = useT();
  const app = useApp();
  const projects = app.projects.filter((p) => p.path);
  const [root, setRoot] = useState(projects[0]?.path ?? "");
  const [view, setView] = useState<HooksView | null>(null);
  const [text, setText] = useState("");
  const [issues, setIssues] = useState<HookIssue[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setView(await loadHooksView(root || null));
    setText(await loadGlobalHooksText());
  }, [root]);
  useEffect(() => {
    let live = true;
    reload().catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [reload]);

  const where = (h: Hook) => (h.source === "global" ? t("hooksSourceGlobal") : t("hooksSourceProject"));
  const allIssues = [...(view?.global.issues ?? []), ...(view?.project.issues ?? [])];
  const issueLabel = (i: HookIssue) => `${i.source === "global" ? t("hooksSourceGlobal") : PROJECT_HOOKS_FILE}${i.index === null ? "" : ` #${i.index + 1}`}: ${i.message}`;

  const toggle = async (on: boolean) => {
    try {
      await setProjectHooksEnabled(root, on);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  };
  const save = async () => {
    setError("");
    setSaved(false);
    try {
      const r = await saveGlobalHooksText(text);
      setIssues(r.issues);
      setSaved(!r.issues.some((i) => i.index === null));
      await reload();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <>
      <h4>{t("hooksTitle")}</h4>
      <p className="lead">{t("hooksLead")}</p>
      {projects.length > 0 && (
        <select className="input" aria-label={t("searchProject")} value={root} onChange={(e) => setRoot(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.path!}>{p.name}</option>
          ))}
        </select>
      )}
      {root && (
        <div className="card">
          <label className="card-row">
            <span className="grow">{t("hooksProjectEnable", { file: PROJECT_HOOKS_FILE })}</span>
            <input type="checkbox" checked={!!view?.enabled} disabled={!view} onChange={(e) => toggle(e.target.checked)} />
          </label>
          <p className="hint" role="note">{t("hooksWarning")}</p>
          {view && !view.project.exists && <p className="hint">{t("hooksNoFile", { file: PROJECT_HOOKS_FILE })}</p>}
          {view && view.project.exists && !view.enabled && <p className="hint">{t("hooksProjectOff")}</p>}
        </div>
      )}
      <div className="card" aria-label={t("hooksEffective")}>
        {!view?.effective.length && <div className="card-row d">{t("hooksNone")}</div>}
        {view?.effective.map((h, i) => (
          <div className="card-row" key={`${h.source}-${i}`}>
            <strong>{h.event}</strong>
            <code>{h.matcher}</code>
            <code className="grow" style={{ overflowWrap: "anywhere" }}>{h.command}</code>
            <span className="hint">{where(h)} · {t("hooksTimeout", { ms: h.timeoutMs })}</span>
          </div>
        ))}
      </div>
      {allIssues.length > 0 && (
        <div className="error-box" role="alert">
          <strong>{t("hooksSkipped")}</strong>
          <ul>
            {allIssues.map((i, k) => (
              <li key={k}>{issueLabel(i)}</li>
            ))}
          </ul>
        </div>
      )}
      <label htmlFor="hooks-global">{t("hooksEditGlobal")}</label>
      <textarea id="hooks-global" className="input" rows={8} spellCheck={false} value={text} placeholder={'{ "hooks": [ { "event": "stop", "command": "…" } ] }'} onChange={(e) => (setText(e.target.value), setSaved(false))} />
      <div className="card-row">
        <button className="btn btn-primary" onClick={save}>{t("save")}</button>
        {saved && <span role="status">{t("hooksSaved")}</span>}
      </div>
      {issues.some((i) => i.index === null) && (
        <ul className="error-box" role="alert">
          {issues.filter((i) => i.index === null).map((i, k) => (
            <li key={k}>{issueLabel(i)}</li>
          ))}
        </ul>
      )}
      {error && <div className="error-box" role="alert">{error}</div>}
    </>
  );
}
