import { freezeChat, shortenChat, splitChatReferences, joinChatReferences, CHAT_REFERENCE_LIMIT, type ChatReference } from "../../lib/chatContext";
import { loadMessages, type Chat } from "../../lib/data";
import { VoiceInput } from "../VoiceInput";
import { ArrowUp, AtSign, Bot, MessageCircle, ListTodo, ChevronDown, GitBranch, ImagePlus, Lock, Monitor, Plug, Plus, ShieldCheck, Square, Unlock, X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Access } from "../../agent/agent";
import { loadMcpConfig, onMcpConfigChange } from "../../agent/mcp/runtime";
import { useT } from "../../i18n";
import { computer } from "../../lib/api";
import { McpPromptDialog } from "../McpPromptDialog";
import { pickAccount } from "../../providers/cursorAccounts";
import { useCursorPool } from "../../providers/cursorPoolStore";
import { DEFAULT_REASONING, REASONING_LEVELS, type ModelInfo, type ProviderConfig } from "../../providers/types";
import { useApp } from "../../state";
import { useMenu } from "../Menu";
import { ModelIcon } from "../ModelIcon";
import { ModelPicker } from "../ModelPicker";
import { OPEN_MODEL_PICKER_EVENT } from "../../agent/verificationCore";
import { useInstructionReport } from "../../lib/useInstructionReport";
import { ContextChip } from "./ContextChip";
import { EffortPicker } from "./EffortPicker";
import "../../styles/effort.css";
import { ImageThumb } from "../ImageViewer";
import "../../styles/workspaces.css";
import { loadSkills, type Skill } from "../../agent/skills";
import { mergeSkills } from "../../agent/skillsCore";
import type { ChatMode } from "../../agent/planCore";
import { knowledgeEntries, type KnowledgePick } from "./knowledgeMenu";

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
  /**
   * Git workspaces: `available` offers the "new workspace" toggle for the next message (a git project and a chat without
   * messages); `linkedBranch` marks a chat that already runs in a workspace. Absent or unavailable: nothing is shown.
   */
  /** Knowledge collections to toggle for this chat (a section of the plus menu). */
  knowledge?: KnowledgePick;
  workspace?: { available: boolean; on: boolean; onToggle: () => void; linkedBranch?: string };
};

