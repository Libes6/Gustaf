import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fsx, review } from "../lib/api";
import { useT } from "../i18n";
import type { FileDiagnostic, LspReport } from "../agent/diagnostics";
/** File/range navigation reads the same workspace that produced the diagnostic. */
export function DiagnosticsList({ report, root, projectRoot }: { report: LspReport; root?: string; projectRoot?: string }) {
  const t = useT(); const ru = t.locale === "ru";
  const [source, setSource] = useState<{ diagnostic: FileDiagnostic; text: string } | null>(null);
  const [error, setError] = useState("");
  const [verified, setVerified] = useState<{ root: string; scope: string | undefined } | undefined>(root ? { root, scope: projectRoot } : undefined);
  useEffect(() => {
    let live = true;
    setVerified(root ? { root, scope: projectRoot } : undefined);
    if (root || !projectRoot) return;
    if (!report.root || report.root === projectRoot) { setVerified({ root: projectRoot, scope: projectRoot }); return; }
    review.list(projectRoot).then(entries => {
      if (live && (entries ?? []).some(([r]) => r.workspace === report.root)) setVerified({ root: report.root!, scope: projectRoot });
    }, () => {});
    return () => { live = false; };
  }, [root, projectRoot, report.root]);
  const target = root ?? (verified?.scope === projectRoot && verified?.root === (report.root ?? projectRoot) ? verified?.root : undefined);
  const open = async (diagnostic: FileDiagnostic) => {
    if (!target) return;
    try { const text = await fsx.read(target, diagnostic.path, Math.max(1, diagnostic.line - 8), 20); setSource({ diagnostic, text }); setError(""); }
    catch (e) { setError(String(e)); }
  };
  return <div className="diagnostics-list">
    <p className="hint">{report.detail}</p>
    {report.diagnostics.map((d, i) => <div key={i} className="card-row" style={{ alignItems:"start" }}>
      <button className="btn-soft" disabled={!target} onClick={() => void open(d)}>{d.path}:{d.line}:{d.column}</button>
      <div className="grow"><strong>{d.severity}{d.code ? ` ${d.code}` : ""}</strong><div style={{ whiteSpace:"pre-wrap" }}>{d.message}</div><small>{d.source}</small></div>
    </div>)}
    {report.status === "complete" && !report.diagnostics.length && <p className="hint">{ru ? "В этом снимке ошибок не получено. Это не результат тестов проекта." : "No diagnostics in this snapshot. This is not a project test result."}</p>}
    {error && <div className="error-box" role="alert">{error}</div>}
    {source && createPortal(<div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSource(null); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`${source.diagnostic.path}:${source.diagnostic.line}`} onKeyDown={e => { if (e.key === "Escape") setSource(null); }}>
        <div className="modal-head"><strong>{source.diagnostic.path}:{source.diagnostic.line}:{source.diagnostic.column}</strong><button className="btn-soft" autoFocus onClick={() => setSource(null)}>{ru ? "Закрыть" : "Close"}</button></div>
        <pre style={{ maxHeight:"60vh", overflow:"auto", userSelect:"text" }}>{source.text.split("\n").map((line, i) => <div key={i} style={Number(/^\s*(\d+)\|/.exec(line)?.[1]) === source.diagnostic.line ? { background:"rgba(255,180,40,.15)" } : undefined}>{line}</div>)}</pre>
      </div>
    </div>, document.body)}
  </div>;
}
