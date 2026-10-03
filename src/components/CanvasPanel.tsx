import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, FileCode, RotateCcw, X } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { fsx } from "../lib/api";
import { canvasDocument } from "../canvas/document";
import CanvasDiff from "./CanvasDiff";
import type { Artifact } from "../canvas/artifacts";
import { useT } from "../i18n";

export default function CanvasPanel({ artifact, versions, onSelect, onClose, onRepair }: {
  artifact: Artifact; versions: Artifact[]; onSelect: (artifact: Artifact) => void; onClose: () => void; onRepair: (prompt: string) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<"preview" | "code" | "changes">("preview");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [copyError, setCopyError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState("");
  const [fileName, setFileName] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const file = artifact.files.find((f) => f.name === fileName) ?? artifact.files[0];
  const multi = artifact.files.length > 1;
  const document = useMemo(() => canvasDocument(artifact.code), [artifact.code, revision]);
  useEffect(() => {
    setError("");
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== "mcode-canvas-error" || typeof event.data.message !== "string") return;
      setError(event.data.message.slice(0, 4000));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [document]);
  const saveAs = async (name: string, content: string, mime: string) => {
    if (saving) return;
    setCopyError("");
    setSavedPath("");
    setSaving(true);
    const ext = name.split(".").pop()!;
    try {
      if (isTauri()) {
        const path = await save({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
        if (!path) return;
        const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
        await fsx.write(path.slice(0, split) || "/", path.slice(split + 1), content);
        setSavedPath(path);
      } else {
        const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
        const a = window.document.createElement("a"); a.href = url; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) { setCopyError(String(e instanceof Error ? e.message : e)); }
    finally { setSaving(false); }
  };
  const baseName = artifact.id.replace(/[^a-zA-Z0-9_-]/g, "-") || "canvas";
  const download = () => saveAs(multi ? file.name.split("/").pop()! : `${baseName}.tsx`, file.code, "text/plain");
  const exportHtml = () => saveAs(`${baseName}.html`, canvasDocument(artifact.code, artifact.title), "text/html");
  const current = versions.findIndex((v) => v.code === artifact.code);
  return <aside className="canvas-panel" aria-label={artifact.title}>
    <header className="canvas-header"><strong>{artifact.title}</strong>
      <button className="icon-btn" onClick={onClose} title={t("canvasClose")}><X size={17} /></button>
    </header>
    <div className="canvas-toolbar">
      <div className="canvas-tabs">
        <button aria-pressed={tab === "preview"} onClick={() => setTab("preview")}>{t("canvasPreview")}</button>
        <button aria-pressed={tab === "code"} onClick={() => setTab("code")}>{t("canvasCode")}</button>
        {versions.length > 1 && <button aria-pressed={tab === "changes"} onClick={() => setTab("changes")}>{t("canvasChanges")}</button>}
      </div>
      {versions.length > 1 && <select aria-label={t("canvasVersion")} value={current} onChange={(e) => onSelect(versions[Number(e.target.value)])}>
        {current < 0 && <option value={-1}>{t("canvasCurrent")}</option>}
        {versions.map((_, i) => <option key={i} value={i}>{t("canvasVersion")} {i + 1}</option>)}
      </select>}
      <button className="icon-btn" title={t("copy")} onClick={() => { navigator.clipboard.writeText(file.code).catch(() => setCopyError(t("canvasCopyError"))); }}><Copy size={15} /></button>
      <button className="icon-btn" title={t("canvasDownload")} disabled={saving} onClick={download}><Download size={15} /></button>
      <button className="icon-btn" title={t("canvasExportHtml")} aria-label={t("canvasExportHtml")} disabled={saving} onClick={exportHtml}><FileCode size={15} /></button>
      <button className="icon-btn" title={t("canvasRestart")} onClick={() => { setError(""); setRevision((r) => r + 1); }}><RotateCcw size={15} /></button>
    </div>
    {savedPath && <div className="canvas-export-status" role="status">{t("canvasSaved", { path: savedPath })}</div>}
    {copyError && <div role="alert" className="error-box">{copyError}</div>}
    {error && <div className="canvas-error" role="alert"><pre>{error}</pre><button className="btn-soft" onClick={() => onRepair(t("canvasRepairPrompt", { id: artifact.id, error }) + `\n\n\`\`\`tsx-canvas id="${artifact.id}"\n${artifact.code}\n\`\`\``)}>{t("canvasRepair")}</button></div>}
    <iframe ref={frame} key={revision} hidden={tab !== "preview"} title={artifact.title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document} />
    {tab === "changes" && versions.length > 1 && <CanvasDiff versions={versions} current={current} />}
    {tab === "code" && multi && <div className="canvas-files" role="tablist" aria-label={t("canvasFiles")}>
      {artifact.files.map((f) => <button key={f.name} role="tab" aria-selected={f === file} onClick={() => setFileName(f.name)}>{f.name}</button>)}
    </div>}
    {tab === "code" && <pre className="canvas-source"><code>{file.code}</code></pre>}
  </aside>;
}