/** Message composer: attachments, @file mention list, textarea and the bar with access / model / context controls. */
export function Composer(p: Props) {
  const t = useT();
  const app = useApp();
  const menu = useMenu();
  const addMenu = useMenu();
  const { text, setText, images, setImages, taRef, root, selectedModel } = p;
  const { body: composerBody, references } = splitChatReferences(text);
  const [pendingChat, setPendingChat] = useState<ChatReference | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const ru = app.locale === "ru";
  const attachChat = async (chat: Chat) => {
    const scope = currentScope.current;
    setChatLoading(true); setAttachmentError("");
    try {
      const ref = freezeChat(chat.id, chat.title, await loadMessages(chat.id));
      if (scope !== currentScope.current) return;
      setPendingChat(ref); setMention(null);
    } catch { setAttachmentError(ru ? "Не удалось прочитать чат" : "Could not read chat"); }
    finally { if (scope === currentScope.current) setChatLoading(false); }
  };
  const confirmChat = (ref: ChatReference) => {
    const latest = splitChatReferences(text);
    const next = joinChatReferences(latest.body.replace(/@([^\s@]*)$/, ""), [...latest.references.filter(r => r.sourceId !== ref.sourceId), ref]);
    if (next.length > 200_000) { setAttachmentError(ru ? "Снимок превышает лимит черновика (200 000 символов). Выберите сокращённую версию или удалите другое вложение." : "Snapshot exceeds draft limit (200,000 characters). Choose shortened version or remove another attachment."); return; }
    setText(next);
    setPendingChat(null); taRef.current?.focus();
  };
  const instructions = useInstructionReport(root, p.provider);
  // Cursor account rotation: which account the next message will use (only when the selected one is in the pool).
  const pool = useCursorPool();
  const pick = p.provider && pool.ids.length > 1 && pool.ids.includes(p.provider.id) ? pickAccount(pool, app.providers, Date.now()) : undefined;
  const accountTitle = pick?.ok ? t("cursorActiveAccount", { name: app.providers.find(x => x.id === pick.id)?.name ?? "" }) : undefined;
  const [picker, setPicker] = useState(false);
  const [effort, setEffort] = useState(false);
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
  useEffect(() => { setPendingChat(null); setChatLoading(false); }, [p.scopeKey]);
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
  useEffect(() => { if (p.visible) taRef.current?.focus(); else { setPicker(false); setEffort(false); setMention(null); setSlash(null); } }, [p.visible]);
  // The "Try another model" button of a verification card (docs/features/verification-gates.md) opens the picker; it never re-runs anything.
  useEffect(() => {
    if (!p.visible) return;
    const open = () => app.providers.length && setPicker(true);
    addEventListener(OPEN_MODEL_PICKER_EVENT, open);
    return () => removeEventListener(OPEN_MODEL_PICKER_EVENT, open);
  }, [p.visible, app.providers.length]);

  const mentionList = mention ? [
    ...p.files.filter(f => f.toLowerCase().includes(mention.q.toLowerCase())).slice(0, 6).map(path => ({ path, chat: undefined as Chat | undefined, label: path })),
    ...app.chats.filter(c => c.title.toLowerCase().includes(mention.q.toLowerCase())).slice(0, 6).map(chat => ({ path: "", chat, label: `💬 ${chat.title}` }))
  ].slice(0, 12) : [];
  const insertMention = (path: string) => {
    setText(joinChatReferences(composerBody.replace(/@([^\s@]*)$/, `@${path} `), references));
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
      if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), (mentionList[Math.min(mention.hl, mentionList.length - 1)].chat ? void attachChat(mentionList[Math.min(mention.hl, mentionList.length - 1)].chat!) : insertMention(mentionList[Math.min(mention.hl, mentionList.length - 1)].path));
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


  const AccessIcon = ACCESS_ICON[app.access];
  const accessLabel = { readonly: t("accessReadonly"), auto: t("accessAuto"), full: t("accessFull") }[app.access];

  return (
    <>
      <div className="composer-wrap">
        <div
          className="composer"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const id = Number(e.dataTransfer.getData("text/chat")); const chat = app.chats.find(c => c.id === id); if (chat) void attachChat(chat); else addImageFiles(e.dataTransfer.files); }}
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
                <button key={f.chat ? `chat:${f.chat.id}` : f.path} id={`mention-opt-${i}`} role="option" aria-selected={i === mention.hl} tabIndex={-1} className={`menu-item${i === mention.hl ? " hl" : ""}`} onMouseDown={(e) => (e.preventDefault(), (f.chat ? void attachChat(f.chat) : insertMention(f.path)))}>
                  <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{f.label}</span>
                </button>
              ))}
            </div>
          )}
          {chatLoading && <div role="status">{ru ? "Читаю чат…" : "Reading chat…"}</div>}
          {references.map((ref, i) => <div key={`${ref.sourceId}:${i}`} className="chat-reference">
            <button className="btn-ghost" disabled={!app.chats.some(c => c.id === ref.sourceId)} onClick={() => app.openChat(ref.sourceId, app.chats.find(c => c.id === ref.sourceId)?.project_id ?? null)}>{ref.title}</button>
            <span>{ref.snapshot.length.toLocaleString()} {ru ? "символов" : "characters"}{ref.shortened ? (ru ? " · сокращено" : " · shortened") : ""}</span>
            <button className="btn-ghost" aria-label={t("removeAttachment")} onClick={() => setText(joinChatReferences(composerBody, references.filter((_, j) => j !== i)))}><X size={14} /></button>
            <details><summary>{ru ? "Точный текст для отправки" : "Exact text to send"}</summary><pre>{ref.snapshot}</pre></details>
          </div>)}
          {pendingChat && <div className="chat-reference" role="region" aria-label={ru ? "Прикрепить чат" : "Attach chat"}>
            <strong>{pendingChat.title}</strong> · {pendingChat.fullSize.toLocaleString()} {ru ? "символов" : "characters"}
            <p>{ru ? "Разговор будет отправлен как текстовый справочный материал (изображения не копируются). Снимок сохраняется независимо от последующих изменений исходника." : "Conversation is sent as text reference material (images are not copied). The snapshot is retained independently of later source edits."}</p>
            <details><summary>{ru ? "Полный снимок" : "Full snapshot"}</summary><pre>{pendingChat.snapshot}</pre></details>
            <button className="btn" onClick={() => confirmChat(pendingChat)}>{ru ? "Прикрепить полностью" : "Attach full version"}</button>
            {pendingChat.fullSize > CHAT_REFERENCE_LIMIT && <><p>{ru ? "Большой разговор увеличит расход контекста. Можно явно сократить середину." : "A large conversation consumes more context. You can explicitly omit the middle."}</p><button className="btn" onClick={() => confirmChat(shortenChat(pendingChat))}>{ru ? "Прикрепить сокращённо" : "Attach shortened version"}</button></>}
            <button className="btn-ghost" onClick={() => setPendingChat(null)}>{t("cancel")}</button>
          </div>}
          {images.length > 0 && (
            <div className="attach-list">
              {images.map((d, i) => (
                <div key={i} className="attach">
                  <ImageThumb src={`data:image/png;base64,${d}`} alt={t("attachedImage", { n: i + 1, total: images.length })} />
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
            value={composerBody}
            placeholder={p.projectName ? t("askProject") : t("askAnything")}
            onChange={(e) => {
              setText(joinChatReferences(e.target.value, references));
              const cmd = /^\/([a-zA-Z0-9_-]*)$/.exec(e.target.value);
              setSlash(cmd ? { q: cmd[1], hl: 0 } : null);
              const m = /@([^\s@]*)$/.exec(e.target.value.slice(0, e.target.selectionStart));
              setMention(m ? { q: m[1], hl: 0 } : null);
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
                  { label: ru ? "Прикрепить чат" : "Attach chat", icon: <MessageCircle size={15} />, onClick: () => { setText(joinChatReferences(composerBody + " @", references)); setMention({ q: "", hl: 0 }); taRef.current?.focus(); } },
                  ...(root ? [{ label: t("mentionFile"), icon: <AtSign size={15} />, onClick: () => (setText(joinChatReferences(composerBody + (composerBody && !composerBody.endsWith(" ") ? " @" : "@"), references)), setMention({ q: "", hl: 0 }), taRef.current?.focus()) }] : []),
                  ...(hasMcp ? [{ label: t("mcpPromptAttach"), icon: <Plug size={18} />, onClick: () => setPromptDialog(true) }] : []),
                  ...(p.knowledge ? knowledgeEntries(p.knowledge, t) : []),
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
              title={t("accessMode")}
            >
              <AccessIcon size={14} /> {accessLabel}
            </button>
            {p.workspace?.linkedBranch ? (
              <span className="chip workspace-chip" title={p.workspace.linkedBranch}>
                <GitBranch size={14} aria-hidden="true" /> <span className="name">{t("workspaceChip", { branch: p.workspace.linkedBranch })}</span>
              </span>
            ) : p.workspace?.available ? (
              <button className={`chip${p.workspace.on ? " on" : ""}`} aria-pressed={p.workspace.on} onClick={p.workspace.onToggle} title={t("workspaceRunInHint")}>
                <GitBranch size={14} /> {t("workspaceRunIn")}
              </button>
            ) : null}
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
              computerUse={app.computerUse && p.supports.computer}
              onOpen={instructions.reload}
            />
            <div className="composer-model" style={{ position: "relative" }}>
              {/* A model with effort levels opens the effort slider first (the model name inside it opens the list). */}
              <button
                className="chip" title={accountTitle} aria-haspopup="dialog" aria-expanded={picker || effort}
                onClick={() => (!app.providers.length ? app.openSettings("providers") : p.supports.reasoning ? (setPicker(false), setEffort(!effort)) : setPicker(!picker))}
              >
                {p.provider && <ModelIcon model={app.selection?.model ?? ""} provider={p.provider} size={15} />}
                <span className="chip-label">{p.modelName ?? t("chooseModel")}</span>
                {p.supports.reasoning && <> <span className="effort-chip-level">{t(`reasoning_${app.reasoning}`)}</span></>}
                <ChevronDown size={13} className="chev" />
              </button>
              {picker && <ModelPicker onClose={() => setPicker(false)} />}
              {effort && p.supports.reasoning && (
                <EffortPicker
                  levels={REASONING_LEVELS} value={app.reasoning} defaultValue={DEFAULT_REASONING} onChange={app.setReasoning}
                  modelName={p.modelName ?? t("chooseModel")} onOpenModels={() => (setEffort(false), setPicker(true))} onClose={() => setEffort(false)}
                />
              )}
            </div>
            <div className="composer-actions">
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
