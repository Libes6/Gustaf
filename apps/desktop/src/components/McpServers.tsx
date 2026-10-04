import { Plug, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { blankServer, parseImport, validateServer, type ErrorCode, type HttpTransport, type ImportError, type KV, type McpServer } from "../agent/mcp/config";
import { disconnectMcpServer, isMcpSignedIn, listMcpTools, loadMcpConfig, mcpCapabilities, onMcpConfigChange, patchMcpServer, removeMcpServer, saveMcpServer, signInMcpServer, signOutMcpServer, testMcpServer } from "../agent/mcp/runtime";
import type { Phase } from "../agent/mcp/oauthFlow";
import { RESOURCE_TOOLS } from "../agent/mcp/resources";
import type { McpTool } from "../agent/mcp/toolset";
import { useT, type Key } from "../i18n";
import { fsx, mcpStdio, type McpStatus } from "../lib/api";
import { keyStoreKey } from "../lib/platform";
import { useApp } from "../state";
import "../styles/mcp.css";

const newId = () => `mcp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const errKey = (code: ErrorCode) => `mcpErr_${code}` as Key;
const message = (e: unknown) => String((e as Error)?.message ?? e);
type Info = { tools?: McpTool[]; error?: string; busy?: boolean; ok?: boolean };
type Auth = { signedIn?: boolean; phase?: Phase; error?: string };

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-label={label} aria-checked={on} className={`toggle${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}

/** Settings page: MCP servers whose tools API-provider agents may use (src/agent/mcp). */
export function McpServers() {
  const t = useT();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [status, setStatus] = useState<Record<string, McpStatus>>({});
  const [info, setInfo] = useState<Record<string, Info>>({});
  const [editing, setEditing] = useState<{ draft: McpServer; isNew: boolean } | null>(null);
  const [open, setOpen] = useState<Record<string, "tools" | "log" | undefined>>({});
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [importText, setImportText] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [auth, setAuth] = useState<Record<string, Auth>>({});
  const signing = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const load = () =>
      loadMcpConfig().then(async (c) => {
        setServers(c.servers);
        const entries = await Promise.all(c.servers.filter((s) => s.transport === "http" && s.oauth).map(async (s) => [s.id, await isMcpSignedIn(s).catch(() => false)] as const));
        setAuth((m) => ({ ...m, ...Object.fromEntries(entries.map(([id, signedIn]) => [id, { ...m[id], signedIn }])) }));
      });
    load();
    const off = onMcpConfigChange(load);
    const poll = () => mcpStdio.status().then((list) => setStatus(Object.fromEntries(list.map((s) => [s.id, s])))).catch(() => {});
    poll();
    const timer = setInterval(poll, 2000);
    return () => (off(), clearInterval(timer), signing.current.forEach((c) => c.abort()));
  }, []);

  const patchAuth = (id: string, p: Auth) => setAuth((m) => ({ ...m, [id]: { ...m[id], ...p } }));
  const signIn = async (s: McpServer) => {
    const ctl = new AbortController();
    signing.current.set(s.id, ctl);
    patchAuth(s.id, { phase: "discovering", error: undefined });
    try {
      await signInMcpServer(s, { signal: ctl.signal, onPhase: (phase) => patchAuth(s.id, { phase }) });
      patchAuth(s.id, { signedIn: true, phase: undefined });
      patchInfo(s.id, { error: undefined, ok: undefined, tools: undefined });
    } catch (e) {
      patchAuth(s.id, { phase: undefined, ...(ctl.signal.aborted ? {} : { error: message(e) }) });
    } finally {
      signing.current.delete(s.id);
    }
  };
  const signOut = async (s: McpServer) => {
    await signOutMcpServer(s).catch(() => {});
    patchAuth(s.id, { signedIn: false, error: undefined });
    patchInfo(s.id, { ok: undefined, tools: undefined });
  };

  const patchInfo = (id: string, p: Info) => setInfo((m) => ({ ...m, [id]: { ...m[id], ...p } }));
  const test = async (s: McpServer) => {
    patchInfo(s.id, { busy: true, error: undefined, ok: undefined });
    try {
      const r = await testMcpServer(s);
      patchInfo(s.id, { busy: false, tools: r.tools, ok: true });
    } catch (e) {
      patchInfo(s.id, { busy: false, error: message(e), ok: false });
    }
  };
  const toggleOpen = async (s: McpServer, what: "tools" | "log") => {
    const next = open[s.id] === what ? undefined : what;
    setOpen((m) => ({ ...m, [s.id]: next }));
    if (next === "log") setLogs({ ...logs, [s.id]: await mcpStdio.logs(s.id).catch(() => []) });
    if (next === "tools" && !info[s.id]?.tools) {
      patchInfo(s.id, { busy: true });
      listMcpTools(s).then((tools) => patchInfo(s.id, { busy: false, tools, error: undefined }), (e) => patchInfo(s.id, { busy: false, error: message(e) }));
    }
  };
  const statusText = (s: McpServer) => {
    const st = status[s.id];
    const i = info[s.id];
    const count = i?.tools ? ` · ${t("mcpToolCount", { count: i.tools.length })}` : "";
    if (i?.busy) return { text: t("mcpStatus_starting"), color: "var(--text-3)" };
    if (s.transport === "stdio" && st) {
      const color = st.state === "running" ? "var(--green)" : st.state === "error" ? "var(--red)" : "var(--warn)";
      return { text: t(`mcpStatus_${st.state}` as Key) + count, color, error: st.state === "error" ? st.error ?? undefined : i?.error };
    }
    if (i?.error) return { text: t("mcpStatus_error"), color: "var(--red)", error: i.error };
    if (i?.ok) return { text: t("mcpStatus_connected") + count, color: "var(--green)" };
    return { text: t("mcpStatus_stopped"), color: "var(--text-3)" };
  };

  return (
    <>
      <h1>{t("mcpTitle")}</h1>
      <p className="lead">{t("mcpLead")}</p>
      <div className="mcp-actions">
        <button className="btn-soft" onClick={() => setEditing({ draft: blankServer(newId(), "stdio"), isNew: true })}><Plus size={13} /> {t("mcpAddStdio")}</button>
        <button className="btn-soft" onClick={() => setEditing({ draft: blankServer(newId(), "http"), isNew: true })}><Plus size={13} /> {t("mcpAddHttp")}</button>
        <button className="btn-soft" onClick={() => setImportText(importText === null ? "" : null)}>{t("mcpImport")}</button>
      </div>
      {importText !== null && <ImportBox text={importText} setText={setImportText} existing={servers} />}
      {editing && (
        <Editor
          key={editing.draft.id}
          initial={editing.draft}
          isNew={editing.isNew}
          others={servers}
          onCancel={() => setEditing(null)}
          onSaved={(s) => {
            setEditing(null);
            setInfo((m) => ({ ...m, [s.id]: {} }));
          }}
        />
      )}
      <div className="card">
        {!servers.length && <div className="card-row d">{t("mcpNone")}</div>}
        {servers.map((s) => {
          const st = statusText(s);
          return (
            <div key={s.id} className="mcp-server">
              <div className="card-row">
                <span className="prov-icon"><Plug size={14} /></span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="t">
                    {s.name} <span className="d">{s.transport === "stdio" ? "stdio" : "HTTP"}{s.scope === "project" ? ` · ${s.project?.split("/").pop()}` : ""}</span>
                  </div>
                  <div className="d mcp-cmd">{s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url}</div>
                  <div className="d"><span className="status-dot" style={{ background: st.color }} />{st.text}</div>
                  {st.error && <div className="d mcp-error">{st.error}</div>}
                  {s.transport === "http" && s.oauth && (
                    <div className="d mcp-signin">
                      <span>{auth[s.id]?.phase ? t(`mcpOauthPhase_${auth[s.id].phase}` as Key) : auth[s.id]?.signedIn ? t("mcpSignedIn") : t("mcpSignedOut")}</span>
                      {auth[s.id]?.phase ? (
                        <button className="btn-soft" onClick={() => signing.current.get(s.id)?.abort()}>{t("cancel")}</button>
                      ) : auth[s.id]?.signedIn ? (
                        <button className="btn-soft" onClick={() => signOut(s)}>{t("mcpSignOut")}</button>
                      ) : null}
                      {!auth[s.id]?.phase && <button className="btn-soft" onClick={() => signIn(s)}>{auth[s.id]?.signedIn ? t("mcpSignInAgain") : t("mcpSignIn")}</button>}
                      {auth[s.id]?.error && <span className="mcp-error">{auth[s.id].error}</span>}
                    </div>
                  )}
                </div>
                <Switch label={t("mcpEnabled")} on={s.enabled} onChange={(v) => patchMcpServer(s.id, { enabled: v })} />
              </div>
              <div className="card-row mcp-buttons">
                <button className="btn-soft" disabled={info[s.id]?.busy} onClick={() => test(s)}>{t("mcpTest")}</button>
                <button className="btn-soft" onClick={() => toggleOpen(s, "tools")}>{t("mcpTools")}</button>
                {s.transport === "stdio" && <button className="btn-soft" onClick={() => toggleOpen(s, "log")}>{t("mcpLog")}</button>}
                <button className="btn-soft" onClick={() => setEditing({ draft: s, isNew: false })}>{t("edit")}</button>
                {s.transport === "stdio" && status[s.id] && status[s.id].state !== "stopped" && (
                  <button className="btn-soft" onClick={() => disconnectMcpServer(s.id)}>{t("mcpStop")}</button>
                )}
                <span className="grow" />
                {confirm === s.id ? (
                  <button className="btn-soft btn-danger" onClick={() => (setConfirm(null), removeMcpServer(s.id))}>{t("mcpRemoveConfirm")}</button>
                ) : (
                  <button className="btn-soft btn-danger" aria-label={t("delete")} onClick={() => setConfirm(s.id)}><Trash2 size={13} /></button>
                )}
              </div>
              {open[s.id] === "tools" && <ToolsPanel server={s} tools={info[s.id]?.tools} busy={!!info[s.id]?.busy} resources={!!(mcpCapabilities(s.id)?.resources)} />}
              {open[s.id] === "log" && (
                <div className="card-row mcp-panel">
                  <pre className="mcp-log">{logs[s.id]?.length ? logs[s.id].join("\n") : t("mcpLogEmpty")}</pre>
                  <button className="btn-soft" onClick={async () => setLogs({ ...logs, [s.id]: await mcpStdio.logs(s.id).catch(() => []) })}>{t("mcpRefresh")}</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="hint" style={{ padding: 0 }}>{t("mcpCliNote")}</p>
    </>
  );
}

function ToolsPanel({ server: s, tools: listed, busy, resources }: { server: McpServer; tools?: McpTool[]; busy: boolean; resources: boolean }) {
  const t = useT();
  // Servers that offer resources also get two built-in agent tools; they follow the same approval and read-only settings.
  const tools = listed && resources
    ? [...listed, { name: RESOURCE_TOOLS.list, description: t("mcpResourceListDesc"), inputSchema: {} }, { name: RESOURCE_TOOLS.read, description: t("mcpResourceReadDesc"), inputSchema: {} }, { name: RESOURCE_TOOLS.templates, description: t("mcpResourceTemplatesDesc"), inputSchema: {} }]
    : listed;
  const flip = (list: string[], name: string, on: boolean) => (on ? [...new Set([...list, name])] : list.filter((x) => x !== name));
  return (
    <div className="card-row mcp-panel">
      <label className="mcp-check">
        <input type="checkbox" checked={s.alwaysAllow} onChange={(e) => patchMcpServer(s.id, { alwaysAllow: e.target.checked })} /> {t("mcpAlwaysAllowServer")}
      </label>
      <div className="d">{t("mcpReadOnlyHint")}</div>
      {busy && !tools && <div className="d">{t("mcpStatus_starting")}</div>}
      {tools && !tools.length && <div className="d">{t("mcpNoTools")}</div>}
      {tools?.map((tool) => (
        <div key={tool.name} className="mcp-tool">
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="t mono">{tool.name}{tool.readOnlyHint && <span className="d"> · {t("mcpServerHint")}</span>}{tool.destructiveHint && <span className="warn"> · {t("mcpDestructiveHint")}</span>}</div>
            {tool.description && <div className="d mcp-desc">{tool.description}</div>}
          </div>
          <label className="mcp-check">
            <input type="checkbox" checked={s.allowedTools.includes(tool.name)} onChange={(e) => patchMcpServer(s.id, { allowedTools: flip(s.allowedTools, tool.name, e.target.checked) })} /> {t("mcpAllowTool")}
          </label>
          <label className="mcp-check">
            <input type="checkbox" checked={s.readOnlyTools.includes(tool.name)} onChange={(e) => patchMcpServer(s.id, { readOnlyTools: flip(s.readOnlyTools, tool.name, e.target.checked) })} /> {t("mcpReadOnlyTool")}
          </label>
        </div>
      ))}
    </div>
  );
}

function KVRows({ rows, setRows, kind }: { rows: KV[]; setRows: (r: KV[]) => void; kind: "env" | "header" }) {
  const t = useT();
  const set = (i: number, p: Partial<KV>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="mcp-kv">
      {rows.map((r, i) => (
        <div key={i} className="mcp-kv-row">
          <input className="input mono" aria-label={t("name")} placeholder={kind === "env" ? "API_KEY" : "Authorization"} value={r.key} onChange={(e) => set(i, { key: e.target.value, ...(r.value === undefined ? { value: "" } : {}) })} />
          <input
            className="input mono"
            aria-label={t("mcpValue")}
            type={r.secret ? "password" : "text"}
            placeholder={r.secret && r.value === undefined ? t("mcpSecretKept") : t("mcpValue")}
            value={r.value ?? ""}
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <label className="mcp-check" title={t("mcpSecretHint", { store: t(keyStoreKey()) })}>
            <input type="checkbox" checked={r.secret} onChange={(e) => set(i, { secret: e.target.checked })} /> {t("mcpSecret")}
          </label>
          <button className="btn-soft" aria-label={t("delete")} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={12} /></button>
        </div>
      ))}
      <button className="btn-soft" onClick={() => setRows([...rows, { key: "", value: "", secret: kind === "header" }])}><Plus size={12} /> {t("add")}</button>
    </div>
  );
}

function Editor({ initial, isNew, others, onCancel, onSaved }: { initial: McpServer; isNew: boolean; others: McpServer[]; onCancel: () => void; onSaved: (s: McpServer) => void }) {
  const t = useT();
  const app = useApp();
  const projects = app.projects.filter((p) => p.path);
  const [s, setS] = useState<McpServer>(initial);
  const [argsText, setArgsText] = useState(initial.transport === "stdio" ? initial.args.join("\n") : "");
  const [errors, setErrors] = useState<ErrorCode[]>([]);
  const [failure, setFailure] = useState("");
  const set = (p: Partial<McpServer>) => setS((x) => ({ ...x, ...p }) as McpServer);

  const build = (): McpServer => {
    const clean = (rows: KV[]) => rows.filter((r) => r.key.trim()).map((r) => ({ ...r, key: r.key.trim() }));
    const base = { ...s, name: s.name.trim(), ...(s.scope === "project" ? {} : { project: undefined }) };
    if (base.transport === "stdio") return { ...base, command: base.command.trim(), args: argsText.split("\n").map((a) => a.trim()).filter(Boolean), env: clean(base.env), ...(base.cwd?.trim() ? { cwd: base.cwd.trim() } : { cwd: undefined }) };
    return { ...base, url: base.url.trim(), headers: clean(base.headers) };
  };
  const save = async () => {
    // Policy toggled in the tools panel while this form was open must not be overwritten by the form's old copy.
    const latest = others.find((o) => o.id === s.id);
    const next = { ...build(), ...(latest ? { enabled: latest.enabled, alwaysAllow: latest.alwaysAllow, allowedTools: latest.allowedTools, readOnlyTools: latest.readOnlyTools } : {}) } as McpServer;
    const problems = validateServer(next, others);
    setErrors(problems);
    if (problems.length) return;
    try {
      await saveMcpServer(next);
      onSaved(next);
    } catch (e) {
      setFailure(message(e));
    }
  };

  return (
    <div className="card mcp-editor">
      <div className="card-row" style={{ display: "block" }}>
        <h4 style={{ marginTop: 0 }}>{isNew ? (s.transport === "stdio" ? t("mcpAddStdio") : t("mcpAddHttp")) : t("edit")}</h4>
        <label className="field">
          <span>{t("name")}</span>
          <input className="input" value={s.name} placeholder="github" onChange={(e) => set({ name: e.target.value })} />
        </label>
        {s.transport === "stdio" ? (
          <>
            <label className="field">
              <span>{t("mcpCommand")}</span>
              <input className="input mono" value={s.command} placeholder="npx" onChange={(e) => set({ command: e.target.value })} />
            </label>
            <label className="field">
              <span>{t("mcpArgs")}</span>
              <textarea className="input mono" rows={3} value={argsText} placeholder={"-y\n@modelcontextprotocol/server-github"} onChange={(e) => setArgsText(e.target.value)} />
            </label>
            <div className="field"><span className="mcp-label">{t("mcpEnv")}</span><KVRows kind="env" rows={s.env} setRows={(env) => set({ env })} /></div>
            <label className="field">
              <span>{t("mcpCwd")}</span>
              <input className="input mono" value={s.cwd ?? ""} placeholder="/Users/me/project" onChange={(e) => set({ cwd: e.target.value })} />
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span>{t("mcpUrl")}</span>
              <input className="input mono" value={s.url} placeholder="https://example.com/mcp" onChange={(e) => set({ url: e.target.value })} />
            </label>
            <label className="field">
              <span>{t("mcpTransport")}</span>
              <select className="input" aria-label={t("mcpTransport")} value={s.httpTransport ?? "auto"} onChange={(e) => set({ httpTransport: e.target.value === "auto" ? undefined : (e.target.value as HttpTransport) } as Partial<McpServer>)}>
                <option value="auto">{t("mcpTransportAuto")}</option>
                <option value="streamable">{t("mcpTransportStreamable")}</option>
                <option value="sse">{t("mcpTransportSse")}</option>
              </select>
              <span className="d">{t("mcpTransportHint")}</span>
            </label>
            <div className="field"><span className="mcp-label">{t("mcpHeaders")}</span><KVRows kind="header" rows={s.headers} setRows={(headers) => set({ headers })} /></div>
            <label className="mcp-check">
              <input type="checkbox" checked={!!s.oauth} onChange={(e) => set({ oauth: e.target.checked ? {} : undefined } as Partial<McpServer>)} /> {t("mcpOauth")}
            </label>
            {s.oauth && (
              <>
                <div className="d" style={{ margin: "4px 0 8px" }}>{t("mcpOauthHint", { store: t(keyStoreKey()) })}</div>
                <div className="d" style={{ margin: "0 0 8px" }}>{t("mcpRevokeNote", { store: t(keyStoreKey()) })}</div>
                <label className="field">
                  <span>{t("mcpOauthClientId")}</span>
                  <input className="input mono" value={s.oauth.clientId ?? ""} onChange={(e) => set({ oauth: { ...s.oauth, clientId: e.target.value || undefined } } as Partial<McpServer>)} />
                </label>
                <label className="field">
                  <span>{t("mcpOauthScope")}</span>
                  <input className="input mono" value={s.oauth.scope ?? ""} onChange={(e) => set({ oauth: { ...s.oauth, scope: e.target.value || undefined } } as Partial<McpServer>)} />
                </label>
              </>
            )}
          </>
        )}
        <label className="field">
          <span>{t("mcpScope")}</span>
          <select className="input" value={s.scope === "project" ? s.project ?? "" : ""} onChange={(e) => set(e.target.value ? { scope: "project", project: e.target.value } : { scope: "global", project: undefined })}>
            <option value="">{t("mcpScopeGlobal")}</option>
            {projects.map((p) => <option key={p.id} value={p.path!}>{p.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>{t("mcpTimeout")}</span>
          <input className="input" type="number" min={1} max={600} value={Math.round((s.timeoutMs ?? 60_000) / 1000)} onChange={(e) => set({ timeoutMs: Math.min(600, Math.max(1, Number(e.target.value) || 60)) * 1000 })} />
        </label>
        {errors.map((c) => <div key={c} className="error-box">{t(errKey(c))}</div>)}
        {failure && <div className="error-box">{failure}</div>}
        <div className="dialog-foot">
          <button className="btn btn-ghost" onClick={onCancel}>{t("cancel")}</button>
          <button className="btn btn-primary" onClick={save}>{t("save")}</button>
        </div>
      </div>
    </div>
  );
}

function ImportBox({ text, setText, existing }: { text: string; setText: (v: string | null) => void; existing: McpServer[] }) {
  const t = useT();
  const parsed = useMemo(() => (text.trim() ? parseImport(text, existing, newId) : null), [text, existing]);
  const [failure, setFailure] = useState("");
  const add = async () => {
    try {
      for (const s of parsed?.servers ?? []) await saveMcpServer(s);
      setText(null);
    } catch (e) {
      setFailure(message(e));
    }
  };
  const fromCursor = async () => setText((await fsx.homeFile(".cursor/mcp.json").catch(() => null)) ?? "");
  const errText = (e: ImportError) => (e.name ? `${e.name}: ` : "") + t(errKey(e.code));
  return (
    <div className="card mcp-editor">
      <div className="card-row" style={{ display: "block" }}>
        <div className="d" style={{ marginBottom: 8 }}>{t("mcpImportHint", { store: t(keyStoreKey()) })}</div>
        <textarea className="input mono" aria-label={t("mcpImport")} rows={8} value={text} placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'} onChange={(e) => setText(e.target.value)} />
        {parsed?.servers.length ? <div className="d" style={{ marginTop: 6 }}>{t("mcpImportFound", { names: parsed.servers.map((s) => s.name).join(", ") })}</div> : null}
        {parsed?.errors.map((e, i) => <div key={i} className="d warn">{errText(e)}</div>)}
        {failure && <div className="error-box">{failure}</div>}
        <div className="dialog-foot">
          <button className="btn btn-ghost" onClick={fromCursor}>{t("mcpImportCursor")}</button>
          <span className="grow" />
          <button className="btn btn-ghost" onClick={() => setText(null)}>{t("cancel")}</button>
          <button className="btn btn-primary" disabled={!parsed?.servers.length} onClick={add}>{t("mcpImportAdd", { count: parsed?.servers.length ?? 0 })}</button>
        </div>
      </div>
    </div>
  );
}
