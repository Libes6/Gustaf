import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowUp, Check, Copy, ExternalLink, Square } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import { Markdown } from "../components/Markdown";
import { detectLocale, I18nProvider, useT, type Locale } from "../i18n";
import { db, getSetting } from "../lib/api";
import { currentBudgetStop } from "../lib/budgetUsage";
import { addMessage, createChat } from "../lib/data";
import {
  buildChatPayload, buildUserText, canKeep, clipboardPreview, INITIAL_QUICK_ASK, limitClipboard, MAX_CLIPBOARD_CHARS, pickDefaultModel, QUICK_ASK_SYSTEM,
  quickAskReducer, usableModels, type Selection,
} from "../lib/quickAsk";
import { quickAskApi } from "../lib/quickAskApi";
import { getAdapter, listAllModels, loadProviders } from "../providers";
import type { ModelInfo, ProviderConfig } from "../providers/types";
import "./quick-ask.css";

type Config = { providers: ProviderConfig[]; models: ModelInfo[]; model: ModelInfo | null; fellBack: boolean };
type Clip = { on: boolean; text: string; truncated: boolean; chars: number; denied: boolean };
const NO_CLIP: Clip = { on: false, text: "", truncated: false, chars: 0, denied: false };
const modelId = (m: { providerId: string; id: string }) => `${m.providerId}\n${m.id}`;

/** Providers, the model list from the cache and the app's default model (the same "selection" the main window uses). */
async function loadConfig(): Promise<Config> {
  const [providers, selection, hidden] = await Promise.all([loadProviders(), getSetting<Selection | null>("selection", null), getSetting<string[]>("hiddenModels", [])]);
  const { models } = await listAllModels(providers, "startup");
  const usable = usableModels(providers, models, hidden);
  const { model, fellBack } = pickDefaultModel(selection, usable);
  return { providers, models: usable, model, fellBack };
}

/**
 * The quick-ask window: one question, one streamed answer from a model, no tools and no project access. Nothing is stored
 * unless "Open in Gustaf" is used. `session` changes each time Rust shows the window: the previous exchange is dropped.
 */
