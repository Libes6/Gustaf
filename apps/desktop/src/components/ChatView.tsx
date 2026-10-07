import { QueuePanel } from "./chat/QueuePanel";
import { GoalBar } from "./chat/GoalBar";
import { PrWatchBar } from "./chat/PrWatchBar";
import { SecretCard } from "./chat/SecretCard";
import { fanOut } from "../lib/fanOut";
import { matches } from "../lib/shortcuts";
import { RESTART_SESSION_EVENT } from "./SearchPalette";
import { savedPosition, savePosition } from "../lib/readingPosition";
import { isScratch, loadScratch, scratchRoot, scratchVersion, subscribeScratch } from "../lib/scratch";
import { ArrowDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "../i18n";
import { requestTerminalCommand } from "../lib/terminalBridge";
import { onComposerDraft, takeComposerDraft } from "../lib/composerBridge";
import { effectiveHistory, estimateContext } from "../lib/context";
import { fsx } from "../lib/api";
import { loadMessages, type StoredMsg } from "../lib/data";
import { getAdapter } from "../providers";
import { levelsOf, textOf, type ModelInfo, type Part, type Reasoning } from "../providers/types";
import type { ChatSession } from "../lib/chatSessions";
import { groupTurns } from "../lib/chatTurns";
import { editableText, turnMessageIds } from "../lib/messageActions";
import { useChatRun } from "../lib/useChatRun";
import { useBackgroundTasks } from "../lib/useBackgroundTasks";
import { useInterruptedWork } from "../lib/useInterruptedWork";
import { useStopGuard } from "../lib/stopGuard";
import { getRuns, stopRun } from "../agent/agentRuns";
import { isActiveStatus } from "../agent/agentRunsModel";
import { useComposerDraft } from "../lib/useComposerDraft";
import { useMessageJump } from "../lib/useMessageJump";
import { turnHasMessage } from "../lib/searchUtil";
import { useApp } from "../state";
import { AgentsColumn, AgentsToggle } from "./AgentsPanel";
import { ChangesPanel } from "./ChangesPanel";
import { CanvasWorkspace } from "./CanvasWorkspace";
import { useChatMode } from "../lib/useChatMode";
import { useChatKnowledge } from "../lib/useChatKnowledge";
import { planToInstruction, type Plan } from "../agent/planCore";
import { chatWorkspace, resolveChatRoot } from "../lib/workspaces";
import { useIsGitProject, usePrefix, useWorkspaces } from "../lib/workspaceStore";
import { resolveReviewCopy } from "../lib/reviewCopy";
import { Composer } from "./chat/Composer";
import { BranchSwitcher } from "./chat/BranchSwitcher";
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
  // A scratch chat (no project, lib/scratch.ts) works in its own folder under the app data.
  const scratchV = useSyncExternalStore(subscribeScratch, scratchVersion);
  const [scratchDir, setScratchDir] = useState<string | null>(null);
  useEffect(() => { void loadScratch(); }, []);
  useEffect(() => {
    let live = true;
    setScratchDir(null);
    if (chat && chat.project_id === null && isScratch(chat.id)) scratchRoot(chat.id, chat.title).then((d) => live && setScratchDir(d), () => {});
    return () => { live = false; };
  }, [chat?.id, scratchV]);
  const root = resolved.root ?? scratchDir;
  const blocked = resolved.state === "pending" ? t("workspacePending") : resolved.state === "missing" ? t("workspaceMissing") : undefined;
  const [newWorkspace, setNewWorkspace] = useState(false);
  const reviewOn = resolveReviewCopy(app.reviewCopy);
  const isGit = useIsGitProject(projectRoot);
  const provider = app.providers.find((p) => p.id === app.selection?.providerId);
  const selectedModel = app.models.find(m => m.providerId === provider?.id && m.id === app.selection?.model);
  const contextTokens = estimateContext(effectiveHistory(messages), text);
  const lastInput = [...messages].reverse().find(m => m.meta?.provider === provider?.id && m.meta?.model === app.selection?.model && m.meta?.usage)?.meta?.usage?.input;
  const modelName = app.models.find((m) => m.providerId === provider?.id && m.id === app.selection?.model)?.name ?? app.selection?.model;
  const [supports, setSupports] = useState<{ computer: boolean; reasoning: boolean; levels?: readonly Reasoning[] }>({ computer: false, reasoning: false });

  const interrupted = useInterruptedWork(projectRoot);
  const tasks = useBackgroundTasks(root, interrupted.length);
  // Stopping the run also stops its background agents: ask first when some are mid-run.
  const stopGuard = useStopGuard(tasks.running, () => {
    for (const r of getRuns()) if (r.projectRoot === root && isActiveStatus(r.status)) stopRun(r.id);
  });
  // One prompt to several models, each in its own workspace chat running in the background (lib/fanOut.ts).
  const appRef = useRef(app);
  appRef.current = app;
  const [fanNotice, setFanNotice] = useState("");
  const startFanOut = (models: ModelInfo[]) => {
    const prompt = text.trim();
    if (!project?.path || !prompt) return;
    if (images.length) return setFanNotice(t("fanOutNoImages"));
    setText("");
    setFanNotice(t("fanOutStarted", { count: models.length }));
    void fanOut(() => appRef.current, {
      projectId: project.id, projectRoot: project.path, title: prompt.split("\n")[0].slice(0, 60), prompt,
      targets: models.map((m) => ({ providerId: m.providerId, model: m.id, name: m.name })),
      access: app.access === "readonly" ? "readonly" : "auto", signal: new AbortController().signal,
    }).then((results) => {
      const failed = results.filter((r) => r.status === "not-created" || r.status === "failed");
      if (failed.length) setFanNotice(failed.map((r) => t("fanOutFailed", { name: r.target.name, error: r.error ?? r.status })).join("\n"));
    });
  };
  const continueAgent = (message: string) => { setText((old) => (old.trim() ? `${old}\n\n${message}` : message)); taRef.current?.focus(); };
  // A draft requested from outside (the merge queue's "Resolve with agent") lands in this chat's message box; it is never sent.
  useEffect(() => {
    if (!visible || session.chatId === null) return;
    const take = () => { const d = takeComposerDraft(session.chatId); if (d) continueAgent(d); };
    take();
    return onComposerDraft(take);
  }, [visible, session.chatId]);
  const [mode, setMode] = useChatMode(session.chatId);
  const knowledge = useChatKnowledge(session.chatId);
  const run = useChatRun({
    session, visible, messages, setMessages, loaded, text, setText, images, setImages, draft,
    projectId: project?.id ?? null, root, files, provider, selectedModel, setAtBottom, mode,
    workspace, projectRoot, blocked, newWorkspace, onWorkspaceUsed: () => setNewWorkspace(false), confirmStop: stopGuard.confirmStop,
  });
  // "Restart agent session" from ⌘K is sent to the chat in front (SearchPalette dispatches RESTART_SESSION_EVENT).
  const [sessionNotice, setSessionNotice] = useState("");
  useEffect(() => {
    if (!visible) return;
    const restart = () => void run.restartSession().then((ok) => ok && setSessionNotice(t("sessionRestarted")));
    addEventListener(RESTART_SESSION_EVENT, restart);
    return () => removeEventListener(RESTART_SESSION_EVENT, restart);
  }, [visible, run.restartSession]);
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

  // Ids of the selected provider's models: Cursor decides effort support by an id's siblings (providers/reasoning.ts).
  const providerModelIds = useMemo(() => app.models.filter((m) => m.providerId === provider?.id).map((m) => m.id), [app.models, provider?.id]);
  useEffect(() => {
    let cancelled = false;
    const model = app.selection?.model;
    setSupports({ computer: false, reasoning: false });
    if (provider && model) {
      getAdapter(provider).then((a) => {
        if (cancelled) return;
        const levels = levelsOf(a, model, providerModelIds);
        setSupports({ computer: a.supportsComputer, reasoning: levels.length > 0, levels });
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [provider, app.selection?.model, providerModelIds]);

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

  // Reading position across restarts (lib/readingPosition.ts): restored once when the chat's messages first load,
  // unless a search result is being opened; saved while scrolling.
  const restored = useRef<number | null>(null);
  useEffect(() => {
    const el = feedRef.current;
    if (!el || !loaded || !session.chatId || restored.current === session.chatId || !messages.length) return;
    restored.current = session.chatId;
    const from = app.jump?.chatId === session.chatId ? null : savedPosition(session.chatId);
    if (from === null) return;
    requestAnimationFrame(() => {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - from);
      setAtBottom(false);
    });
  }, [loaded, session.chatId, messages.length]);
  // ⌘⌥↑ / ⌘⌥↓ (Ctrl+Alt elsewhere): previous / next of your messages in the visible chat.
  useEffect(() => {
    if (!visible) return;
    const key = (e: KeyboardEvent) => {
      if (!matches(e, "turnPrev") && !matches(e, "turnNext")) return;
      const feed = feedRef.current;
      if (!feed) return;
      const tops = [...feed.querySelectorAll<HTMLElement>(".msg-block[data-msg-id]")].map((el) => ({ el, top: el.offsetTop - feed.offsetTop }));
      const now = feed.scrollTop + 8;
      const target = e.key === "ArrowUp" ? [...tops].reverse().find((x) => x.top < now - 8) : tops.find((x) => x.top > now + 8);
      if (!target) return;
      e.preventDefault();
      feed.scrollTo({ top: target.top - 8, behavior: "smooth" });
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [visible]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rememberScroll = (el: HTMLDivElement) => {
    const id = session.chatId;
    if (!id || restored.current !== id) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => savePosition(id, el.scrollHeight - el.scrollTop - el.clientHeight), 400);
  };

  const turns = useMemo(() => groupTurns(messages), [messages]);
  // The last call of the running turn that has no result yet: it names the current action in the status line.
  const pendingCall = useMemo(() => {
    if (!running) return undefined;
    const done = new Set([...messages.flatMap((m) => m.parts), ...toolResults].filter((p) => p.type === "tool_result").map((p: any) => p.id));
    const calls = messages.slice(-4).flatMap((m) => m.parts).filter((p) => p.type === "tool_call" && !done.has(p.id));
    return calls[calls.length - 1] as Extract<Part, { type: "tool_call" }> | undefined;
  }, [running, messages, toolResults]);
  const canvasSources = useMemo(() => messages.filter((m) => m.role === "assistant").map(textOf), [messages]);

  return (
    <CanvasWorkspace sources={canvasSources} scope={session.key} onRepair={(prompt) => { setText(prompt); taRef.current?.focus(); }}
      aside={root && tasks.open ? <AgentsColumn root={root} projectRoot={projectRoot} interrupted={interrupted} tasks={tasks} onContinue={continueAgent} toggleRef={toggleRef} /> : undefined}>
    <main className="main">

      {stopGuard.node}
      {root && <AgentsToggle tasks={tasks} buttonRef={toggleRef} />}
      {root && project && <ChangesPanel reviewOn={workspace ? undefined : reviewOn} name={project.name} root={root} workspace={resolved.state === "workspace" && workspace && projectRoot ? { taskId: workspace.taskId, branch: resolved.info.branch, projectRoot } : undefined} busy={running} messages={messages} tick={run.tick} onChanged={run.bumpTick} onReplyToAgent={continueAgent} chatId={session.chatId} />}

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
        <div className="feed" ref={feedRef} role="log" aria-live="off" aria-label={t("conversation")} tabIndex={0} onScroll={(e) => { setAtBottom(e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 40); rememberScroll(e.currentTarget); }}>
          <div className="feed-inner">
            {turns.map((turn, i) => (
              <TurnView key={turn.user?.id ?? `t${i}`} turn={turn} liveResults={toolResults} live={running && i === turns.length - 1} onRewind={turn.user ? run.rewind : undefined} focusId={flashId != null && turnHasMessage(turn, flashId) ? flashId : null} busy={running} isLastTurn={i === turns.length - 1} handlers={turnHandlers} approving={!!approval} />
            ))}
            {blocked && <div className="error-box" role="alert">{blocked}</div>}
            <LiveStatus activities={activities} stream={stream} approval={approval} retryNotice={run.retryNotice} stats={run.live.current} visible={visible} onRunCommand={turnHandlers.onRunCommand} projectRoot={root ?? undefined} pendingCall={pendingCall} />
            {run.secretRequest && <SecretCard request={run.secretRequest} />}
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

      {sessionNotice && <div className="hint fan-notice" role="status">{sessionNotice}<button className="btn-ghost" onClick={() => setSessionNotice("")}>{t("cancel")}</button></div>}
      {fanNotice && <div className="hint fan-notice" role="status">{fanNotice}<button className="btn-ghost" onClick={() => setFanNotice("")}>{t("cancel")}</button></div>}
      <GoalBar chatId={session.chatId} running={running} />
      <PrWatchBar chatId={session.chatId} />
      {run.queue && <QueuePanel key={session.key} queue={run.queue} onChange={run.changeQueue} />}
      <Composer
        scopeKey={session.key} text={text} setText={setText} images={images} setImages={setImages} taRef={taRef} visible={visible}
        root={root} projectName={project?.name} files={files} knowledge={{ ...knowledge, onManage: () => app.openSettings("knowledge") }}
        workspace={{
          available: !workspace && !!project && isGit && messages.length === 0 && !running,
          on: newWorkspace, onToggle: () => setNewWorkspace(v => !v),
          linkedBranch: resolved.state === "workspace" ? resolved.info.branch : workspace?.branch ?? undefined,
        }}
        provider={provider} selectedModel={selectedModel} modelName={modelName} supports={supports}
        running={running} mode={mode} onModeChange={setMode} onSend={(opposite) => run.send(false, undefined, opposite === true)} followUp={run.followUp} onFanOut={startFanOut} onStop={run.requestStop}
        contextTokens={contextTokens} lastInput={lastInput}
        canCompact={!(running || !loaded || messages.length < 4 || !provider)}
        canRestore={messages.some(m => m.meta?.compacted)}
        onCompact={run.compact} onRestore={run.restoreContext}
      />
      {project && root && <BranchSwitcher root={root} running={running} worktree={!!workspace} visible={visible} onChanged={run.bumpTick} />}
      {autoMemory.found && chat && autoMemory.found.chatId === chat.id && <MemorySuggestDialog chat={chat} project={project ?? null} initial={autoMemory.found.suggestions} onClose={autoMemory.dismiss} />}
    </main>
    </CanvasWorkspace>
  );
}
