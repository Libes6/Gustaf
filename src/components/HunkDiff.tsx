import { Check, X } from "lucide-react";
import { useT } from "../i18n";
import type { Hunk } from "../lib/api";
import "../styles/reviewSetup.css";

/** Diff of one reviewed file split into hunks, each of which can be ticked, accepted or rejected on its own. */
export function HunkDiff({ hunks, picked, disabled, onToggle, onDecide }: {
  hunks: Hunk[];
  picked: Set<string>;
  disabled: boolean;
  onToggle: (id: string) => void;
  onDecide: (ids: string[], accept: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="hunks">
      {hunks.map((h, i) => (
        <section key={h.id} className="hunk-block" aria-label={h.header}>
          <div className="hunk-head">
            <input type="checkbox" checked={picked.has(h.id)} disabled={disabled} onChange={() => onToggle(h.id)} aria-label={t("hunkSelect", { number: i + 1 })} />
            <span className="grow">{h.header}</span>
            <button className="icon-btn" disabled={disabled} title={t("hunkAccept")} aria-label={`${t("hunkAccept")}: ${h.header}`} onClick={() => onDecide([h.id], true)}><Check size={15} /></button>
            <button className="icon-btn" disabled={disabled} title={t("hunkReject")} aria-label={`${t("hunkReject")}: ${h.header}`} onClick={() => onDecide([h.id], false)}><X size={15} /></button>
          </div>
          <pre className="diff">
            {h.lines.map((l, n) => (
              <div key={n} className={l.kind === "+" ? "add" : l.kind === "-" ? "del" : ""}>{l.kind}{l.text || " "}</div>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}
