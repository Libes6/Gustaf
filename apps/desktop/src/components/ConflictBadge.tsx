import { AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { conflictKindKey, type ConflictBadge as Badge } from "../lib/mergeQueueView";
import "../styles/workspaces.css";

const MAX_FILES = 40;

/** "conflicts with main (3 files)": opens a popover with the files and the kind of conflict for each comparison. */
export function ConflictBadge({ badge, title }: { badge: Badge; title: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!open) return;
    const r = btn.current!.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(r.left, innerWidth - 328)), y: Math.min(r.bottom + 4, innerHeight - 120) });
    const down = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", down, true);
    addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down, true); removeEventListener("keydown", key, true); };
  }, [open]);

  const text = t("mqBadge", { against: badge.against, count: badge.files }) + (badge.more ? ` +${badge.more}` : "");
  return (
    <>
      <button ref={btn} className="ws-conflict" aria-haspopup="dialog" aria-expanded={open} title={t("mqBadgeTitle", { title })} onClick={() => setOpen(!open)}>
        <AlertTriangle size={11} aria-hidden="true" /> <span className="txt">{text}</span>
      </button>
      {open && createPortal(
        <div ref={pop} className="ws-conflict-pop" role="dialog" aria-label={t("mqPopoverTitle", { title })} style={{ left: pos.x, top: pos.y }}>
          <strong>{t("mqPopoverTitle", { title })}</strong>
          {badge.groups.map((g) => (
            <section key={g.againstTaskId ?? "target"}>
              <h4>{g.target ? t("mqPopoverTarget", { branch: g.against }) : t("mqPopoverWorkspace", { branch: g.against })}</h4>
              <ul>
                {g.files.slice(0, MAX_FILES).map((f) => (
                  <li key={f.path}><span className="path">{f.path}</span><span className="kind">{t(conflictKindKey(f.kind))}</span></li>
                ))}
              </ul>
              {(g.files.length > MAX_FILES || g.truncated) && <div className="hint">{t("mqPopoverMore", { count: g.files.length })}</div>}
            </section>
          ))}
          <div className="hint">{t("mqPopoverHint")}</div>
        </div>,
        document.body,
      )}
    </>
  );
}
