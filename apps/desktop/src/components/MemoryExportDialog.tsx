import { Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { listMemories } from "../agent/memory";
import { MemoryExportError } from "../agent/memoryExport";
import { previewAgentsExport, writeAgentsExport, type ExportPreview } from "../agent/memoryExportStore";
import { useDialogFocus } from "../lib/useDialogFocus";
import "../styles/gitCommit.css";
import "../styles/memory.css";

/**
 * "Export to AGENTS.md": shows the exact resulting file text and writes it only after an explicit confirm. Only the managed
 * section between the gustaf-memory markers is created or replaced; the rest of the file is never touched.
 */
export function MemoryExportDialog({ root, name, onClose }: { root: string; name?: string; onClose: () => void }) {
  const t = useT();
  const [includeGlobal, setIncludeGlobal] = useState(false);
  const [globalTotal, setGlobalTotal] = useState<number | null>(null);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [writing, setWriting] = useState(false);
  const [done, setDone] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, () => {
    if (!writing) onClose();
  });

  useEffect(() => {
    listMemories(null).then(
      (l) => setGlobalTotal(l.length),
      () => setGlobalTotal(0),
    );
  }, []);
  useEffect(() => {
    let live = true;
    setPreview(null);
    setError("");
    setNotice("");
    previewAgentsExport(root, includeGlobal).then(
      (p) => live && setPreview(p),
      (e) => live && setError(failure(e)),
    );
    return () => {
      live = false;
    };
  }, [root, includeGlobal]);

  const failure = (e: unknown) =>
    e instanceof MemoryExportError
      ? t(e.code === "malformed" ? "memoryExportMalformed" : "memoryExportUnreadable")
      : t("memoryExportFailed", { error: String(e instanceof Error ? e.message : e) });
  const total = preview ? preview.projectCount + preview.globalCount : 0;

  const write = async () => {
    if (!preview || writing) return;
    setWriting(true);
    setError("");
    setNotice("");
    try {
      const r = await writeAgentsExport(root, includeGlobal, preview.text);
      if (r.written) setDone(true);
      else {
        setPreview(r.preview);
        setNotice(t("memoryExportChanged"));
      }
    } catch (e) {
      setError(failure(e));
    } finally {
      setWriting(false);
    }
  };

  return createPortal(
    <div
      className="review-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !writing) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="review-dialog git-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("memoryExportTitle")}
      >
        <header>
          <strong>
            {t("memoryExportTitle")}
            {name ? ` · ${name}` : ""}
          </strong>
          <button
            className="icon-btn"
            title={t("cancel")}
            aria-label={t("cancel")}
            onClick={onClose}
            disabled={writing}
          >
            <X size={17} />
          </button>
        </header>
        <div className="git-body">
          <div className="git-note muted">{t("memoryExportIntro")}</div>
          <label className="card-row">
            <input
              type="checkbox"
              className="check"
              checked={includeGlobal}
              disabled={writing || done}
              onChange={(e) => setIncludeGlobal(e.target.checked)}
            />
            <div className="grow">
              <div className="t">{t("memoryExportGlobal", { count: globalTotal ?? 0 })}</div>
              <div className="d">{t("memoryExportGlobalSub")}</div>
            </div>
          </label>
          {!preview && !error && (
            <div className="git-state">
              <Loader2 size={14} className="spin" />
            </div>
          )}
          {preview && (
            <>
              <div role="status" className="git-note muted">
                {t(`memoryExportAction_${preview.action}`)} ·{" "}
                {t("memoryExportCounts", { project: preview.projectCount, global: preview.globalCount })}
              </div>
              {total === 0 && <div className="git-note">{t("memoryExportNothing")}</div>}
              <pre className="memory-preview" aria-label={t("memoryExportPreview")} tabIndex={0}>
                {preview.text}
              </pre>
            </>
          )}
          {notice && (
            <div className="git-note" role="status">
              {notice}
            </div>
          )}
        </div>
        {error && (
          <div className="error-box git-error git-error-foot" role="alert">
            {error}
          </div>
        )}
        {done && (
          <div className="ok git-note" role="status" style={{ padding: "0 18px" }}>
            {t("memoryExportDone")}
          </div>
        )}
        <div className="review-actions git-actions">
          <span className="git-note muted grow" />
          <button className="btn btn-ghost" onClick={onClose} disabled={writing}>
            {done ? t("memoryClose") : t("cancel")}
          </button>
          {!done && (
            <button
              className="btn btn-primary"
              disabled={!preview || writing || total === 0 || preview.action === "unchanged"}
              onClick={write}
            >
              {writing && <Loader2 size={13} className="spin" />} {t("memoryExportWrite")}
            </button>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
