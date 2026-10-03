import { VoiceInput } from "../VoiceInput";
import { ArrowUp, AtSign, Bot, MessageCircle, ListTodo, Brain, ChevronDown, ImagePlus, Lock, Monitor, Plug, Plus, ShieldCheck, Square, Unlock, X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Access } from "../../agent/agent";
import { loadMcpConfig, onMcpConfigChange } from "../../agent/mcp/runtime";
import { useT } from "../../i18n";
import { computer } from "../../lib/api";
import { McpPromptDialog } from "../McpPromptDialog";
import { pickAccount } from "../../providers/cursorAccounts";
import { useCursorPool } from "../../providers/cursorPoolStore";
import type { ModelInfo, ProviderConfig } from "../../providers/types";
import { useApp } from "../../state";
import { useMenu } from "../Menu";
import { ModelIcon } from "../ModelIcon";
import { ModelPicker } from "../ModelPicker";
import { useInstructionReport } from "../../lib/useInstructionReport";
import { ContextChip } from "./ContextChip";
import { loadSkills, type Skill } from "../../agent/skills";
import { mergeSkills } from "../../agent/skillsCore";
import type { ChatMode } from "../../agent/planCore";

const ACCESS_ICON: Record<Access, typeof Lock> = { readonly: Lock, auto: ShieldCheck, full: Unlock };

type Props = {
  scopeKey?: string;
  text: string;
  setText: (s: string) => void;
  images: string[];
  setImages: (f: (xs: string[]) => string[]) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  visible: boolean;
  /** Project root (enables @file mentions) and name (placeholder). */
  root: string | null;
  projectName: string | undefined;
  files: string[];
  provider: ProviderConfig | undefined;
  selectedModel: ModelInfo | undefined;
  modelName: string | undefined;
  supports: { computer: boolean; reasoning: boolean };
  running: boolean;
  mode: ChatMode;
  onModeChange: (m: ChatMode) => void;
  onSend: () => void;
  onStop: () => void;
  contextTokens: number;
  lastInput: number | undefined;
  canCompact: boolean;
  canRestore: boolean;
  onCompact: () => void;
  onRestore: () => void;
};

