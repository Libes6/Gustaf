import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";

/** Full-size image dialog. Closes on Esc, backdrop click or the close button; focus moves in and returns to the opener. */
export function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const t = useT();
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    return () => opener?.focus?.();
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    else if (e.key === "Tab") { e.preventDefault(); closeBtn.current?.focus(); } // the close button is the only tab stop: a focus trap
  };
  return createPortal(
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={alt} onKeyDown={onKeyDown}>
      <div className="image-viewer-backdrop" role="presentation" onClick={onClose} />
      <button ref={closeBtn} className="image-viewer-close" title={t("closeImage")} aria-label={t("closeImage")} onClick={onClose}><X size={16} /></button>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  );
}

/** A thumbnail that opens the viewer on click or Enter/Space. Renders the <img> itself so existing thumbnail styles apply. */
export function ImageThumb({ src, alt }: { src: string; alt: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        src={src} alt={alt} role="button" tabIndex={0} className="image-thumb" title={t("openImage")}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } }}
      />
      {open && <ImageViewer src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}
