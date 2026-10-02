import { useEffect } from "react";
import type { ApprovalRequest } from "../../agent/agent";
import { useT } from "../../i18n";
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
    <div className="approval">
      <div className="q">{req.kind === "command" ? t("approveCommand") : t("approveComputer")}</div>
      <pre>{req.kind === "command" ? req.command : summarize({ type: "tool_call", id: "", name: "computer", args: {}, computer: { actions: req.actions } })}</pre>
      {req.kind === "computer" && req.safety?.map((s, i) => <div key={i} className="warn" style={{ marginBottom: 8 }}>⚠ {s}</div>)}
      <div className="btns">
        <button className="btn btn-ghost" onClick={() => onAnswer(false)}>
          {t("deny")} <span className="kbd">Esc</span>
        </button>
        {req.kind === "command" && (
          <button className="btn-soft" onClick={() => onAnswer(true, true)}>
            {t("alwaysAllow")}
          </button>
        )}
        <button className="btn btn-primary" onClick={() => onAnswer(true)}>
          {t("allow")} <span className="kbd">⌘↵</span>
        </button>
      </div>
    </div>
  );
}
