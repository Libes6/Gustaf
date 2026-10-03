import { Loader2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { CUSTOM_INSTRUCTIONS_CAP, type InstructionPrompt } from "../agent/instructions";
import { getProjectInstructionText, loadProjectInstructions, setProjectInstructionText } from "../agent/instructionsStore";
import { useT } from "../i18n";
import { useDialogFocus } from "../lib/useDialogFocus";
import { announceInstructionsSaved } from "../lib/useInstructionReport";
import "../styles/instructions.css";

/**
 * Per-project instructions: a custom text added to the agent's system prompt for this project, plus a read-only list of the
 * instruction files found in the folder (AGENTS.md, CLAUDE.md, .cursorrules, always-apply Cursor rules).
 */
export function ProjectInstructionsDialog({ name, path, onClose }: { name: string; path: string; onClose: () => void }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [files, setFiles] = useState<InstructionPrompt["entries"]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, () => { if (!saving) onClose(); });

  useEffect(() => {
    getProjectInstructionText(path).then(setText, () => setText(""));
    loadProjectInstructions({ root: path, project: null }).then((r) => setFiles(r.entries), () => {});
  }, [path]);

  const save = async () => {
    setSaving(true);
    try {
      await setProjectInstructionText(path, text ?? "");
      announceInstructionsSaved();
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return createPortal(
    <div className="review-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <section ref={dialogRef} className="review-dialog git-dialog" role="dialog" aria-modal="true" aria-label={t("projectInstructions")}>
        <header>
          <strong>{t("projectInstructions")} · {name}</strong>
          <button className="icon-btn" title={t("cancel")} aria-label={t("cancel")} onClick={onClose} disabled={saving}><X size={17} /></button>
        </header>
        <div className="git-body">
          <div>
            <label htmlFor="project-instructions">{t("instructionsCustom")}</label>
            {text === null ? <div className="git-state"><Loader2 size={14} className="spin" /></div> : (
              <textarea
                id="project-instructions" autoFocus className="input instructions-text" rows={9} value={text} disabled={saving} spellCheck
                maxLength={CUSTOM_INSTRUCTIONS_CAP} placeholder={t("instructionsPlaceholder")}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); save(); } }}
              />
            )}
            <div className="git-note muted">{t("instructionsCustomHint", { max: t.num(CUSTOM_INSTRUCTIONS_CAP) })}</div>
          </div>
          <div>
            <div className="instructions-head">{t("instructionsFound")}</div>
            {files.length === 0
              ? <div className="git-note muted">{t("instructionsNoFiles")}</div>
              : files.map((f) => (
                <div key={f.name} className="ctx-instr">
                  <span className="name">{f.name}</span>
                  <span className="meta">{f.bytes < 1024 ? `${f.bytes} B` : `${(f.bytes / 1024).toFixed(1)} KB`}</span>
                </div>
              ))}
            <div className="git-note muted">{t("instructionsUntrusted")}</div>
          </div>
        </div>
        {error && <div className="error-box git-error git-error-foot" role="alert">{error}</div>}
        <div className="review-actions git-actions">
          <span className="git-note muted grow" />
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>{t("cancel")}</button>
          <button className="btn btn-primary" disabled={saving || text === null} onClick={save}>{saving && <Loader2 size={13} className="spin" />} {t("save")}</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
