import { ArrowUp, AtSign, Brain, ChevronDown, ImagePlus, Lock, Monitor, Plus, ShieldCheck, Square, Unlock, X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Access } from "../../agent/agent";
import { useT } from "../../i18n";
import { computer } from "../../lib/api";
import type { ModelInfo, ProviderConfig } from "../../providers/types";
import { useApp } from "../../state";
import { useMenu } from "../Menu";
import { ModelIcon } from "../ModelIcon";
import { ModelPicker } from "../ModelPicker";
import { useInstructionReport } from "../../lib/useInstructionReport";
import { ContextChip } from "./ContextChip";

const ACCESS_ICON: Record<Access, typeof Lock> = { readonly: Lock, auto: ShieldCheck, full: Unlock };

type Props = {
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
  const { text, setText, images, setImages, taRef, root, selectedModel } = p;
  const instructions = useInstructionReport(root, p.provider);
  const [picker, setPicker] = useState(false);
  const [mention, setMention] = useState<{ q: string; hl: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const ta = taRef.current!;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [text]);
  useEffect(() => { if (p.visible) taRef.current?.focus(); else { setPicker(false); setMention(null); } }, [p.visible]);

  const mentionList = mention ? p.files.filter((f) => f.toLowerCase().includes(mention.q.toLowerCase())).slice(0, 12) : [];
  const insertMention = (path: string) => {
    setText(text.replace(/@([\w./-]*)$/, `@${path} `));
    setMention(null);
    taRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
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
    for (const f of Array.from(list).filter((f) => f.type.startsWith("image/"))) {
      const r = new FileReader();
      r.onload = () => setImages((xs) => [...xs, String(r.result).split(",")[1]]);
      r.readAsDataURL(f);
    }
  };

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
          {mention && mentionList.length > 0 && (
            <div className="menu mention-list" style={{ position: "absolute" }}>
              {mentionList.map((f, i) => (
                <button key={f} className={`menu-item${i === mention.hl ? " hl" : ""}`} onMouseDown={(e) => (e.preventDefault(), insertMention(f))}>
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
            rows={1}
            value={text}
            placeholder={p.projectName ? t("askProject") : t("askAnything")}
            onChange={(e) => {
              setText(e.target.value);
              const m = /@([\w./-]*)$/.exec(e.target.value.slice(0, e.target.selectionStart));
              setMention(m && root ? { q: m[1], hl: 0 } : null);
            }}
            onKeyDown={onKeyDown}
            onPaste={(e) => e.clipboardData.files.length && (e.preventDefault(), addImageFiles(e.clipboardData.files))}
          />
          <div className="composer-bar">
            <button
              className="icon-btn"
              disabled={selectedModel?.images === false && !root}
              title={t("attach")}
              onClick={(e) =>
                menu.open(e.currentTarget.getBoundingClientRect(), [
                  ...(selectedModel?.images !== false ? [{ label: t("attachImage"), icon: <ImagePlus size={15} />, onClick: () => fileInput.current?.click() }] : []),
                  ...(root ? [{ label: t("mentionFile"), icon: <AtSign size={15} />, onClick: () => (setText(text + (text && !text.endsWith(" ") ? " @" : "@")), setMention({ q: "", hl: 0 }), taRef.current?.focus()) }] : []),
                ])
              }
            >
              <Plus size={16} />
            </button>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => (e.target.files && addImageFiles(e.target.files), (e.target.value = ""))} />
            <button
              className="chip"
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
              <button className={`chip${app.computerUse ? " on" : ""}`} onClick={toggleComputer} title={t("computerUseHint")}>
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
              <button className="chip" onClick={() => (app.providers.length ? setPicker(!picker) : app.openSettings("providers"))}>
                {p.provider && <ModelIcon model={app.selection?.model ?? ""} provider={p.provider} size={15} />}
                {p.modelName ?? t("chooseModel")} <ChevronDown size={13} />
              </button>
              {picker && <ModelPicker onClose={() => setPicker(false)} />}
            </div>
            {p.supports.reasoning && (
              <button
                className="chip"
                onClick={(e) =>
                  menu.open(e.currentTarget.getBoundingClientRect(), (["low", "medium", "high"] as const).map((r) => ({ label: t(`reasoning_${r}`), kbd: app.reasoning === r ? "✓" : "", onClick: () => app.setReasoning(r) })))
                }
              >
                <Brain size={14} /> {t(`reasoning_${app.reasoning}`)}
              </button>
            )}
            {p.running ? (
              <button className="send" onClick={p.onStop} title={t("stop")}>
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button className="send" disabled={!text.trim() && !images.length} onClick={p.onSend} title={t("send")}>
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      {menu.node}
    </>
  );
}
