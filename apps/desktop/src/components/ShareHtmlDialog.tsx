import { save } from "@tauri-apps/plugin-dialog";
import { Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { fsx } from "../lib/api";
import { listProjects, loadMessages, type Chat } from "../lib/data";
import type { ExportSource } from "../lib/exportChats";
import type { ShareLabels, ShareResult } from "../lib/shareHtml";
import { useDialogFocus } from "../lib/useDialogFocus";
import { mdLabels } from "./ImportPanel";
import "../styles/gitCommit.css";

/**
 * "Share as HTML": the review step before a chat is written as a self-contained page. Shows how many secrets the scrubbing
 * replaced, offers a preview (a sandboxed frame without scripts) and the images option, then saves through the native dialog.
 */
export function ShareHtmlDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const t = useT();
  const [source, setSource] = useState<ExportSource | null>(null);
  const [images, setImages] = useState(false);
  const [result, setResult] = useState<ShareResult | null>(null);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, () => {
    if (!saving) onClose();
  });

  useEffect(() => {
    let live = true;
    (async () => {
      const project =
        chat.project_id == null ? undefined : (await listProjects()).find((p) => p.id === chat.project_id);
      const messages = await loadMessages(chat.id);
      if (live) setSource({ chat, project: project && { name: project.name, path: project.path }, messages });
    })().catch((e) => live && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      live = false;
    };
  }, [chat]);

  useEffect(() => {
    if (!source) return;
    let live = true;
    import("../lib/shareHtml")
      .then(({ buildShareHtml }) => {
        const base = mdLabels(t);
        const labels: ShareLabels = {
          ...base,
          canvas: t("shareHtmlCanvas"),
          model: t("shareHtmlModel"),
          generated: t("shareHtmlGenerated", { date: "{date}" }),
        };
        if (live) setResult(buildShareHtml(source, { includeImages: images, labels }));
      })
      .catch((e) => live && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      live = false;
    };
  }, [source, images, t]);

  const write = async () => {
    if (!result || saving) return;
    setSaving(true);
    setError("");
    try {
      const { shareFileName } = await import("../lib/shareHtml");
      const path = await save({
        defaultPath: shareFileName(chat.title),
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!path) return;
      const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      await fsx.write(path.slice(0, split) || "/", path.slice(split + 1), result.html);
      setSaved(path);
    } catch (e) {
      setError(t("exportFailed", { error: String(e instanceof Error ? e.message : e) }));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="review-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="review-dialog git-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("shareHtmlTitle")}
      >
        <header>
          <strong>
            {t("shareHtmlTitle")} · {chat.title}
          </strong>
          <button className="icon-btn" title={t("cancel")} aria-label={t("cancel")} onClick={onClose} disabled={saving}>
            <X size={17} />
          </button>
        </header>
        <div className="git-body">
          <div className="git-note muted">{t("shareHtmlIntro")}</div>
          {!result && !error && (
            <div className="git-state">
              <Loader2 size={14} className="spin" />
            </div>
          )}
          {result && (
            <div role="status" className={`git-note${result.redactions ? "" : " muted"}`}>
              {result.redactions ? t("shareHtmlRedactions", { count: result.redactions }) : t("shareHtmlNoRedactions")}
            </div>
          )}
          <label className="card-row">
            <input
              type="checkbox"
              className="check"
              checked={images}
              disabled={saving}
              onChange={(e) => setImages(e.target.checked)}
            />
            <div className="grow">
              <div className="t">{t("shareHtmlImages")}</div>
              <div className="d">{t("exportImagesSub")}</div>
            </div>
          </label>
          <label className="card-row">
            <input
              type="checkbox"
              className="check"
              checked={preview}
              disabled={!result}
              onChange={(e) => setPreview(e.target.checked)}
            />
            <div className="grow">
              <div className="t">{t("shareHtmlPreview")}</div>
            </div>
          </label>
          {preview && result && (
            <iframe
              title={t("shareHtmlPreviewTitle")}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={result.html}
              style={{
                width: "100%",
                height: 340,
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "#fff",
              }}
            />
          )}
        </div>
        {error && (
          <div className="error-box git-error git-error-foot" role="alert">
            {error}
          </div>
        )}
        {saved && (
          <div className="ok git-note" role="status" style={{ padding: "0 18px", wordBreak: "break-all" }}>
            {t("exportSaved", { path: saved })}
          </div>
        )}
        <div className="review-actions git-actions">
          <span className="git-note muted grow" />
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
            {t("cancel")}
          </button>
          <button className="btn btn-primary" disabled={!result || saving} onClick={write}>
            {saving && <Loader2 size={13} className="spin" />} {t("shareHtmlSave")}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
