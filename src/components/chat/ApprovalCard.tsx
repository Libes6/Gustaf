import { useEffect } from "react";
import type { ApprovalRequest } from "../../agent/agent";
import type { RiskCode } from "../../agent/computerCore";
import { useT, type Key } from "../../i18n";

const RISK: Record<RiskCode, Key> = { enterAfterTyping: "riskEnterAfterTyping", newline: "riskNewline", destructiveShortcut: "riskDestructiveShortcut" };
import { summarize } from "../ToolCard";

export function ApprovalCard({ req, onAnswer }: { req: ApprovalRequest; onAnswer: (ok: boolean, always?: boolean) => void }) {
  const t = useT();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Enter" && e.metaKey) onAnswer(true);
      if (e.key === "Escape") onAnswer(false);
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onAnswer]);
  return (
    <div className="approval" role="alertdialog" aria-label={req.kind === "command" ? t("approveCommand") : t("approveComputer")}>
      {req.agent && <div style={{ fontSize: 12, marginBottom: 4, color: "var(--text-3)" }}>{t("approveAgent", { title: req.agent })}</div>}
      <div className="q">{req.kind === "command" ? t("approveCommand") : t("approveComputer")}</div>
      <pre>{req.kind === "command" ? req.command : summarize({ type: "tool_call", id: "", name: "computer", args: {}, computer: { actions: req.actions } })}</pre>
      {req.kind === "computer" && req.reason && <div className="warn" style={{ marginBottom: 8 }}>⚠ {t(RISK[req.reason])}</div>}
      {req.kind === "computer" && req.safety?.map((s, i) => <div key={i} className="warn" style={{ marginBottom: 8 }}>⚠ {s}</div>)}
      <div className="btns">
        <button className="btn btn-ghost" aria-keyshortcuts="Escape" onClick={() => onAnswer(false)}>
          {t("deny")} <span className="kbd">Esc</span>
        </button>
        {req.kind === "command" && (
          <button className="btn-soft" onClick={() => onAnswer(true, true)}>
            {t("alwaysAllow")}
          </button>
        )}
        {req.kind === "computer" && req.allowTask && (
          <button className="btn-soft" onClick={() => onAnswer(true, true)}>
            {t("allowForTask")}
          </button>
        )}
        <button className="btn btn-primary" aria-keyshortcuts="Meta+Enter" onClick={() => onAnswer(true)}>
          {t("allow")} <span className="kbd">⌘↵</span>
        </button>
      </div>
    </div>
  );
}
