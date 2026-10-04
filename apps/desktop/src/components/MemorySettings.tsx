import { useEffect, useId, useState } from "react";
import { useT } from "../i18n";
import { useApp } from "../state";
import { getSetting, setSetting } from "../lib/api";
import { editMemory, forget, listMemories, remember, type MemoryEntry, MEMORY_CAP } from "../agent/memory";
import { MemoryExportDialog } from "./MemoryExportDialog";

/**
 * The list/add/edit/delete part of memory, shared by Settings -> Memory and the project menu's "Memory…" dialog. `root` is the
 * project folder (null = global entries). With `includeGlobal` the list also shows the global entries and new facts can be
 * added to either scope; edit and delete always act on the scope the entry itself is stored in.
 */
export function MemoryEditor({ root, name, includeGlobal = false }: { root: string | null; name?: string; includeGlobal?: boolean }) {
  const t = useT();
  const id = useId();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [text, setText] = useState(""); const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [addScope, setAddScope] = useState<"project" | "global">(root ? "project" : "global");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const withGlobal = includeGlobal && !!root;
  const load = async () => [...(await listMemories(root)), ...(withGlobal ? await listMemories(null) : [])];
  useEffect(() => { let valid = true; setText(""); setEditing(null); setAddScope(root ? "project" : "global"); load().then(e => valid && setEntries(e)).catch(e => valid && setError(String(e))); return () => { valid = false; }; }, [root, withGlobal]);
  const run = async (f: () => Promise<unknown>) => { setBusy(true); setError(""); try { await f(); setEntries(await load()); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const target = withGlobal && addScope === "global" ? null : root;
  return <>
    {withGlobal && <><label htmlFor={`${id}-scope`}>{t("memoryScope")}</label>
      <select id={`${id}-scope`} className="input" disabled={busy || !!editing} value={editing ? (editing.project_root ? "project" : "global") : addScope} onChange={e => setAddScope(e.target.value as "project" | "global")}>
        <option value="project">{t("memoryScopeProject")}</option><option value="global">{t("memoryGlobal")}</option></select></>}
    <label htmlFor={`${id}-text`}>{t("memoryFact")}</label><textarea id={`${id}-text`} className="input" rows={3} value={text} maxLength={MEMORY_CAP} disabled={busy} onChange={e => setText(e.target.value)} />
    <div className="memory-actions">
      <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => run(async () => { if (editing) await editMemory(editing.id, editing.project_root, text); else await remember(target, text); setText(""); setEditing(null); })}>{t("save")}</button>
      {editing && <button className="btn-ghost" onClick={() => { setEditing(null); setText(""); }}>{t("cancel")}</button>}
      {root && <button className="btn-soft memory-export" disabled={busy} onClick={() => setExporting(true)}>{t("memoryExport")}</button>}
    </div>
    {error && <div className="error-box" role="alert">{error}</div>}
    <div className="card">{!entries.length && <div className="card-row muted">{t("memoryEmpty")}</div>}{entries.map(e => <div className="card-row" key={e.id}>
      <div className="grow"><div style={{ whiteSpace: "pre-wrap" }}>{e.text}</div><div className="muted">#{e.id} · {withGlobal ? `${e.project_root ? t("memoryScopeProject") : t("memoryGlobal")} · ` : ""}{t.date(e.updated_at)}{e.source_chat ? ` · ${t("memorySource")} #${e.source_chat}` : ""}</div></div>
      <button className="btn-soft" disabled={busy} onClick={() => { setEditing(e); setText(e.text); }}>{t("edit")}</button>
      <button className="btn-soft" disabled={busy} onClick={() => run(() => forget(e.id, e.project_root))}>{t("delete")}</button></div>)}</div>
    {exporting && root && <MemoryExportDialog root={root} name={name} onClose={() => setExporting(false)} />}
  </>;
}

export function MemorySettings() {
  const t = useT(); const app = useApp();
  const [root, setRoot] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true); const [approval, setApproval] = useState(true); const [auto, setAuto] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { getSetting("memoryEnabled", true).then(setEnabled); getSetting("memoryApproval", true).then(setApproval); getSetting("memorySuggestAuto", false).then(setAuto); }, []);
  const toggle = async (key: string, value: boolean, set: (v: boolean) => void) => { setError(""); try { await setSetting(key, value); set(value); } catch (e) { setError(String(e)); } };
  const project = app.projects.find(p => p.path === root);
  return <><h1>{t("memoryTitle")}</h1><p className="lead">{t("memoryLead")}</p>
    <div className="card"><div className="card-row"><span className="grow">{t("memoryEnabled")}</span><button className={`toggle${enabled ? " on" : ""}`} role="switch" aria-checked={enabled} aria-label={t("memoryEnabled")} onClick={() => toggle("memoryEnabled", !enabled, setEnabled)} /></div>
    <div className="card-row"><span className="grow">{t("memoryApproval")}</span><button className={`toggle${approval ? " on" : ""}`} role="switch" aria-checked={approval} aria-label={t("memoryApproval")} onClick={() => toggle("memoryApproval", !approval, setApproval)} /></div>
    <div className="card-row"><span className="grow">{t("memorySuggestAuto")}<div className="muted">{t("memorySuggestAutoHint")}</div></span><button className={`toggle${auto ? " on" : ""}`} role="switch" aria-checked={auto} aria-label={t("memorySuggestAuto")} onClick={() => toggle("memorySuggestAuto", !auto, setAuto)} /></div></div>
    {error && <div className="error-box" role="alert">{error}</div>}
    <label htmlFor="memory-scope">{t("memoryScope")}</label><select id="memory-scope" className="input" value={root ?? ""} onChange={e => setRoot(e.target.value || null)}><option value="">{t("memoryGlobal")}</option>{app.projects.filter(p => p.path).map(p => <option key={p.id} value={p.path!}>{p.name}</option>)}</select>
    <MemoryEditor root={root} name={project?.name} />
  </>;
}
