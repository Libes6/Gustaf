import { useEffect } from "react";
import type { ApprovalRequest } from "../../agent/agent";
import type { RiskCode } from "../../agent/computerCore";
import { useT, type Key } from "../../i18n";
import { cmdKey } from "../../lib/shortcuts";
import { displayKeys, isMac } from "../../lib/platform";

const RISK: Record<RiskCode, Key> = { enterAfterTyping: "riskEnterAfterTyping", newline: "riskNewline", destructiveShortcut: "riskDestructiveShortcut" };
import { summarize } from "../ToolCard";
import { allowMcpTool } from "../../agent/mcp/runtime";

/** Arguments of an MCP call as shown for approval (bounded). */
const mcpArgs = (args: unknown) => {
  const text = JSON.stringify(args ?? {}, null, 2) ?? "{}";
  return text.length > 4000 ? text.slice(0, 4000) + "\n…" : text;
};

export function ApprovalCard({ req, onAnswer }: { req: ApprovalRequest; onAnswer: (ok: boolean, always?: boolean) => void }) {
  const t = useT();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Enter" && cmdKey(e)) onAnswer(true);
      if (e.key === "Escape") onAnswer(false);
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onAnswer]);
  return (
    <div className="approval" role="alertdialog" aria-label={req.kind === "command" ? t("approveCommand") : req.kind === "terminal" ? t("approveTerminal") : req.kind === "web" ? t("approveWeb") : req.kind === "memory" ? t("approveMemory") : t("approveComputer")}>
      {req.agent && <div style={{ fontSize: 12, marginBottom: 4, color: "var(--text-3)" }}>{t("approveAgent", { title: req.agent })}</div>}
      <div className="q">{req.kind === "command" ? t("approveCommand") : req.kind === "terminal" ? t("approveTerminal") : req.kind === "web" ? t("approveWeb") : req.kind === "memory" ? t("approveMemory") : req.kind === "mcp" ? t("approveMcp", { tool: req.tool, server: req.server }) : t("approveComputer")}</div>
      <pre>{req.kind === "command" ? req.command : req.kind === "terminal" ? req.text : req.kind === "web" ? req.text : req.kind === "memory" ? req.text : req.kind === "mcp" ? mcpArgs(req.args) : summarize({ type: "tool_call", id: "", name: "computer", args: {}, computer: { actions: req.actions } })}</pre>
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
        {req.kind === "mcp" && (
          <button className="btn-soft" onClick={() => allowMcpTool(req.serverId, req.tool).catch(() => {}).finally(() => onAnswer(true))}>
            {t("mcpAlwaysAllowTool")}
          </button>
        )}
        {req.kind === "computer" && req.allowTask && (
          <button className="btn-soft" onClick={() => onAnswer(true, true)}>
            {t("allowForTask")}
          </button>
        )}
        <button className="btn btn-primary" aria-keyshortcuts={isMac() ? "Meta+Enter" : "Control+Enter"} onClick={() => onAnswer(true)}>
          {t("allow")} <span className="kbd">{displayKeys("⌘↵")}</span>
        </button>
      </div>
    </div>
  );
}
