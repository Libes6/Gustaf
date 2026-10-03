import { Loader2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n";
import { useDialogFocus } from "../lib/useDialogFocus";
import "../styles/gitCommit.css";
import "../styles/workspaces.css";

/** A small modal with a message and two buttons; Escape and a click outside cancel. */
export function ConfirmDialog({ title, children, confirmLabel, cancelLabel, danger, busy, onConfirm, onCancel }: {
  title: string; children?: ReactNode; confirmLabel: string; cancelLabel?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, () => { if (!busy) onCancel(); });
  return createPortal(
    <div className="review-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <section ref={ref} className="review-dialog ws-dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <header>
          <strong>{title}</strong>
          <button className="icon-btn" title={t("cancel")} aria-label={t("cancel")} onClick={onCancel} disabled={busy}><X size={17} /></button>
        </header>
        <div className="git-body">{children}</div>
        <div className="review-actions git-actions">
          <span className="grow" />
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>{cancelLabel ?? t("cancel")}</button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={busy}>{busy && <Loader2 size={13} className="spin" />} {confirmLabel}</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

type Ask = { title: string; body: ReactNode; confirmLabel: string; cancelLabel?: string };

/** `ask()` shows a ConfirmDialog and resolves with the answer; render `node` somewhere in the tree. */
export function useConfirm() {
  const [pending, setPending] = useState<(Ask & { resolve: (ok: boolean) => void }) | null>(null);
  const ask = useCallback((a: Ask) => new Promise<boolean>((resolve) => setPending({ ...a, resolve })), []);
  const answer = (ok: boolean) => { pending?.resolve(ok); setPending(null); };
  const node = pending ? (
    <ConfirmDialog title={pending.title} confirmLabel={pending.confirmLabel} cancelLabel={pending.cancelLabel} onConfirm={() => answer(true)} onCancel={() => answer(false)}>
      {pending.body}
    </ConfirmDialog>
  ) : null;
  return { ask, node };
}

/** "New workspace…": asks what the task is (it names the branch and the chat), then calls `onCreate`. */
export function NewWorkspaceDialog({ projectName, busy, error, onCreate, onCancel }: {
  projectName: string; busy: boolean; error: string; onCreate: (title: string) => void; onCancel: () => void;
}) {
  const t = useT();
  const [title, setTitle] = useState("");
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, () => { if (!busy) onCancel(); });
  const submit = () => { if (!busy) onCreate(title.trim() || t("workspaceNewTitle")); };
  return createPortal(
    <div className="review-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <section ref={ref} className="review-dialog ws-dialog" role="dialog" aria-modal="true" aria-label={t("workspaceNewTitle")}>
        <header>
          <strong>{t("workspaceNewTitle")} · {projectName}</strong>
          <button className="icon-btn" title={t("cancel")} aria-label={t("cancel")} onClick={onCancel} disabled={busy}><X size={17} /></button>
        </header>
        <div className="git-body">
          <div>
            <label htmlFor="workspace-title">{t("workspaceNameLabel")}</label>
            <input id="workspace-title" className="input" autoFocus value={title} disabled={busy} placeholder={t("workspaceNamePlaceholder")}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
            <div className="git-note muted">{t("workspaceNewHint")}</div>
          </div>
        </div>
        {error && <div className="error-box git-error git-error-foot" role="alert">{error}</div>}
        <div className="review-actions git-actions">
          <span className="grow" />
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>{t("cancel")}</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy && <Loader2 size={13} className="spin" />} {busy ? t("workspaceCreating") : t("workspaceCreate")}</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
