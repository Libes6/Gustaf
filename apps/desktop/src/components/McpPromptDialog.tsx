import { Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { McpServer } from "../agent/mcp/config";
import { missingPromptArgs, type McpPrompt } from "../agent/mcp/prompts";
import { getMcpPrompt, listPromptsForPicker } from "../agent/mcp/runtime";
import { useT } from "../i18n";
import { useDialogFocus } from "../lib/useDialogFocus";
import "../styles/mcp.css";

type Group = { server: McpServer; prompts: McpPrompt[]; error?: string };

/**
 * Composer: pick a prompt template offered by an MCP server, fill its arguments, and insert the rendered text into the
 * composer. The user is in control at every step: prompts are listed on open, `prompts/get` runs only on "Insert", and
 * the result is only put into the text box (nothing is sent and the model never sees prompts as tools).
 */
export function McpPromptDialog({ project, onInsert, onClose }: { project: string | null; onInsert: (text: string) => void; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, onClose);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [chosen, setChosen] = useState<{ server: McpServer; prompt: McpPrompt } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const ctl = useRef<AbortController | null>(null);

  useEffect(() => {
    const c = new AbortController();
    ctl.current = c;
    listPromptsForPicker(project, c.signal).then((g) => !c.signal.aborted && setGroups(g), () => !c.signal.aborted && setGroups([]));
    return () => c.abort();
  }, [project]);

  const insert = async () => {
    if (!chosen) return;
    const lacking = missingPromptArgs(chosen.prompt, values);
    setMissing(lacking);
    if (lacking.length) return;
    setBusy(true);
    setError("");
    const c = new AbortController();
    ctl.current = c;
    try {
      const r = await getMcpPrompt(chosen.server, chosen.prompt, values, c.signal);
      if (c.signal.aborted) return;
      if (!r.text.trim()) setError(t("mcpPromptEmpty"));
      else onInsert(r.text);
    } catch (e) {
      if (!c.signal.aborted) setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => (ctl.current?.abort(), onClose());
  const withPrompts = groups?.filter((g) => g.prompts.length) ?? [];
  const failed = groups?.filter((g) => g.error) ?? [];

  return createPortal(
    <div className="review-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section ref={ref} className="review-dialog mcp-prompt-dialog" role="dialog" aria-modal="true" aria-label={t("mcpPromptTitle")}>
        <header>
          <strong>{chosen ? chosen.prompt.title || chosen.prompt.name : t("mcpPromptTitle")}</strong>
          <button className="icon-btn" title={t("cancel")} aria-label={t("cancel")} onClick={close}><X size={17} /></button>
        </header>
        <div className="mcp-prompt-body">
          {!chosen && (
            <>
              {!groups && <div className="d"><Loader2 size={14} className="spin" /> {t("mcpPromptLoading")}</div>}
              {groups && !withPrompts.length && <div className="d">{t("mcpPromptNone")}</div>}
              {withPrompts.map((g) => (
                <div key={g.server.id} role="group" aria-label={g.server.name}>
                  <div className="mcp-label">{g.server.name}</div>
                  {g.prompts.map((p) => (
                    <button key={p.name} className="menu-item mcp-prompt-item" onClick={() => (setChosen({ server: g.server, prompt: p }), setValues({}), setMissing([]), setError(""))}>
                      <span className="t">{p.title || p.name}</span>
                      {p.description && <span className="d mcp-desc">{p.description}</span>}
                    </button>
                  ))}
                </div>
              ))}
              {failed.map((g) => <div key={g.server.id} className="d warn">{g.server.name}: {g.error}</div>)}
            </>
          )}
          {chosen && (
            <>
              {chosen.prompt.description && <div className="d">{chosen.prompt.description}</div>}
              {!chosen.prompt.arguments.length && <div className="d">{t("mcpPromptNoArgs")}</div>}
              {chosen.prompt.arguments.map((a, i) => (
                <label key={a.name} className="field">
                  <span>{a.name}{a.required ? ` (${t("mcpPromptRequired")})` : ""}</span>
                  <input
                    className="input mono"
                    data-autofocus={i === 0 ? "" : undefined}
                    aria-required={a.required}
                    aria-invalid={missing.includes(a.name)}
                    placeholder={a.description}
                    value={values[a.name] ?? ""}
                    onChange={(e) => setValues({ ...values, [a.name]: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && (e.preventDefault(), insert())}
                  />
                </label>
              ))}
              {missing.length > 0 && <div className="error-box" role="alert">{t("mcpPromptMissing", { names: missing.join(", ") })}</div>}
              {error && <div className="error-box" role="alert">{error}</div>}
              <div className="dialog-foot">
                <button className="btn btn-ghost" onClick={() => setChosen(null)} disabled={busy}>{t("mcpPromptBack")}</button>
                <button className="btn btn-primary" onClick={insert} disabled={busy}>{busy ? <Loader2 size={13} className="spin" /> : null} {t("mcpPromptInsert")}</button>
              </div>
            </>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
