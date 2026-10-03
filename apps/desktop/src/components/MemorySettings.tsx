import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { useApp } from "../state";
import { getSetting, setSetting } from "../lib/api";
import { editMemory, forget, listMemories, remember, type MemoryEntry, MEMORY_CAP } from "../agent/memory";
export function MemorySettings() {
  const t = useT(); const app = useApp();
  const [root,setRoot] = useState<string | null>(null);
  const [entries,setEntries] = useState<MemoryEntry[]>([]);
  const [text,setText] = useState(""); const [editing,setEditing] = useState<number | null>(null);
  const [enabled,setEnabled] = useState(true); const [approval,setApproval] = useState(true);
  const [error,setError] = useState(""); const [busy,setBusy] = useState(false);
  useEffect(() => { let valid=true; setText(""); setEditing(null); listMemories(root).then(e=>valid&&setEntries(e)).catch(e=>valid&&setError(String(e))); return()=>{valid=false;}; },[root]);
  useEffect(()=>{ getSetting("memoryEnabled",true).then(setEnabled); getSetting("memoryApproval",true).then(setApproval); },[]);
  const run = async (f:()=>Promise<unknown>) => { setBusy(true); setError(""); try { await f(); setEntries(await listMemories(root)); } catch(e) {setError(String(e));} finally {setBusy(false);} };
  return <><h1>{t("memoryTitle")}</h1><p className="lead">{t("memoryLead")}</p>
    <div className="card"><div className="card-row"><span className="grow">{t("memoryEnabled")}</span><button className={`toggle${enabled?" on":""}`} role="switch" aria-checked={enabled} aria-label={t("memoryEnabled")} onClick={()=>run(async()=>{await setSetting("memoryEnabled",!enabled);setEnabled(!enabled);})}/></div>
    <div className="card-row"><span className="grow">{t("memoryApproval")}</span><button className={`toggle${approval?" on":""}`} role="switch" aria-checked={approval} aria-label={t("memoryApproval")} onClick={()=>run(async()=>{await setSetting("memoryApproval",!approval);setApproval(!approval);})}/></div></div>
    <label htmlFor="memory-scope">{t("memoryScope")}</label><select id="memory-scope" className="input" disabled={busy} value={root??""} onChange={e=>setRoot(e.target.value||null)}><option value="">{t("memoryGlobal")}</option>{app.projects.filter(p=>p.path).map(p=><option key={p.id} value={p.path!}>{p.name}</option>)}</select>
    <label htmlFor="memory-text">{t("memoryFact")}</label><textarea id="memory-text" className="input" rows={3} value={text} maxLength={MEMORY_CAP} disabled={busy} onChange={e=>setText(e.target.value)}/>
    <button className="btn btn-primary" disabled={busy||!text.trim()} onClick={()=>run(async()=>{if(editing)await editMemory(editing,root,text);else await remember(root,text);setText("");setEditing(null);})}>{t("save")}</button>
    {editing&&<button className="btn-ghost" onClick={()=>{setEditing(null);setText("");}}>{t("cancel")}</button>}
    {error&&<div className="error-box" role="alert">{error}</div>}
    <div className="card">{!entries.length&&<div className="card-row muted">{t("memoryEmpty")}</div>}{entries.map(e=><div className="card-row" key={e.id}><div className="grow"><div style={{whiteSpace:"pre-wrap"}}>{e.text}</div><div className="muted">#{e.id} · {t.date(e.updated_at)}{e.source_chat?` · ${t("memorySource")} #${e.source_chat}`:""}</div></div><button className="btn-soft" disabled={busy} onClick={()=>{setEditing(e.id);setText(e.text);}}>{t("edit")}</button><button className="btn-soft" disabled={busy} onClick={()=>run(()=>forget(e.id,root))}>{t("delete")}</button></div>)}</div>
  </>;
}