export function QuickAskView({ session = 0 }: { session?: number }) {
  const t = useT();
  const [input, setInput] = useState("");
  const [state, dispatch] = useReducer(quickAskReducer, INITIAL_QUICK_ASK);
  const [config, setConfig] = useState<Config | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [clip, setClip] = useState<Clip>(NO_CLIP);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);

  const abort = () => {
    runRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
  };

  // A fresh question every time the window is shown; the model list is re-read (providers or the default may have changed).
  useEffect(() => {
    abort();
    dispatch({ type: "reset" });
    setInput("");
    setClip(NO_CLIP);
    setSaveError("");
    setCopied(false);
    inputRef.current?.focus();
    let cancelled = false;
    loadConfig().then((c) => { if (!cancelled) { setConfig(c); setChosen(c.model ? modelId(c.model) : null); } }).catch(() => { if (!cancelled) setConfig({ providers: [], models: [], model: null, fellBack: false }); });
    return () => { cancelled = true; };
  }, [session]);
  useEffect(() => abort, []);

  // Esc closes the window (and ends a running request).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      abort();
      quickAskApi.hide().catch(() => {});
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);

  // The window follows the content height (Rust clamps it to 160..520).
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const apply = () => quickAskApi.resize(Math.ceil(el.getBoundingClientRect().height)).catch(() => {});
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const model = config?.models.find((m) => modelId(m) === chosen) ?? null;
  const provider = model ? config?.providers.find((p) => p.id === model.providerId) : undefined;
  const streaming = state.phase === "streaming";

  async function send() {
    const question = input.trim();
    if (!question || streaming || !model || !provider) return;
    const run = ++runRef.current;
    const live = () => runRef.current === run;
    const target = { providerId: model.providerId, model: model.id };
    const clipboard = clip.on ? clip.text : null;
    dispatch({ type: "send", question, clipboard, model: target });
    setCopied(false);
    setSaveError("");
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      if ((await currentBudgetStop(undefined)) === "day") throw new Error(t("quickAskBudget"));
      const adapter = await getAdapter(provider);
      const out = await adapter.turn({
        system: QUICK_ASK_SYSTEM,
        messages: [{ role: "user", parts: [{ type: "text", text: buildUserText(question, clipboard) }] }],
        model: model.id,
        tools: [],
        access: "readonly",
        mode: "ask",
        signal: ctl.signal,
        onText: (delta) => live() && dispatch({ type: "delta", text: delta }),
      });
      if (!live()) return;
      dispatch({ type: "finish", usage: out.usage });
      quickAskApi.emitUsage({ ...target, usage: out.usage }).catch(() => {});
    } catch (e) {
      if (!live() || ctl.signal.aborted) return;
      const message = String((e as Error)?.message ?? e);
      dispatch({ type: "fail", message });
      quickAskApi.emitUsage({ ...target, error: message }).catch(() => {});
    } finally {
      if (abortRef.current === ctl) abortRef.current = null;
    }
  }

  function stop() {
    abort();
    dispatch({ type: "stop" });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(state.answer);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard unavailable: nothing to confirm */ }
  }

  async function readClipboard() {
    try {
      const lim = limitClipboard(await navigator.clipboard.readText());
      setClip({ on: true, text: lim.text, truncated: lim.truncated, chars: lim.chars, denied: false });
    } catch {
      setClip({ ...NO_CLIP, denied: true });
    }
  }

  async function openInGustaf() {
    const payload = buildChatPayload(state);
    if (!payload || saving) return;
    setSaving(true);
    setSaveError("");
    let chatId: number | null = null;
    try {
      chatId = await createChat(null, payload.title);
      for (const m of payload.messages) await addMessage(chatId, m);
      await quickAskApi.emitOpenChat({ chatId });
      await quickAskApi.openMain();
      dispatch({ type: "reset" });
      setInput("");
      setClip(NO_CLIP);
    } catch (e) {
      // A half-written chat would show up in the sidebar: take it back.
      if (chatId !== null) await db.exec("delete from chats where id = ?", [chatId]).catch(() => {});
      setSaveError(t("quickAskSaveFailed", { message: String((e as Error)?.message ?? e) }));
    } finally {
      setSaving(false);
    }
  }

  const drag = (e: React.MouseEvent) => {
    if (e.button !== 0 || !isTauri()) return;
    e.preventDefault();
    getCurrentWindow().startDragging().catch(() => {});
  };

  return (
    <div className="qa" ref={innerRef} role="dialog" aria-label={t("quickAskTitle")}>
      <div className="qa-drag" onMouseDown={drag} aria-hidden="true" />
      <div className="qa-input">
        <textarea
          ref={inputRef}
          autoFocus
          rows={1}
          aria-label={t("quickAskQuestion")}
          placeholder={t("quickAskPlaceholder")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {streaming ? (
          <button className="send" aria-label={t("stop")} title={t("stop")} onClick={stop}><Square size={13} fill="currentColor" /></button>
        ) : (
          <button className="send" aria-label={t("send")} title={t("send")} disabled={!input.trim() || !model} onClick={() => void send()}><ArrowUp size={16} /></button>
        )}
      </div>
      <div className="qa-options">
        {config && config.models.length > 0 && (
          <select className="qa-model" aria-label={t("quickAskModel")} value={chosen ?? ""} disabled={streaming} onChange={(e) => setChosen(e.target.value)}>
            {config.models.map((m) => (
              <option key={modelId(m)} value={modelId(m)}>{m.name || m.id} · {config.providers.find((p) => p.id === m.providerId)?.name}</option>
            ))}
          </select>
        )}
        <span className="grow" />
        <label className="qa-switch">
          <span>{t("quickAskClipboard")}</span>
          <button role="switch" aria-checked={clip.on} aria-label={t("quickAskClipboard")} className={`toggle${clip.on ? " on" : ""}`} onClick={() => (clip.on ? setClip(NO_CLIP) : void readClipboard())} />
        </label>
      </div>
      {config && !config.models.length && <div className="qa-note">{t("quickAskNoModel")}</div>}
      {config?.fellBack && config.models.length > 0 && <div className="qa-note">{t("quickAskFallback")}</div>}
      {clip.denied && <div className="qa-note" role="alert">{t("quickAskClipboardDenied")}</div>}
      {clip.on && (
        <div className="qa-clip" role="group" aria-label={t("quickAskClipboardPreview")}>
          {clip.text.trim() ? (
            <>
              <pre>{clipboardPreview(clip.text)}</pre>
              <div className="d">
                {t("quickAskClipboardChars", { n: clip.text.length })}
                {clip.truncated && ` ${t("quickAskClipboardCut", { n: MAX_CLIPBOARD_CHARS })}`}
              </div>
            </>
          ) : (
            <div className="d">{t("quickAskClipboardEmpty")}</div>
          )}
        </div>
      )}
      {state.phase !== "idle" && (
        <div className="qa-answer" aria-live="polite" aria-busy={streaming}>
          {state.answer ? <Markdown text={state.answer} /> : streaming && <span className="d">{t("quickAskThinking")}</span>}
          {state.phase === "stopped" && <div className="d">{t("quickAskStopped")}</div>}
          {state.phase === "error" && <div className="qa-error" role="alert">{state.error}</div>}
        </div>
      )}
      {saveError && <div className="qa-error" role="alert">{saveError}</div>}
      <div className="qa-foot">
        <span className="d">{t("quickAskNotSaved")}</span>
        <span className="grow" />
        {canKeep(state) && (
          <>
            <button className="btn-soft" onClick={() => void copy()}>
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? t("quickAskCopied") : t("copy")}
            </button>
            <button className="btn-soft" disabled={saving} onClick={() => void openInGustaf()}>
              <ExternalLink size={13} /> {t("quickAskOpen")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Entry component: locale from the settings (re-read on every show), the shared i18n provider, and the "ready" handshake with Rust. */
export function QuickAskRoot() {
  const [locale, setLocale] = useState<Locale>(detectLocale());
  const [session, setSession] = useState(0);
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    quickAskApi.onShown(() => setSession((s) => s + 1)).then((un) => (gone ? un() : (off = un))).catch(() => {});
    quickAskApi.ready().catch(() => {});
    return () => { gone = true; off?.(); };
  }, []);
  useEffect(() => {
    getSetting<Locale>("locale", detectLocale()).then(setLocale).catch(() => {});
  }, [session]);
  return (
    <I18nProvider locale={locale}>
      <QuickAskView session={session} />
    </I18nProvider>
  );
}
