import { useRef } from "react";
import { useT } from "../../i18n";
import { CHAT_MODES, type ChatMode } from "../../agent/planCore";
import "../../styles/plan.css";

/** Ask / Plan / Agent as a labelled segmented control (radiogroup with arrow-key navigation). */
export function ModeSwitch({ mode, onChange }: { mode: ChatMode; onChange: (m: ChatMode) => void }) {
  const t = useT();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const label = { ask: t("modeAsk"), plan: t("modePlan"), agent: t("modeAgent") };
  const hint = { ask: t("modeAskHint"), plan: t("modePlanHint"), agent: t("modeAgentHint") };
  const move = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = CHAT_MODES[(i + d + CHAT_MODES.length) % CHAT_MODES.length];
    onChange(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="mode-switch" role="radiogroup" aria-label={t("modeSwitch")}>
      {CHAT_MODES.map((m, i) => (
        <button
          key={m}
          ref={(el) => { refs.current[m] = el; }}
          type="button"
          role="radio"
          aria-checked={mode === m}
          tabIndex={mode === m ? 0 : -1}
          className={mode === m ? "on" : ""}
          title={hint[m]}
          onClick={() => onChange(m)}
          onKeyDown={(e) => move(e, i)}
        >
          {label[m]}
        </button>
      ))}
    </div>
  );
}
