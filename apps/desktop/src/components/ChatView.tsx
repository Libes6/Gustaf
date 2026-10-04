import { splitChatReferences, joinChatReferences } from "../lib/chatContext";
import { ArrowDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { requestTerminalCommand } from "../lib/terminalBridge";
import { onComposerDraft, takeComposerDraft } from "../lib/composerBridge";
import { effectiveHistory, estimateContext } from "../lib/context";
import { fsx } from "../lib/api";
import { loadMessages, type StoredMsg } from "../lib/data";
import { getAdapter } from "../providers";
import { textOf } from "../providers/types";
import type { ChatSession } from "../lib/chatSessions";
import { groupTurns } from "../lib/chatTurns";
import { editableText, turnMessageIds } from "../lib/messageActions";
import { useChatRun } from "../lib/useChatRun";
import { useBackgroundTasks } from "../lib/useBackgroundTasks";
import { useComposerDraft } from "../lib/useComposerDraft";
import { useMessageJump } from "../lib/useMessageJump";
import { turnHasMessage } from "../lib/searchUtil";
import { useApp } from "../state";
import { AgentsColumn, AgentsToggle } from "./AgentsPanel";
import { ChangesPanel } from "./ChangesPanel";
import { CanvasWorkspace } from "./CanvasWorkspace";
import { useChatMode } from "../lib/useChatMode";
import { planToInstruction, type Plan } from "../agent/planCore";
import { chatWorkspace, resolveChatRoot } from "../lib/workspaces";
import { useIsGitProject, usePrefix, useWorkspaces } from "../lib/workspaceStore";
import { resolveReviewCopy } from "../lib/reviewCopy";
import { Composer } from "./chat/Composer";
import { BranchPicker } from "./chat/BranchPicker";
import { BranchBar } from "./chat/BranchBar";
import { LiveStatus } from "./chat/LiveStatus";
import { TurnView, type TurnHandlers } from "./chat/TurnView";
import { useAutoMemorySuggest } from "../lib/useAutoMemorySuggest";
import { MemorySuggestDialog } from "./MemoryDialogs";

export function ChatView({ session, visible }: { session: ChatSession; visible: boolean }) {
  const t = useT();
  const app = useApp();
  const [messages, setMessages] = useState<StoredMsg[]>([]);
  const [text, setText] = useState("");
  const [branchPoint, setBranchPoint] = useState<StoredMsg | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [files, setFiles] = useState<string[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [loaded, setLoaded] = useState(session.chatId === null);
  const draft = useComposerDraft(session, text, images, (d) => { setText(d.text); setImages(d.images); });
  const flashId = useMessageJump({ jump: app.jump, clearJump: app.clearJump, chatId: session.chatId, visible, loaded, messages, feedRef, onJump: () => setAtBottom(false) });

  const chat = app.chats.find((c) => c.id === session.chatId);
  const project = app.projects.find((p) => p.id === (chat?.project_id ?? session.projectId));
  // A chat linked to a workspace works in that workspace's checkout (file tools, commands, terminal, @mentions, instruction
  // files, changes panel); it never falls back to the main checkout: while that cannot be resolved there is no root.
  const workspace = chatWorkspace(chat);
  const projectRoot = project?.path ?? null;
  const workspaces = useWorkspaces(projectRoot, !!workspace);
  const prefix = usePrefix(projectRoot, !!workspace);
  const resolved = resolveChatRoot({ projectPath: projectRoot, workspace, known: prefix === null ? undefined : workspaces.list, prefix });
  const root = resolved.root;
  const blocked = resolved.state === "pending" ? t("workspacePending") : resolved.state === "missing" ? t("workspaceMissing") : undefined;
  const [newWorkspace, setNewWorkspace] = useState(false);
  const reviewOn = resolveReviewCopy(app.reviewCopy);
  const isGit = useIsGitProject(projectRoot);
  const provider = app.providers.find((p) => p.id === app.selection?.providerId);
  const selectedModel = app.models.find(m => m.providerId === provider?.id && m.id === app.selection?.model);
  const contextTokens = estimateContext(effectiveHistory(messages), text);
  const lastInput = [...messages].reverse().find(m => m.meta?.provider === provider?.id && m.meta?.model === app.selection?.model && m.meta?.usage)?.meta?.usage?.input;
  const modelName = app.models.find((m) => m.providerId === provider?.id && m.id === app.selection?.model)?.name ?? app.selection?.model;
  const [supports, setSupports] = useState({ computer: false, reasoning: false });

  const tasks = useBackgroundTasks(root);
  const continueAgent = (message: string) => { setText((old) => (old.trim() ? `${old}\n\n${message}` : message)); taRef.current?.focus(); };
  // A draft requested from outside (the merge queue's "Resolve with agent") lands in this chat's message box; it is never sent.
  useEffect(() => {
    if (!visible || session.chatId === null) return;
    const take = () => { const d = takeComposerDraft(session.chatId); if (d) continueAgent(d); };
    take();
    return onComposerDraft(take);
  }, [visible, session.chatId]);
  const [mode, setMode] = useChatMode(session.chatId);
  const run = useChatRun({
    session, visible, messages, setMessages, loaded, text, setText, images, setImages, draft,
    projectId: project?.id ?? null, root, files, provider, selectedModel, setAtBottom, mode,
    workspace, projectRoot, blocked, newWorkspace, onWorkspaceUsed: () => setNewWorkspace(false),
  });
  const { stream, error, running, approval, toolResults, activities } = run;
  const autoMemory = useAutoMemorySuggest({ chatId: session.chatId, running: run.ownRunning, active: visible, projectRoot: projectRoot });
  // Stable handlers (TurnView is memoized, so a streaming reply must not re-render the whole history); they read the latest state through the ref.
  const latest = useRef({ run, title: "", branchLabel: "", messages, setMode });
  latest.current = { run, title: chat?.title ?? "", branchLabel: t("branchSuffix"), messages, setMode };
  const turnHandlers = useMemo<TurnHandlers>(() => ({
    diagnosticsProjectRoot: root ?? undefined,
    onRunCommand: root ? command => requestTerminalCommand(root, command) : undefined,
    onEdit: (m, txt) => void latest.current.run.resendFrom(m, txt),
    onRegenerate: (user) => void latest.current.run.resendFrom(user, editableText(user)),
    onDelete: (turn) => void latest.current.run.removeMessages((turn.user ?? turn.steps[0]).chat_id, turnMessageIds(turn)),
    onBranch: (m) => { setBranchPoint(m); },
    onApprovePlan: (plan: Plan) => {
      // Approve: Agent mode from now on, and the plan is the next instruction.
      latest.current.setMode("agent");
      void latest.current.run.send(false, { text: planToInstruction(plan), images: [], base: latest.current.messages, mode: "agent" });
    },
    onRejectPlan: () => taRef.current?.focus(),
  }), [root]);

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
    // Not while this view runs a send itself (a new chat is promoted to its id then); a scheduled run is only displayed.
    if (run.ownRunning) return;
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

  return (
    <CanvasWorkspace sources={canvasSources} scope={session.key} onRepair={(prompt) => { setText(prompt); taRef.current?.focus(); }}
      aside={root && tasks.open ? <AgentsColumn root={root} tasks={tasks} onContinue={continueAgent} toggleRef={toggleRef} /> : undefined}>
    <main className="main">

      {root && <AgentsToggle tasks={tasks} buttonRef={toggleRef} />}
      {root && project && <ChangesPanel reviewOn={workspace ? undefined : reviewOn} name={project.name} root={root} workspace={resolved.state === "workspace" && workspace && projectRoot ? { taskId: workspace.taskId, branch: resolved.info.branch, projectRoot } : undefined} busy={running} messages={messages} tick={run.tick} onChanged={run.bumpTick} onReplyToAgent={continueAgent} />}

      {messages.length === 0 && stream === null && !error ? (
        <div className="empty">
          <h1>{project ? t("emptyProject", { name: project.name }) : t("emptyTitle")}</h1>
          {blocked && resolved.state === "missing" && <div className="error-box" role="alert">{blocked}</div>}
        </div>
      ) : (
        <>
        {session.chatId && <BranchBar chatId={session.chatId} />}
        {branchPoint && <BranchPicker busy={running} onCancel={() => setBranchPoint(null)} onCreate={async selection => {
          await latest.current.run.branchFrom(branchPoint, latest.current.title, latest.current.branchLabel, selection);
          setBranchPoint(null);
        }} />}
        <div className="feed" ref={feedRef} role="log" aria-live="off" aria-label={t("conversation")} tabIndex={0} onScroll={(e) => setAtBottom(e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 40)}>
          <div className="feed-inner">
            {turns.map((turn, i) => (
              <TurnView key={turn.user?.id ?? `t${i}`} turn={turn} liveResults={toolResults} live={running && i === turns.length - 1} onRewind={turn.user && root ? run.rewind : undefined} focusId={flashId != null && turnHasMessage(turn, flashId) ? flashId : null} busy={running} isLastTurn={i === turns.length - 1} handlers={turnHandlers} />
            ))}
            {blocked && <div className="error-box" role="alert">{blocked}</div>}
            <LiveStatus activities={activities} stream={stream} approval={approval} retryNotice={run.retryNotice} stats={run.live.current} visible={visible} onRunCommand={turnHandlers.onRunCommand} projectRoot={root ?? undefined} />
            {error && <div className="error-box" role="alert">{error}<div><button className="btn-soft" disabled={running} onClick={() => run.retryRequest()}>{t("retryRequest")}</button></div></div>}
          </div>
        </div>
        </>
      )}
      {!atBottom && (
        <button className="to-bottom" title={t("scrollToBottom")} aria-label={t("scrollToBottom")} onClick={() => feedRef.current?.scrollTo({ top: 1e9, behavior: "smooth" })}>
          <ArrowDown size={15} />
        </button>
      )}

      {run.queue && (run.queue.items.length > 0 || run.queue.interrupted) && <div className="queue-panel">
        {run.queue.interrupted && <p>{t("queueInterrupted")}</p>}
        <button className="chip" onClick={() => run.changeQueue(q => ({ ...q, paused: !q.paused, interrupted: false }))}>{t(run.queue.paused ? "queueResume" : "queuePause")}</button>
        {run.queue.items.map(item => {
          const pending = splitChatReferences(item.text);
          return <div key={item.id}>
            <textarea aria-label={t("queueEdit")} value={pending.body} onChange={e => run.changeQueue(q => ({ ...q, items: q.items.map(i => i.id === item.id ? { ...i, text: joinChatReferences(e.target.value, splitChatReferences(i.text).references) } : i) }))} />
            {pending.references.map((ref, index) => <details className="chat-reference" key={`${ref.sourceId}:${index}`}><summary>{ref.title}</summary><pre>{ref.snapshot}</pre></details>)}
            <button className="chip" onClick={() => run.changeQueue(q => ({ ...q, items: q.items.filter(i => i.id !== item.id) }))}>{t("queueRemove")}</button>
          </div>;
        })}
      </div>}
      <Composer
        scopeKey={session.key} text={text} setText={setText} images={images} setImages={setImages} taRef={taRef} visible={visible}
        root={root} projectName={project?.name} files={files}
        workspace={{
          available: !workspace && !!project && isGit && messages.length === 0 && !running,
          on: newWorkspace, onToggle: () => setNewWorkspace(v => !v),
          linkedBranch: resolved.state === "workspace" ? resolved.info.branch : workspace?.branch ?? undefined,
        }}
        provider={provider} selectedModel={selectedModel} modelName={modelName} supports={supports}
        running={running} onClarify={run.canClarify ? () => { void run.enqueue(true); } : undefined} mode={mode} onModeChange={setMode} onSend={() => run.send()} onStop={run.stop}
        contextTokens={contextTokens} lastInput={lastInput}
        canCompact={!(running || !loaded || messages.length < 4 || !provider)}
        canRestore={messages.some(m => m.meta?.compacted)}
        onCompact={run.compact} onRestore={run.restoreContext}
      />
      {autoMemory.found && chat && autoMemory.found.chatId === chat.id && <MemorySuggestDialog chat={chat} project={project ?? null} initial={autoMemory.found.suggestions} onClose={autoMemory.dismiss} />}
    </main>
    </CanvasWorkspace>
  );
}
