import { openUrl } from "@tauri-apps/plugin-opener";
import { X } from "lucide-react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { useDialogFocus } from "../lib/useDialogFocus";
import { ANTIGRAVITY_TERMS_URL, type RuntimeStatus } from "../providers/antigravityRuntime";
import { formatMb } from "../providers/antigravitySupport";
import "../styles/workspaces.css";

export type RuntimeDialogMode = "install" | "update" | "remove";

/**
 * The consent step of the managed install: nothing is downloaded until "Download and install" is pressed here. It shows
 * what will be fetched (source, version, sizes), where it goes, and that the software is Google's under Google's terms.
 * The same dialog confirms removal.
 */
export function AntigravityRuntimeDialog({
  mode,
  status,
  onConfirm,
  onClose,
}: {
  mode: RuntimeDialogMode;
  status: RuntimeStatus;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, onClose);
  const title =
    mode === "remove"
      ? t("antigravityConfirmRemoveTitle")
      : mode === "update"
        ? t("antigravityConfirmUpdateTitle")
        : t("antigravityConfirmTitle");
  return createPortal(
    <div className="review-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section
        ref={ref}
        className="review-dialog ws-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="agy-runtime-dialog"
      >
        <header>
          <strong>{title}</strong>
          <button className="icon-btn" title={t("cancel")} aria-label={t("cancel")} onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div style={{ padding: "14px 18px", overflow: "auto" }}>
          {mode === "remove" ? (
            <p>{t("antigravityConfirmRemoveBody", { folder: status.installed?.dir ?? status.folder })}</p>
          ) : (
            <>
              <dl className="d" style={{ margin: 0 }}>
                <dt>{t("antigravityConfirmSource")}</dt>
                <dd className="mono" style={{ margin: "0 0 8px", overflowWrap: "anywhere" }}>
                  {status.source}
                </dd>
                <dt>{t("antigravityConfirmVersion")}</dt>
                <dd style={{ margin: "0 0 8px" }}>{status.version}</dd>
                <dt>{t("antigravityConfirmSizeTitle")}</dt>
                <dd style={{ margin: "0 0 8px" }}>
                  {t("antigravityConfirmSize", {
                    download: formatMb(status.archiveBytes),
                    unpacked: formatMb(status.unpackedBytes),
                  })}
                </dd>
                <dt>{t("antigravityConfirmFolder")}</dt>
                <dd className="mono" style={{ margin: "0 0 8px", overflowWrap: "anywhere" }}>
                  {status.folder}
                </dd>
              </dl>
              <p>{t("antigravityConfirmLicense")}</p>
              <button className="btn-ghost small" onClick={() => openUrl(ANTIGRAVITY_TERMS_URL).catch(() => {})}>
                {t("antigravityTermsLink")}
              </button>
            </>
          )}
        </div>
        <div className="review-actions" style={{ justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn btn-primary" data-autofocus onClick={onConfirm}>
            {mode === "remove" ? t("antigravityRemoveGo") : t("antigravityConfirmGo")}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
