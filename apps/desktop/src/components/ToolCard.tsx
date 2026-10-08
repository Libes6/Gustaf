import {
  FilePen,
  FileText,
  FolderTree,
  Globe,
  Loader2,
  Monitor,
  Plug,
  Search,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";
import { useT } from "../i18n";
import { parseLspReport } from "../agent/diagnostics";
import { DiagnosticsList } from "./DiagnosticsList";
import type { Part } from "../providers/types";
import { formatDurationMs } from "../lib/formatDuration";
import { toolFullText, toolKind, toolTarget, type ToolKind } from "../lib/toolLabel";

type Call = Extract<Part, { type: "tool_call" | "activity" }>;
type Result = Extract<Part, { type: "tool_result" }>;

export const TOOL_ICONS: Record<ToolKind, typeof Wrench> = {
  command: SquareTerminal,
  read: FileText,
  list: FolderTree,
  search: Search,
  edit: FilePen,
  write: FilePen,
  skill: Sparkles,
  web: Globe,
  mcp: Plug,
  computer: Monitor,
  device: Smartphone,
  unknown: Wrench,
};

export function summarize(call: Call) {
  const a = call.args ?? {};
  if ("computer" in call && call.computer)
    return call.computer.actions
      .map((x) =>
        "x" in x
          ? `${x.type} ${x.x},${x.y}`
          : x.type === "type"
            ? `type "${x.text.slice(0, 30)}"`
            : x.type === "keypress"
              ? x.keys.join("+")
              : x.type === "open_app"
                ? `open_app "${x.name.slice(0, 40)}"`
                : x.type,
      )
      .join(" · ");
  return (
    a.command ??
    a.file_path ??
    a.path ??
    a.pattern ??
    (a.tool ? `${a.server ?? ""} · ${a.tool}` : undefined) ??
    JSON.stringify(a).slice(0, 80)
  );
}

export type CallStatus = "running" | "success" | "error" | "unknown";
export const callStatus = (call: Call, result?: Result): CallStatus =>
  call.type === "activity" ? call.status : !result ? "running" : result.isError ? "error" : "success";

/** The verb and target of a call's row: `Ran` + `git status` (`Running` + `git status` while it works). Unknown tools show their raw name. */
export function describeCall(t: ReturnType<typeof useT>, call: Call, running: boolean, projectRoot?: string) {
  const kind = toolKind(call);
  const target = toolTarget(call, projectRoot) || (kind === "computer" ? summarize(call) : "");
  const verb =
    kind === "unknown"
      ? call.name
      : kind === "device"
        ? t("deviceAgentVerb")
        : t(`toolVerb_${kind}_${running ? "running" : "done"}`);
  return { kind, verb, target };
}

export function ToolCard({
  call,
  result,
  onRunCommand,
  projectRoot,
  at,
  durationMs,
  awaitingApproval,
}: {
  call: Call;
  result?: Result;
  onRunCommand?: (command: string) => void;
  projectRoot?: string;
  /** When the step that made this call was stored; shown in the tooltip, not in the row. */
  at?: number;
  /** How long the call took (when both the call and its result were stored); shown on hover. */
  durationMs?: number;
  /** The call waits for the user's approval (the approval card is below the feed). */
  awaitingApproval?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [commandError, setCommandError] = useState("");
  const status = callStatus(call, result);
  const output = call.type === "activity" ? call.output : result?.output;
  const { kind, verb, target } = describeCall(t, call, status === "running", projectRoot);
  const Icon = TOOL_ICONS[kind];
  const full = toolFullText(call, projectRoot) || target;
  const diagnostics =
    ["diagnostics", "edit_file", "write_file"].includes(call.name) && call.type === "tool_call"
      ? parseLspReport(output)
      : null;
  const edit = call.name === "edit_file" && call.args;
  // Only states that need attention get a badge; a finished call has no "Completed".
  const badge =
    awaitingApproval && status === "running"
      ? "awaiting"
      : status === "error"
        ? "error"
        : status === "unknown"
          ? "unknown"
          : null;
  const duration = durationMs != null ? formatDurationMs(durationMs, t, { tenths: durationMs < 10_000 }) : "";
  const command = typeof call.args?.command === "string" ? call.args.command : "";
  // Shown for every shell-like card, CLI providers included: it types the exact text in the project terminal, nothing more.
  const canRun = !!onRunCommand && kind === "command" && !!command.trim();
  // Raw JSON is the fallback for tools the app does not know, and only in the expanded body.
  const unknownArgs =
    kind === "unknown" && call.args && Object.keys(call.args).length > 0 ? JSON.stringify(call.args, null, 2) : "";
  return (
    <div className={`tool-card tool-row ${status}`}>
      <div className="tool-line">
        <button className="tool-head" aria-expanded={open} title={full || undefined} onClick={() => setOpen(!open)}>
          <Icon size={13} aria-hidden="true" />
          <span className="tool-text">
            <span className="name">{verb}</span>
            {target && (
              <>
                {" "}
                <span className="arg">{target}</span>
              </>
            )}
          </span>
          {(duration || at) && (
            <span className="tool-duration" title={at ? t.date(at) : undefined}>
              {duration}
            </span>
          )}
          {badge && (
            <span className={`action-status ${badge === "awaiting" ? "awaiting" : badge}`}>
              {badge === "awaiting" ? t("toolAwaitingApproval") : t(`action_${badge}`)}
            </span>
          )}
          {status === "running" && !badge && <Loader2 size={12} className="spin" aria-label={t("action_running")} />}
          {status === "error" && <X size={12} className="err" aria-hidden="true" />}
        </button>
        {canRun && (
          <button
            className="icon-btn tool-terminal"
            title={t("openCommandInTerminal")}
            aria-label={t("openCommandInTerminal")}
            onClick={() => {
              try {
                onRunCommand!(command);
                setCommandError("");
              } catch (e) {
                setCommandError(String(e));
              }
            }}
          >
            <SquareTerminal size={13} />
          </button>
        )}
      </div>
      {commandError && (
        <div className="error-box" role="alert">
          {commandError}
        </div>
      )}
      {status === "error" && output && (
        <div className="action-error" role="alert">
          {output.slice(0, 400)}
        </div>
      )}
      {open && (
        <div className="tool-body">
          {edit && (
            <pre className="diff" style={{ padding: 0 }}>
              {String(edit.old_string)
                .split("\n")
                .map((l: string, i: number) => (
                  <div key={`o${i}`} className="del">
                    - {l}
                  </div>
                ))}
              {String(edit.new_string)
                .split("\n")
                .map((l: string, i: number) => (
                  <div key={`n${i}`} className="add">
                    + {l}
                  </div>
                ))}
            </pre>
          )}
          {unknownArgs && <pre className="tool-args">{unknownArgs}</pre>}
          {result?.image && <img src={`data:image/png;base64,${result.image}`} alt="" />}
          {diagnostics && <DiagnosticsList report={diagnostics} projectRoot={projectRoot} />}
          {output && !diagnostics && <pre className={status === "error" ? "err" : ""}>{output}</pre>}
          {!output && status !== "running" && !unknownArgs && <p className="hint">{t("actionNoOutput")}</p>}
        </div>
      )}
    </div>
  );
}
