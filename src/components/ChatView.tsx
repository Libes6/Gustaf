import { reserveFor } from "../providers/cursorAccounts";
import { ArrowDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { effectiveHistory, estimateContext } from "../lib/context";
import { fsx } from "../lib/api";
import { loadMessages, type StoredMsg } from "../lib/data";
import { getAdapter } from "../providers";
import { textOf } from "../providers/types";
import type { ChatSession } from "../lib/chatSessions";
import { groupTurns } from "../lib/chatTurns";
import { editableText, turnMessageIds } from "../lib/messageActions";
import { useChatRun } from "../lib/useChatRun";
import { useComposerDraft } from "../lib/useComposerDraft";
import { useMessageJump } from "../lib/useMessageJump";
import { turnHasMessage } from "../lib/searchUtil";
import { useApp } from "../state";
import { AgentsPanel } from "./AgentsPanel";
import { ChangesPanel } from "./ChangesPanel";
import { CanvasWorkspace } from "./CanvasWorkspace";
import { Composer } from "./chat/Composer";
import { LiveStatus } from "./chat/LiveStatus";
import { TurnView, type TurnHandlers } from "./chat/TurnView";

export function ChatView({ session, visible }: { session: ChatSession; visible: boolean }) {
  const t = useT();
  const app = useApp();
  const [messages, setMessages] = useState<StoredMsg[]>([]);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [files, setFiles] = useState<string[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [loaded, setLoaded] = useState(session.chatId === null);
  const draft = useComposerDraft(session, text, images, (d) => { setText(d.text); setImages(d.images); });
  const flashId = useMessageJump({ jump: app.jump, clearJump: app.clearJump, chatId: session.chatId, visible, loaded, messages, feedRef, onJump: () => setAtBottom(false) });

  const chat = app.chats.find((c) => c.id === session.chatId);
  const project = app.projects.find((p) => p.id === (chat?.project_id ?? session.projectId));
  const root = project?.path ?? null;
  const provider = app.providers.find((p) => p.id === app.selection?.providerId);
  const selectedModel = app.models.find(m => m.providerId === provider?.id && m.id === app.selection?.model);
  const contextTokens = estimateContext(effectiveHistory(messages), text);
  const lastInput = [...messages].reverse().find(m => m.meta?.provider === provider?.id && m.meta?.model === app.selection?.model && m.meta?.usage)?.meta?.usage?.input;
  const modelName = app.models.find((m) => m.providerId === provider?.id && m.id === app.selection?.model)?.name ?? app.selection?.model;
  const [supports, setSupports] = useState({ computer: false, reasoning: false });

  const run = useChatRun({
    session, visible, messages, setMessages, loaded, text, setText, images, setImages, draft,
    projectId: project?.id ?? null, root, files, provider, selectedModel, setAtBottom,
  });
  const { stream, error, running, approval, toolResults, activities } = run;
  // Stable handlers (TurnView is memoized, so a streaming reply must not re-render the whole history); they read the latest state through the ref.
  const latest = useRef({ run, title: "", branchLabel: "" });
  latest.current = { run, title: chat?.title ?? "", branchLabel: t("branchSuffix") };
  const turnHandlers = useMemo<TurnHandlers>(() => ({
    onEdit: (m, txt) => void latest.current.run.resendFrom(m, txt),
    onRegenerate: (user) => void latest.current.run.resendFrom(user, editableText(user)),
    onDelete: (turn) => void latest.current.run.removeMessages((turn.user ?? turn.steps[0]).chat_id, turnMessageIds(turn)),
    onBranch: (m) => void latest.current.run.branchFrom(m, latest.current.title, latest.current.branchLabel),
  }), []);

  useEffect(() => {
    let cancelled = false;
    const model = app.selection?.model;
    setSupports({ computer: false, reasoning: false });
    if (provider && model) {
      getAdapter(provider).then((a) => {
        if (!cancelled) setSupports({ computer: a.supportsComputer, reasoning: a.supportsReasoning(model) });
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [provider, app.selection?.model]);

  useEffect(() => {
    if (running) return;
    run.setError("");
    let cancelled = false;
    setLoaded(false);
    if (session.chatId) loadMessages(session.chatId).then(ms => { if (!cancelled) { setMessages(ms); setLoaded(true); } }).catch(e => { if (!cancelled) run.setError(String(e instanceof Error ? e.message : e)); });
    else { setMessages([]); setLoaded(true); }
    return () => { cancelled = true; };
  }, [session.chatId]);

  useEffect(() => {
    let cancelled = false;
    setFiles([]);
    if (root) fsx.files(root).then((next) => {
      if (!cancelled) setFiles(next);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [root]);

  useEffect(() => {
    const el = feedRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [messages, stream, approval, activities, toolResults]);

  const turns = useMemo(() => groupTurns(messages), [messages]);
  const canvasSources = useMemo(() => messages.filter((m) => m.role === "assistant").map(textOf), [messages]);

  const reserve = reserveFor(provider, app.providers, app.selection?.model ?? "", app.models);

  return (
    <CanvasWorkspace sources={canvasSources} scope={session.key} onRepair={(prompt) => { setText(prompt); taRef.current?.focus(); }}>
    <main className="main">


      {root && <AgentsPanel root={root} />}
      {root && project && <ChangesPanel name={project.name} root={root} busy={running} messages={messages} tick={run.tick} onChanged={run.bumpTick} />}

      {messages.length === 0 && stream === null && !error ? (
        <div className="empty">
          <h1>{project ? t("emptyProject", { name: project.name }) : t("emptyTitle")}</h1>
        </div>
      ) : (
        <div className="feed" ref={feedRef} onScroll={(e) => setAtBottom(e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 40)}>
          <div className="feed-inner">
            {turns.map((turn, i) => (
              <TurnView key={turn.user?.id ?? `t${i}`} turn={turn} liveResults={toolResults} live={running && i === turns.length - 1} onRewind={turn.user && root ? run.rewind : undefined} focusId={flashId != null && turnHasMessage(turn, flashId) ? flashId : null} busy={running} isLastTurn={i === turns.length - 1} handlers={turnHandlers} />
            ))}
            <LiveStatus activities={activities} stream={stream} approval={approval} retryNotice={run.retryNotice} stats={run.live.current} visible={visible} />
            {error && <div className="error-box" role="alert">{error}<div><button className="btn-soft" disabled={running} onClick={() => run.retryRequest()}>{t("retryRequest")}</button>{reserve && <button className="btn-soft" disabled={running} onClick={() => run.retryRequest(reserve)}>{t("retryReserve", { name: reserve.name })}</button>}</div></div>}
          </div>
        </div>
      )}
      {!atBottom && (
        <button className="to-bottom" onClick={() => feedRef.current?.scrollTo({ top: 1e9, behavior: "smooth" })}>
          <ArrowDown size={15} />
        </button>
      )}

      <Composer
        text={text} setText={setText} images={images} setImages={setImages} taRef={taRef} visible={visible}
        root={root} projectName={project?.name} files={files}
        provider={provider} selectedModel={selectedModel} modelName={modelName} supports={supports}
        running={running} onSend={() => run.send()} onStop={run.stop}
        contextTokens={contextTokens} lastInput={lastInput}
        canCompact={!(running || !loaded || messages.length < 4 || !provider)}
        canRestore={messages.some(m => m.meta?.compacted)}
        onCompact={run.compact} onRestore={run.restoreContext}
      />
    </main>
    </CanvasWorkspace>
  );
}