/** Message composer: attachments, @file mention list, textarea and the bar with access / model / context controls. */
export function Composer(p: Props) {
  const t = useT();
  const app = useApp();
  const menu = useMenu();
  const addMenu = useMenu();
  const { text, setText, images, setImages, taRef, root, selectedModel } = p;
  const instructions = useInstructionReport(root, p.provider);
  // Cursor account rotation: which account the next message will use (only when the selected one is in the pool).
  const pool = useCursorPool();
  const pick = p.provider && pool.ids.length > 1 && pool.ids.includes(p.provider.id) ? pickAccount(pool, app.providers, Date.now()) : undefined;
  const accountTitle = pick?.ok ? t("cursorActiveAccount", { name: app.providers.find(x => x.id === pick.id)?.name ?? "" }) : undefined;
  const [picker, setPicker] = useState(false);
  // MCP prompts: a user-invoked template picker, offered only when some MCP server is configured.
  const [promptDialog, setPromptDialog] = useState(false);
  const [hasMcp, setHasMcp] = useState(false);
  useEffect(() => {
    const load = () => loadMcpConfig().then((c) => setHasMcp(c.servers.some((s) => s.enabled)), () => {});
    load();
    return onMcpConfigChange(load);
  }, []);
  const [mention, setMention] = useState<{ q: string; hl: number } | null>(null);
  const [attachmentError,setAttachmentError]=useState("");
  const [capturing,setCapturing]=useState(false);
  const currentScope=useRef(p.scopeKey); currentScope.current=p.scopeKey;
  const fileInput = useRef<HTMLInputElement>(null);
  const [skills, setSkills] = useState<Skill[]>(() => mergeSkills([]));
  const [slash, setSlash] = useState<{ q: string; hl: number } | null>(null);
  const [skillError, setSkillError] = useState(false);
  useEffect(() => {
    let stale = false;
    loadSkills(root, true).then(xs => { if (!stale) { setSkills(xs); setSkillError(false); } }, () => { if (!stale) { setSkills(mergeSkills([])); setSkillError(true); } });
    return () => { stale = true; };
  }, [root, !!slash]);
  const slashList = slash ? skills.filter(s => s.name.includes(slash.q.toLowerCase())).slice(0, 12) : [];
  const insertSkill = (skill: Skill) => {
    setText(`/${skill.name} `);
    setSlash(null);
    taRef.current?.focus();
  };

  useEffect(() => {
    const ta = taRef.current!;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [text]);
  useEffect(() => { if (p.visible) taRef.current?.focus(); else { setPicker(false); setMention(null); setSlash(null); } }, [p.visible]);

  const mentionList = mention ? p.files.filter((f) => f.toLowerCase().includes(mention.q.toLowerCase())).slice(0, 12) : [];
  const insertMention = (path: string) => {
    setText(text.replace(/@([\w./-]*)$/, `@${path} `));
    setMention(null);
    taRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (slash && slashList.length) {
      if (e.key === "ArrowDown") return e.preventDefault(), setSlash({ ...slash, hl: Math.min(slash.hl + 1, slashList.length - 1) });
      if (e.key === "ArrowUp") return e.preventDefault(), setSlash({ ...slash, hl: Math.max(slash.hl - 1, 0) });
      if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), insertSkill(slashList[Math.min(slash.hl, slashList.length - 1)]);
      if (e.key === "Escape") return e.preventDefault(), setSlash(null);
    }
    if (mention && mentionList.length) {
      if (e.key === "ArrowDown") return e.preventDefault(), setMention({ ...mention, hl: Math.min(mention.hl + 1, mentionList.length - 1) });
      if (e.key === "ArrowUp") return e.preventDefault(), setMention({ ...mention, hl: Math.max(mention.hl - 1, 0) });
      if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), insertMention(mentionList[mention.hl]);
      if (e.key === "Escape") return setMention(null);
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      p.onSend();
    }
  };

  const addImageFiles = (list: FileList | File[]) => {
    const scope=p.scopeKey;
    if(selectedModel?.images===false){setAttachmentError(t("imageUnsupported"));return;}
    for(const file of Array.from(list).filter(f=>f.type.startsWith("image/")).slice(0,8)){
      if(file.size>10*1024*1024){setAttachmentError(t("imageTooLarge"));continue;}
      const reader=new FileReader();
      reader.onerror=()=>setAttachmentError(t("imageReadError"));
      reader.onload=()=>{
        if(scope!==currentScope.current)return;
        if(file.type==="image/png")setImages(xs=>[...xs,String(reader.result).split(",")[1]].slice(0,8));
        else {
          const image=new Image();image.onerror=()=>setAttachmentError(t("imageReadError"));image.onload=()=>{
            if(scope!==currentScope.current)return;
            const canvas=document.createElement("canvas");const scale=Math.min(1,4096/Math.max(image.naturalWidth,image.naturalHeight));canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
            const ctx=canvas.getContext("2d");if(!ctx){setAttachmentError(t("imageReadError"));return;}ctx.drawImage(image,0,0,canvas.width,canvas.height);setImages(xs=>[...xs,canvas.toDataURL("image/png").split(",")[1]].slice(0,8));
          };image.src=String(reader.result);
        }
      };reader.readAsDataURL(file);
    }
  };
  const screenshot=async()=>{const scope=p.scopeKey;setCapturing(true);setAttachmentError("");try{const shot=await computer.execute([]);if(scope===currentScope.current){if(!shot.png)throw Error(t("imageReadError"));setImages(xs=>[...xs,shot.png].slice(0,8));}}catch(e){if(scope===currentScope.current)setAttachmentError(String(e));}finally{setCapturing(false);}};


  const toggleComputer = async () => {
    if (app.computerUse) return app.setComputerUse(false);
    const perms = await computer.permissions(false);
    if (!perms.accessibility || !perms.screen) return app.openSettings("computer");
    app.setComputerUse(true);
  };

  const AccessIcon = ACCESS_ICON[app.access];
  const accessLabel = { readonly: t("accessReadonly"), auto: t("accessAuto"), full: t("accessFull") }[app.access];

  return (
    <>
      <div className="composer-wrap">
        <div
          className="composer"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => (e.preventDefault(), addImageFiles(e.dataTransfer.files))}
        >
          {attachmentError && <div className="error-box" role="alert">{attachmentError}<button className="btn-ghost" onClick={()=>setAttachmentError("")}>{t("cancel")}</button></div>}
          {slash && slashList.length > 0 && (
            <div className="menu mention-list skill-list" id="skill-list" role="listbox" aria-label={app.locale === "ru" ? "Команды и навыки" : "Commands and skills"} style={{ position: "absolute" }}>
              {skillError && <div className="menu-heading">{app.locale === "ru" ? "Не удалось прочитать навыки; доступны встроенные команды" : "Skills could not be read; built-in commands are available"}</div>}
              {slashList.map((s, i) => (
                <button key={s.id} id={`skill-opt-${i}`} role="option" aria-selected={i === slash.hl} tabIndex={-1} className={`menu-item${i === slash.hl ? " hl" : ""}`} onMouseDown={e => { e.preventDefault(); insertSkill(s); }}>
                  <span className="skill-option-content"><span className="skill-option-name">/{s.name}</span><span className="skill-option-description" title={s.description}>{s.description}</span><span className="skill-option-source">{s.source}</span></span>
                </button>
              ))}
            </div>
          )}
          {mention && mentionList.length > 0 && (
            <div className="menu mention-list" id="mention-list" role="listbox" aria-label={t("mentionFile")} style={{ position: "absolute" }}>
              {mentionList.map((f, i) => (
                <button key={f} id={`mention-opt-${i}`} role="option" aria-selected={i === mention.hl} tabIndex={-1} className={`menu-item${i === mention.hl ? " hl" : ""}`} onMouseDown={(e) => (e.preventDefault(), insertMention(f))}>
                  <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{f}</span>
                </button>
              ))}
            </div>
          )}
          {images.length > 0 && (
            <div className="attach-list">
              {images.map((d, i) => (
                <div key={i} className="attach">
                  <img src={`data:image/png;base64,${d}`} alt="" />
                  <button title={t("removeAttachment")} aria-label={t("removeAttachment")} onClick={() => setImages((xs) => xs.filter((_, j) => j !== i))}>
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            aria-label={t("askAnything")}
            aria-haspopup="listbox"
            aria-controls={slash && slashList.length ? "skill-list" : mention && mentionList.length ? "mention-list" : undefined}
            aria-activedescendant={slash && slashList.length ? `skill-opt-${Math.min(slash.hl, slashList.length - 1)}` : mention && mentionList.length ? `mention-opt-${mention.hl}` : undefined}
            rows={1}
            value={text}
            placeholder={p.projectName ? t("askProject") : t("askAnything")}
            onChange={(e) => {
              setText(e.target.value);
              const cmd = /^\/([a-zA-Z0-9_-]*)$/.exec(e.target.value);
              setSlash(cmd ? { q: cmd[1], hl: 0 } : null);
              const m = /@([\w./-]*)$/.exec(e.target.value.slice(0, e.target.selectionStart));
              setMention(m && root ? { q: m[1], hl: 0 } : null);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => setSlash(null)}
            onPaste={e => {
              const files = Array.from(e.clipboardData.items ?? []).filter(item => item.kind === "file" && item.type.startsWith("image/")).map(item => item.getAsFile()).filter((file): file is File => !!file);
              const images = files.length ? files : Array.from(e.clipboardData.files).filter(file => file.type.startsWith("image/"));
              if (images.length) { e.preventDefault(); addImageFiles(images); }
            }}
          />
          <div className="composer-bar">
            <button
              className={`icon-btn composer-add${addMenu.isOpen ? " on" : ""}`}
              aria-expanded={addMenu.isOpen}
              onKeyDown={addMenu.onTriggerKeyDown}
              title={t("attach")}
              aria-label={t("attach")}
              aria-haspopup="menu"
              onClick={(e) =>
                addMenu.open(e.currentTarget.getBoundingClientRect(), [
                  { heading: t("attach") },
                  ...(selectedModel?.images !== false ? [{label: capturing ? t("capturingScreenshot") : t("takeScreenshot"), icon:<Monitor size={15}/>,onClick:()=>{if(!capturing)void screenshot();}}] : []),
                  ...(selectedModel?.images !== false ? [{ label: t("attachImage"), icon: <ImagePlus size={15} />, onClick: () => fileInput.current?.click() }] : []),
                  ...(root ? [{ label: t("mentionFile"), icon: <AtSign size={15} />, onClick: () => (setText(text + (text && !text.endsWith(" ") ? " @" : "@")), setMention({ q: "", hl: 0 }), taRef.current?.focus()) }] : []),
                  ...(hasMcp ? [{ label: t("mcpPromptAttach"), icon: <Plug size={18} />, onClick: () => setPromptDialog(true) }] : []),
                  { sep: true },
                  { heading: t("modeSwitch") },
                  ...(["ask", "plan", "agent"] as const).map(m => ({
                    label: t(m === "ask" ? "modeAsk" : m === "plan" ? "modePlan" : "modeAgent"),
                    description: t(m === "ask" ? "modeAskHint" : m === "plan" ? "modePlanHint" : "modeAgentHint"),
                    icon: m === "ask" ? <MessageCircle size={18} /> : m === "plan" ? <ListTodo size={18} /> : <Bot size={18} />,
                    checked: p.mode === m, onClick: () => p.onModeChange(m),
                  })),
                ], { wide: true })
              }
            >
              <Plus size={16} />
            </button>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => (e.target.files && addImageFiles(e.target.files), (e.target.value = ""))} />
            <span className="composer-mode" title={t("modeSwitch")}>{t(p.mode === "ask" ? "modeAsk" : p.mode === "plan" ? "modePlan" : "modeAgent")}</span>
            <button
              className="chip"
              aria-haspopup="menu"
              onClick={(e) =>
                menu.open(e.currentTarget.getBoundingClientRect(), [
                  { label: t("accessReadonly"), icon: <Lock size={15} />, kbd: app.access === "readonly" ? "✓" : "", onClick: () => app.setAccess("readonly") },
                  { label: t("accessAuto"), icon: <ShieldCheck size={15} />, kbd: app.access === "auto" ? "✓" : "", onClick: () => app.setAccess("auto") },
                  { label: t("accessFull"), icon: <Unlock size={15} />, kbd: app.access === "full" ? "✓" : "", onClick: () => app.setAccess("full") },
                ])
              }
              title={root && app.access !== "readonly" ? `${t("accessMode")} · ${t("reviewMode")}` : t("accessMode")}
            >
              <AccessIcon size={14} /> {accessLabel}
            </button>
            {p.supports.computer && (
              <button className={`chip${app.computerUse ? " on" : ""}`} aria-pressed={app.computerUse} onClick={toggleComputer} title={t("computerUseHint")}>
                <Monitor size={14} /> {t("computerUse")}
              </button>
            )}
            <span className="grow" />
            <ContextChip
              model={selectedModel}
              tokens={p.contextTokens}
              lastInput={p.lastInput}
              busy={p.running}
              canCompact={p.canCompact}
              canRestore={p.canRestore}
              onCompact={p.onCompact}
              onRestore={p.onRestore}
              instructions={instructions.report}
              onOpen={instructions.reload}
            />
            <div style={{ position: "relative" }}>
              <button className="chip" title={accountTitle} aria-haspopup="dialog" aria-expanded={picker} onClick={() => (app.providers.length ? setPicker(!picker) : app.openSettings("providers"))}>
                {p.provider && <ModelIcon model={app.selection?.model ?? ""} provider={p.provider} size={15} />}
                {p.modelName ?? t("chooseModel")} <ChevronDown size={13} />
              </button>
              {picker && <ModelPicker onClose={() => setPicker(false)} />}
            </div>
            {p.supports.reasoning && (
              <button
                className="chip"
                aria-haspopup="menu"
                onClick={(e) =>
                  menu.open(e.currentTarget.getBoundingClientRect(), (["low", "medium", "high"] as const).map((r) => ({ label: t(`reasoning_${r}`), kbd: app.reasoning === r ? "✓" : "", onClick: () => app.setReasoning(r) })))
                }
              >
                <Brain size={14} /> {t(`reasoning_${app.reasoning}`)}
              </button>
            )}
            <VoiceInput key={p.scopeKey ?? root ?? "global"} disabled={p.running || !p.visible} onText={value => setText((taRef.current?.value || "") + ((taRef.current?.value || "").trim() ? " " : "") + value)} />
            {p.running ? (
              <button className="send" onClick={p.onStop} title={t("stop")} aria-label={t("stop")}>
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button className="send" disabled={!text.trim() && !images.length} onClick={p.onSend} title={t("send")} aria-label={t("send")}>
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      {menu.node}
      {addMenu.node}
      {promptDialog && (
        <McpPromptDialog
          project={root ?? null}
          onClose={() => (setPromptDialog(false), taRef.current?.focus())}
          onInsert={(rendered) => (setText(text.trim() ? `${text.replace(/\s+$/, "")}\n\n${rendered}` : rendered), setPromptDialog(false), taRef.current?.focus())}
        />
      )}
    </>
  );
}
