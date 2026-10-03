import { Check, FilePen, FileText, FolderTree, Loader2, Monitor, Search, SquareTerminal, Wrench, X } from "lucide-react";
import { useState } from "react";
import { useT } from "../i18n";
import type { Part } from "../providers/types";

type Call = Extract<Part, { type: "tool_call" | "activity" }>;
type Result = Extract<Part, { type: "tool_result" }>;

const ICONS: Record<string, typeof Wrench> = {
  read_file: FileText,
  list_dir: FolderTree,
  search: Search,
  edit_file: FilePen,
  write_file: FilePen,
  run_command: SquareTerminal,
};

export function summarize(call: Call) {
  const a = call.args ?? {};
  if ("computer" in call && call.computer) return call.computer.actions.map((x) => ("x" in x ? `${x.type} ${x.x},${x.y}` : x.type === "type" ? `type "${x.text.slice(0, 30)}"` : x.type === "keypress" ? x.keys.join("+") : x.type === "open_app" ? `open_app "${x.name.slice(0, 40)}"` : x.type)).join(" · ");
  return a.command ?? a.file_path ?? a.path ?? a.pattern ?? (a.tool ? `${a.server ?? ""} · ${a.tool}` : undefined) ?? JSON.stringify(a).slice(0, 80);
}

export function ToolCard({ call, result }: { call: Call; result?: Result }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const desktop = "computer" in call && call.computer;
  const status = call.type === "activity" ? call.status : !result ? "running" : result.isError ? "error" : "success";
  const output = call.type === "activity" ? call.output : result?.output;
  const labels: Record<string, Parameters<typeof t>[0]> = { read_file: "actionRead", read: "actionRead", list_dir: "actionList", glob: "actionList", search: "actionSearch", grep: "actionSearch", edit_file: "actionEdit", write_file: "actionWrite", edit: "actionEdit", write: "actionWrite", file_change: "actionEdit", run_command: "actionCommand", shell: "actionCommand", bash: "actionCommand", command_execution: "actionCommand", mcp_tool_call: "actionIntegration" };
  const label = desktop ? t("actionComputer") : labels[call.name.toLowerCase()] ? t(labels[call.name.toLowerCase()]) : call.name;
  const Icon = desktop ? Monitor : ICONS[call.name] ?? Wrench;
  const edit = call.name === "edit_file" && call.args;
  return (
    <div className="tool-card">
      <button className="tool-head" style={{ width: "100%" }} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon size={14} />
        <span className="name">{label}</span>
        <span className="arg">{summarize(call)}</span>
        <span className={`action-status ${status}`}>{t(`action_${status}`)}</span>
        {status === "running" ? <Loader2 size={13} className="spin" /> : status === "error" ? <X size={13} className="err" /> : status === "success" ? <Check size={13} color="var(--green)" /> : null}
      </button>
      {status === "error" && output && <div className="action-error" role="alert">{output.slice(0, 400)}</div>}
      {open && (
        <div className="tool-body">
          {edit && (
            <pre className="diff" style={{ padding: 0 }}>
              {String(edit.old_string).split("\n").map((l: string, i: number) => <div key={`o${i}`} className="del">- {l}</div>)}
              {String(edit.new_string).split("\n").map((l: string, i: number) => <div key={`n${i}`} className="add">+ {l}</div>)}
            </pre>
          )}
          {result?.image && <img src={`data:image/png;base64,${result.image}`} alt="" />}
          {output && <pre className={status === "error" ? "err" : ""}>{output}</pre>}
          {!output && status !== "running" && <p className="hint">{t("actionNoOutput")}</p>}
        </div>
      )}
    </div>
  );
}
