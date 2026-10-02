import { Brain } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { InstructionPrompt } from "../../agent/instructions";
import "../../styles/instructions.css";
import type { ModelInfo } from "../../providers/types";

const formatSize = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/** Context-size chip with its popover (capabilities, compact / restore). */
export function ContextChip({ model, tokens, lastInput, busy, canCompact, canRestore, onCompact, onRestore, instructions, onOpen }: {
  model: ModelInfo | undefined;
  tokens: number;
  lastInput: number | undefined;
  /** A run is active: restoring is disabled. */
  busy: boolean;
  canCompact: boolean;
  canRestore: boolean;
  onCompact: () => void;
  onRestore: () => void;
  /** Project instruction files and custom text the next run loads; listed in the popover. */
  instructions?: InstructionPrompt | null;
  onOpen?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="ctx-wrap" ref={ref}>
      <button className="chip ctx" aria-expanded={open} title={t("contextEstimateHint")} onClick={() => (!open && onOpen?.(), setOpen(!open))}>
        {model?.contextWindow
          ? <span className="ctx-ring" style={{ ["--p" as string]: `${Math.min(100, Math.round((tokens / model.contextWindow) * 100))}%` }} />
          : <Brain size={13} />}
        ≈{t.num(tokens)}
      </button>
      {open && <div className="context-pop">
        <div>{t("contextEstimateHint")}</div>
        <div>{t("contextWindow")}: {model?.contextWindow ? t.num(model.contextWindow) : t("capabilityUnknown")}</div>
        <div>{t("contextLastInput")}: {lastInput != null ? t.num(lastInput) : t("capabilityUnknown")}</div>
        <div>{t("capImages")}: {model?.images == null ? t("capabilityUnknown") : t(model.images ? "capabilityYes" : "capabilityNo")}</div>
        <div>{t("capTools")}: {model?.tools == null ? t("capabilityUnknown") : t(model.tools ? "capabilityYes" : "capabilityNo")}</div>
        {instructions && (instructions.entries.length > 0 || instructions.custom.chars > 0) && (
          <div className="ctx-instructions">
            <div>{t("instructionsLoaded")}</div>
            {instructions.entries.map((e) => (
              <div key={e.name} className={`ctx-instr ${e.status}`} title={t("instructionsUntrusted")}>
                <span className="name">{e.name}</span>
                <span className="meta">{t(`instrStatus_${e.status}`, { used: t.num(e.used) })} · {formatSize(e.bytes)}</span>
              </div>
            ))}
            {instructions.custom.chars > 0 && (
              <div className="ctx-instr loaded">
                <span className="name">{t("instructionsCustom")}</span>
                <span className="meta">{t(instructions.custom.truncated ? "instrStatus_truncated" : "instrStatus_loaded", { used: t.num(instructions.custom.chars) })}</span>
              </div>
            )}
          </div>
        )}
        <button className="btn-soft" disabled={!canCompact} onClick={onCompact}>{t("compactChat")}</button>
        {canRestore && <button className="btn-soft" disabled={busy} title={t("restoreContextHint")} onClick={onRestore}>{t("restoreContext")}</button>}
        <span className="hint">{t("compactHint")}</span>
      </div>}
    </div>
  );
}
