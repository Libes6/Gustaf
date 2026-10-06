import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Archive, Bell, ChevronDown, ChevronRight, Clock, FileDown, Folder, FolderOpen, FolderPlus, HelpCircle, Home, Import,
  Columns2, GitBranch, GitMerge, LayoutList, Loader2, LogOut, Share2, XCircle, MoreHorizontal, Pencil, Pin, ScrollText, Plug, Search, Settings, SquarePen, TextSearch, Trash2, X, BarChart3, Languages, Terminal,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useT } from "../i18n";
import { displayKeys, isMac, isWindows } from "../lib/platform";
import { archiveChat, archiveProjectChats, removeProject, renameChat, renameProject, togglePin, type Chat, type Project } from "../lib/data";
import { useApp } from "../state";
import { useApprovalChats, useChatFlags } from "../lib/attention";
import { deriveStatus, type ChatStatus } from "../lib/chatStatus";
import { getGoal, goalsVersion, subscribeGoals } from "../lib/goalStore";
import { getLiveChats, subscribeLiveRuns } from "../lib/liveRuns";
import { runChatExport } from "./ImportPanel";
import { useMenu } from "./Menu";
import { ProjectInstructionsDialog } from "./ProjectInstructionsDialog";
import { Brain, Flag } from "lucide-react";
import { useMemoryDialogs } from "./MemoryDialogs";
import { RailUpdateButton } from "./UpdaterPanel";
import { ShareHtmlDialog } from "./ShareHtmlDialog";
import { ConfirmDialog, NewWorkspaceDialog, useConfirm } from "./WorkspaceDialogs";
import { ConflictBadge } from "./ConflictBadge";
import { MergeQueueDialog, type QueueWorkspace } from "./MergeQueueDialog";
import { requestComposerDraft } from "../lib/composerBridge";
import type { QueueItem } from "../lib/mergeQueue";
import { conflictBadge, hasUnfinished, resolveDraft, summarizeQueue } from "../lib/mergeQueueView";
import { conflictReport, queueRun, useConflictChecks, useMergeQueueVersion, type QueuePolicy } from "../lib/mergeQueueStore";
import { requestTerminalOpen } from "../lib/terminalBridge";
import { archiveChoices, chatWorkspace, joinCheckout, splitWorkspaceChats, workspaceRow } from "../lib/workspaces";
import { createWorkspace, setupWorkspace } from "../lib/workspaceCreate";
import { isGitProject, refreshWorkspaces, repoPrefix, useWorkspacePolling, useWorkspaceVersion, workspaceEntry } from "../lib/workspaceStore";
import { parseWorktreeError, worktrees } from "../lib/worktrees";

function InlineEdit({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const t = useT();
  const [v, setV] = useState(value);
  return (
    <input
      className="input"
      aria-label={t("rename")}
      style={{ height: 24, padding: "0 6px" }}
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(v.trim() || null);
        if (e.key === "Escape") onDone(null);
      }}
    />
  );
}

/** Marks a chat whose goal is being worked on (`/goal`, lib/goalStore.ts). */
function GoalMark({ chatId }: { chatId: number }) {
  const t = useT();
  useSyncExternalStore(subscribeGoals, goalsVersion);
  if (getGoal(chatId)?.status !== "active") return null;
  return <span className="chat-goal-mark" role="img" aria-label={t("goal")} title={t("goal")}><Flag size={11} aria-hidden="true" /></span>;
}

/** One badge per chat, same size and slot for every state; each has an icon shape of its own and a text alternative. */
function ChatBadge({ status }: { status: ChatStatus | null }) {
  const t = useT();
  if (!status) return null;
  const label = t(status === "waiting" ? "approvalPendingBadge" : status === "running" ? "thinking" : status === "failed" ? "chatStatusFailed" : "chatStatusUnread");
  const common = { className: `chat-badge ${status}`, "aria-label": label, title: label };
  if (status === "running") return <span {...common} role="img"><Loader2 size={12} className="spin" aria-hidden="true" /></span>;
  if (status === "waiting") return <span {...common} role="status">!</span>;
  if (status === "failed") return <span {...common} role="status"><XCircle size={13} aria-hidden="true" /></span>;
  return <span {...common} role="img"><span className="dot" aria-hidden="true" /></span>;
}

export function Rail({ onCreateProject, onCompare }: { onCreateProject: () => void; onCompare: () => void }) {
  const t = useT();
  const app = useApp();
  const menu = useMenu();
  const more = useMenu();
  return (
    <nav className="rail drag" aria-label={t("navMain")}>
      <button className={`rail-btn${app.view === "chat" ? " active" : ""}`} title={t("home")} aria-label={t("home")} aria-current={app.view === "chat" ? "page" : undefined} onClick={() => app.setView("chat")}>
        <Home size={17} />
      </button>
      <button className="rail-btn" title={t("toggleSidebar")} aria-label={t("toggleSidebar")} aria-expanded={!app.sideHidden} onClick={() => app.setSideHidden(!app.sideHidden)}>
        <Clock size={17} />
      </button>
      <button className="rail-btn" title={t("newProject")} aria-label={t("newProject")} onClick={onCreateProject}>
        <FolderPlus size={17} />
      </button>
      <button className="rail-btn" title="MCP" aria-label="MCP" onClick={() => app.openSettings("mcp")}>
        <Plug size={17} />
      </button>
      <button
        className="rail-btn"
        title={t("more")}
        aria-label={t("more")}
        aria-haspopup="menu"
        onClick={(e) =>
          more.open(e.currentTarget.getBoundingClientRect(), [
            { label: t("compareTitle"), icon: <Columns2 size={15} />, onClick: onCompare },
            { label: t("import"), icon: <Import size={15} />, onClick: () => app.openSettings("import") },
            { label: t("archivedChats"), icon: <Archive size={15} />, onClick: () => app.openSettings("archive") },
          ])
        }
      >
        <MoreHorizontal size={17} />
      </button>
      <div className="spacer" />
      <button className="rail-btn" title={t("help")} aria-label={t("help")} onClick={() => app.openSettings("general")}>
        <HelpCircle size={17} />
      </button>
      <RailUpdateButton />
      <button
        className="rail-btn"
        aria-label={t("accountMenu")}
        onKeyDown={menu.onTriggerKeyDown}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          menu.open(r, [
            { heading: "Gustaf" },
            { label: t("usage"), icon: <BarChart3 size={15} />, onClick: () => app.openSettings("usage") },
            { label: t("language"), icon: <Languages size={15} />, kbd: app.locale.toUpperCase(), onClick: () => app.setLocale(app.locale === "ru" ? "en" : "ru") },
            { label: t("settings"), icon: <Settings size={15} />, kbd: displayKeys("⌘,"), onClick: () => app.openSettings() },
            { sep: true },
            { label: t("resetOnboarding"), icon: <LogOut size={15} />, onClick: () => app.setOnboarded(false) },
          ]);
        }}
      >
        <span className="avatar">M</span>
      </button>
      {menu.node}
      {more.node}
    </nav>
  );
}

export function Sidebar({ onCreateProject, onSearch }: { onCreateProject: () => void; onSearch: () => void }) {
  const t = useT();
  const app = useApp();
  const menu = useMenu();
  const waiting = useApprovalChats();
  const flags = useChatFlags();
  // Chats a scheduled run is writing to (also when they are not open as a session).
  const scheduledLive = useSyncExternalStore(subscribeLiveRuns, getLiveChats);
  const [query, setQuery] = useState<string | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [recentLimit, setRecentLimit] = useState(8);
  const [recentOpen, setRecentOpen] = useState(true);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [showAll, setShowAll] = useState<Record<number, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState<string | null>(null);
  const [projectLimit, setProjectLimit] = useState(8);
  const [instructionsFor, setInstructionsFor] = useState<Project | null>(null);
  const [sharing, setSharing] = useState<Chat | null>(null);
  const memoryUi = useMemoryDialogs();
  // Workspaces (git worktrees): the data lives in lib/workspaceStore.ts; this component re-renders when it changes.
  useWorkspaceVersion();
  useMergeQueueVersion();
  const confirm = useConfirm();
  // Merge queue dialog: for a whole project, optionally with one workspace preselected ("Merge into <target>…").
  const [mergeFor, setMergeFor] = useState<{ project: Project; preselect: string | null } | null>(null);
  const [newWorkspaceFor, setNewWorkspaceFor] = useState<Project | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [dirtyArchive, setDirtyArchive] = useState<{ project: Project; chat: Chat } | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState("");
  // Projects that are git repositories (offered "New workspace…"); asked once per project (cached).
  const [gitProjects, setGitProjects] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => {
    let cancelled = false;
    for (const p of app.projects.slice(0, 40)) {
      if (p.path) isGitProject(p.path).then((ok) => { if (ok && !cancelled) setGitProjects((s) => (s.has(p.id) ? s : new Set(s).add(p.id))); });
    }
    return () => { cancelled = true; };
  }, [app.projects]);

  const q = query?.toLowerCase() ?? "";
  const chatsByProject = useMemo(() => {
    const groups = new Map<number | null, Chat[]>();
    for (const chat of app.chats) {
      if (q && !chat.title.toLowerCase().includes(q)) continue;
      const group = groups.get(chat.project_id);
      if (group) group.push(chat);
      else groups.set(chat.project_id, [chat]);
    }
    return groups;
  }, [app.chats, q]);
  const match = (c: Chat) => !q || c.title.toLowerCase().includes(q);
  const chatsOf = (pid: number | null) => chatsByProject.get(pid) ?? [];
  // Polled while a project is expanded (and again when a run starts or ends): only projects that have workspace chats.
  const workspaceRoots = useMemo(
    () => app.projects.filter((p) => p.path && (expanded[p.id] ?? true) && app.chats.some((c) => c.project_id === p.id && chatWorkspace(c))).map((p) => p.path!),
    [app.projects, app.chats, expanded],
  );
  const busyKey = app.sessions.items.filter((s) => s.busy).map((s) => s.chatId).join(",");
  useWorkspacePolling(workspaceRoots, busyKey);
  // Conflict badges: throttled and never awaited by the render (see lib/mergeQueueStore.ts).
  useConflictChecks(workspaceRoots.map((root) => ({ root, list: workspaceEntry(root).list })), busyKey);

  const openChat = (c: Chat) => {
    app.openChat(c.id, c.project_id);
    app.setView("chat");
  };
  const newChat = (projectId: number | null) => {
    app.newChat(projectId);
    app.setView("chat");
  };

  const chatMenu = (e: React.MouseEvent | DOMRect, c: Chat) => {
    if ("preventDefault" in e) e.preventDefault();
    menu.open(e, [
      { label: t("rename"), icon: <Pencil size={15} />, onClick: () => setEditing(`c${c.id}`) },
      ...app.sections.map((s) => ({
        label: t("addToSection", { name: s.name }),
        icon: <LayoutList size={15} />,
        onClick: () => app.setSections(app.sections.map((x) => (x.id === s.id ? { ...x, chatIds: [...new Set([...x.chatIds, c.id])] } : x))),
      })),
      { sep: true },
      { label: t("exportMarkdown"), icon: <FileDown size={15} />, onClick: () => void runChatExport([c], "markdown", t) },
      { label: t("exportJson"), icon: <FileDown size={15} />, onClick: () => void runChatExport([c], "json", t) },
      { label: t("shareHtml"), icon: <Share2 size={15} />, onClick: () => setSharing(c) },
      { label: t("memorySuggestMenu"), icon: <Brain size={15} />, onClick: () => memoryUi.openSuggest(c) },
      { sep: true },
      { label: t("archive"), icon: <Archive size={15} />, onClick: () => archiveChat(c.id).then(app.reload) },
    ]);
  };

  const projectMenu = (anchor: DOMRect | React.MouseEvent, p: Project) =>
    menu.open("clientX" in anchor ? anchor : anchor, [
      { label: p.pinned ? t("unpin") : t("pin"), icon: <Pin size={15} />, onClick: () => togglePin(p.id).then(app.reload) },
      { label: t("edit"), icon: <Pencil size={15} />, onClick: () => setEditing(`p${p.id}`) },
      ...(app.sections.length ? [{ heading: t("section") }] : []),
      ...app.sections.map((s) => ({
        label: s.name,
        icon: <LayoutList size={15} />,
        onClick: () =>
          app.setSections(app.sections.map((x) => (x.id === s.id ? { ...x, chatIds: [...new Set([...x.chatIds, ...chatsOf(p.id).map((c) => c.id)])] } : x))),
      })),
      ...(p.path && gitProjects.has(p.id) ? [{ label: t("workspaceNew"), icon: <GitBranch size={15} />, onClick: () => (setWorkspaceError(""), setNewWorkspaceFor(p)) }] : []),
      ...(p.path && gitProjects.has(p.id) && chatsOf(p.id).some((c) => chatWorkspace(c)) ? [{ label: t("mqMenu"), icon: <GitMerge size={15} />, onClick: () => setMergeFor({ project: p, preselect: null }) }] : []),
      ...(p.path ? [{ label: t("projectInstructions"), icon: <ScrollText size={15} />, onClick: () => setInstructionsFor(p) }] : []),
      ...(p.path ? [{ label: t("memoryMenu"), icon: <Brain size={15} />, onClick: () => memoryUi.openProject(p) }] : []),
      ...(p.path ? [{ label: t(isMac() ? "showInFinder" : isWindows() ? "showInExplorer" : "showInFileManager"), icon: <FolderOpen size={15} />, onClick: () => revealItemInDir(p.path!) }] : []),
      { sep: true },
      { label: t("archiveChats"), icon: <Archive size={15} />, onClick: () => archiveProjectChats(p.id).then(app.reload) },
      { label: t("removeProject"), icon: <X size={15} />, onClick: () => removeProject(p.id).then(app.reload) },
    ]);

  const statusOf = (c: Chat) =>
    deriveStatus({
      waiting: waiting.has(c.id),
      running: scheduledLive.has(c.id) || app.sessions.items.some((s) => s.chatId === c.id && s.busy),
      failed: flags.failed.has(c.id),
      unread: flags.unread.has(c.id),
    });

  // ---- workspaces ----
  const startWorkspace = async (p: Project, title: string) => {
    if (!p.path || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceError("");
    try {
      const made = await createWorkspace({ projectId: p.id, root: p.path, title, provider: app.selection?.providerId, model: app.selection?.model });
      if (!made.ok) return setWorkspaceError(made.fallback ? t("workspaceFallback", { reason: made.message }) : t("workspaceFailed", { message: made.message }));
      const problem = await setupWorkspace(p.path, made, {
        access: app.access, allowlist: app.allowlist,
        approve: (command) => confirm.ask({ title: t("workspaceSetupAskTitle"), body: <><p>{t("workspaceSetupAskBody")}</p><code>{command}</code></>, confirmLabel: t("workspaceSetupRun"), cancelLabel: t("workspaceSetupSkip") }),
      }, t);
      setWorkspaceNotice(problem);
      setNewWorkspaceFor(null);
      await app.reload();
      app.openChat(made.chatId, p.id);
      app.setView("chat");
    } finally { setWorkspaceBusy(false); }
  };

  const archiveWorkspace = async (p: Project, c: Chat, o: { force?: boolean; deleteBranch?: boolean } = {}) => {
    const ws = chatWorkspace(c);
    if (!p.path || !ws) return;
    setWorkspaceNotice("");
    try {
      const r = await worktrees.remove({ root: p.path, taskId: ws.taskId, force: o.force, deleteBranch: o.deleteBranch });
      if (o.deleteBranch && r.branchKeptReason) setWorkspaceNotice(t("workspaceBranchKept", { branch: ws.branch ?? ws.taskId, reason: r.branchKeptReason }));
    } catch (e) {
      const err = parseWorktreeError(e);
      if (err.code === "dirty" && !o.force) return setDirtyArchive({ project: p, chat: c });
      // Already gone is as good as archived.
      if (err.code !== "not_found") setWorkspaceNotice(t("workspaceArchiveFailed", { message: err.message }));
    }
    await refreshWorkspaces(p.path, { force: true });
  };

  const openInTerminal = async (p: Project, c: Chat, checkout: string) => {
    openChat(c);
    requestTerminalOpen(joinCheckout(checkout, p.path ? await repoPrefix(p.path) : ""));
  };

  const workspaceMenu = (anchor: DOMRect | React.MouseEvent, p: Project, c: Chat) => {
    if ("preventDefault" in anchor) anchor.preventDefault();
    const ws = chatWorkspace(c);
    const info = ws ? workspaceEntry(p.path).list?.find((w) => w.taskId === ws.taskId) : undefined;
    const choice = archiveChoices(info);
    menu.open(anchor, [
      { label: t("rename"), icon: <Pencil size={15} />, onClick: () => setEditing(`c${c.id}`) },
      ...(info && choice.canArchive ? [
        { label: t("workspaceOpenTerminal"), icon: <Terminal size={15} />, onClick: () => void openInTerminal(p, c, info.path) },
        { label: t(isMac() ? "showInFinder" : isWindows() ? "showInExplorer" : "showInFileManager"), icon: <FolderOpen size={15} />, onClick: () => revealItemInDir(info.path) },
        { label: t("mqMergeInto", { target: info.baseBranch ?? t("mqTargetFallback") }), icon: <GitMerge size={15} />, onClick: () => setMergeFor({ project: p, preselect: ws!.taskId }) },
        { sep: true as const },
        { label: t("workspaceArchive"), icon: <Archive size={15} />, onClick: () => void archiveWorkspace(p, c) },
        ...(choice.offerDeleteBranch ? [{ label: t("workspaceArchiveDelete"), icon: <Archive size={15} />, onClick: () => void archiveWorkspace(p, c, { deleteBranch: true }) }] : []),
      ] : []),
      { sep: true },
      { label: t("archive"), icon: <Archive size={15} />, onClick: () => archiveChat(c.id).then(app.reload) },
    ]);
  };

  const workspaceRowEl = (p: Project, c: Chat) => {
    const ws = chatWorkspace(c)!;
    const entry = workspaceEntry(p.path);
    const info = entry.list?.find((w) => w.taskId === ws.taskId);
    const row = workspaceRow(c, info, !!entry.list)!;
    const current = app.activeChat === c.id && app.view === "chat";
    if (editing === `c${c.id}`) {
      return (
        <div key={c.id} className="row workspace">
          <InlineEdit value={c.title} onDone={(v) => (setEditing(null), v && renameChat(c.id, v).then(app.reload))} />
        </div>
      );
    }
    const badge = row.active ? conflictBadge(conflictReport(p.path, ws.taskId)) : null;
    return (
      <Fragment key={c.id}>
      <div className={`row workspace${row.active ? "" : " gone"}${current ? " active" : ""}`} data-workspace={row.taskId} onContextMenu={(e) => workspaceMenu(e, p, c)}>
        <button className="row-main" aria-current={current ? "page" : undefined} onClick={() => openChat(c)}>
          <span className="ws-branch">
            <GitBranch size={13} aria-hidden="true" />
            <span className="label">{c.title}</span>
            <GoalMark chatId={c.id} /><ChatBadge status={statusOf(c)} />
          </span>
          <span className="ws-meta">
            <span className="branch" title={row.branch}>{row.branch}</span>
            {!row.active ? <span>{t("workspaceArchived")}</span> : (
              <>
                {row.dirty && <span className="dirty" role="img" aria-label={t("workspaceChanged", { count: row.changedFiles ?? 0 })} />}
                {row.sync && <span className="sync" title={t("workspaceSyncTitle", { ahead: row.ahead ?? 0, behind: row.behind ?? 0, base: info?.baseBranch ?? "base" })}>{row.sync}</span>}
                {!!row.changedFiles && <span className="changed">{t("workspaceChanged", { count: row.changedFiles })}</span>}
              </>
            )}
          </span>
        </button>
        <span className="actions">
          <button className="icon-btn" title={t("more")} aria-label={t("workspaceMenu", { title: c.title })} aria-haspopup="menu" onClick={(e) => (e.stopPropagation(), workspaceMenu(e.currentTarget.getBoundingClientRect(), p, c))}>
            <MoreHorizontal size={14} />
          </button>
        </span>
      </div>
      {badge && <div className="ws-conflict-line"><ConflictBadge badge={badge} title={c.title} /></div>}
      </Fragment>
    );
  };

  // ---- merge queue ----
  const queuePolicy = (): QueuePolicy => ({ access: app.access, allowlist: app.allowlist, texts: { declined: t("mqTestDeclined"), blocked: t("mqTestBlocked") } });
  const queueWorkspaces = (p: Project): QueueWorkspace[] => {
    const list = workspaceEntry(p.path).list ?? [];
    return chatsOf(p.id).filter((c) => chatWorkspace(c)).flatMap((c) => {
      const info = list.find((w) => w.taskId === c.workspace_task_id);
      return info ? [{ taskId: info.taskId, title: c.title, branch: info.branch, target: info.baseBranch, ahead: info.ahead, dirty: info.dirty, active: info.existsOnDisk }] : [];
    });
  };
  const resolveConflicts = (p: Project, item: QueueItem) => {
    const c = app.chats.find((x) => x.project_id === p.id && x.workspace_task_id === item.taskId);
    if (!c) return;
    requestComposerDraft(c.id, resolveDraft({ target: item.targetBranch, files: item.conflicts, testCommand: item.testCommand, t }));
    setMergeFor(null);
    openChat(c);
  };
  const archiveMerged = (p: Project, taskId: string) => {
    const c = app.chats.find((x) => x.project_id === p.id && x.workspace_task_id === taskId);
    if (c) void archiveWorkspace(p, c);
  };

  const chatRow = (c: Chat, child: boolean) =>
    editing === `c${c.id}` ? (
      <div key={c.id} className={`row${child ? " child" : ""}`}>
        <InlineEdit value={c.title} onDone={(v) => (setEditing(null), v && renameChat(c.id, v).then(app.reload))} />
      </div>
    ) : (
      <div
        key={c.id}
        className={`row${child ? " child" : ""}${app.activeChat === c.id && app.view === "chat" ? " active" : ""}`}
        draggable
        onDragStart={(e) => e.dataTransfer.setData("text/chat", String(c.id))}
        onContextMenu={(e) => chatMenu(e, c)}
      >
        <button className="row-main" aria-current={app.activeChat === c.id && app.view === "chat" ? "page" : undefined} onClick={() => openChat(c)}>
          <span className="label">{c.title}</span>
          <GoalMark chatId={c.id} /><ChatBadge status={statusOf(c)} />
        </button>
        <span className="actions">
          <button className="icon-btn" title={t("more")} aria-label={t("more")} aria-haspopup="menu" onClick={(e) => (e.stopPropagation(), chatMenu(e.currentTarget.getBoundingClientRect(), c))}>
            <MoreHorizontal size={14} />
          </button>
          <button className="icon-btn" title={t("archive")} aria-label={t("archive")} onClick={(e) => (e.stopPropagation(), archiveChat(c.id).then(app.reload))}>
            <Archive size={14} />
          </button>
        </span>
      </div>
    );

  const dropProps = (key: string, onDrop: (chatId: number) => void) => ({
    onDragOver: (e: React.DragEvent) => (e.preventDefault(), setDropOver(key)),
    onDragLeave: () => setDropOver(null),
    onDrop: (e: React.DragEvent) => {
      setDropOver(null);
      const id = Number(e.dataTransfer.getData("text/chat"));
      if (id) onDrop(id);
    },
  });

  const addSection = () => app.setSections([...app.sections, { id: crypto.randomUUID(), name: t("newSection"), chatIds: [] }]);
  const chatById = useMemo(() => new Map(app.chats.map((c) => [c.id, c])), [app.chats]);
  const projects = app.projects.filter((p) => !q || p.name.toLowerCase().includes(q) || chatsOf(p.id).length);

  return (
    <aside className="sidebar" aria-label={t("sidebar")}>
      <div className="side-head drag">
        <div className="title">
          Gustaf <ChevronDown size={14} color="var(--text-2)" />
        </div>
        <span className="grow" />
        <button className="icon-btn" title={t("notifications")} aria-label={t("notifications")}>
          <Bell size={15} />
        </button>
        <button className="icon-btn" title={`${t("searchAllChats")} ⌘K`} aria-label={t("searchAllChats")} onClick={onSearch}>
          <TextSearch size={15} />
        </button>
        <button className="icon-btn" title={t("search")} aria-label={t("search")} aria-expanded={query !== null} onClick={() => setQuery(query === null ? "" : null)}>
          <Search size={15} />
        </button>
      </div>
      {query !== null && (
        <div className="side-search">
          <input className="input" autoFocus aria-label={t("searchChats")} placeholder={t("searchChats")} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery(null)} />
        </div>
      )}
      <div className="side-scroll">
        <button className={`row${app.activeChat === null && app.draftProject === null && app.view === "chat" ? " active" : ""}`} onClick={() => newChat(null)}>
          <SquarePen size={15} />
          <span className="label">{t("newChat")}</span>
        </button>

        {app.sections.map((s) =>
          editing === `s${s.id}` ? (
            <div key={s.id} className="row">
              <InlineEdit value={s.name} onDone={(v) => (setEditing(null), v && app.setSections(app.sections.map((x) => (x.id === s.id ? { ...x, name: v } : x))))} />
            </div>
          ) : (
            <div key={s.id} className={`dropzone${dropOver === s.id ? " over" : ""}`} {...dropProps(s.id, (id) => app.setSections(app.sections.map((x) => (x.id === s.id ? { ...x, chatIds: [...new Set([...x.chatIds, id])] } : x))))}>
              <div className="section-title" onDoubleClick={() => setEditing(`s${s.id}`)}>
                <span style={{ flex: 1 }}>{s.name}</span>
                <button className="icon-btn" title={t("delete")} aria-label={t("delete")} onClick={() => app.setSections(app.sections.filter((x) => x.id !== s.id))}>
                  <Trash2 size={13} />
                </button>
              </div>
              {s.chatIds.map((id) => chatById.get(id)).filter((c): c is Chat => !!c && match(c)).map((c) => chatRow(c, false))}
              {!s.chatIds.length && <div className="hint">{t("dragHere")}</div>}
            </div>
          ),
        )}
        <div className={`dropzone${dropOver === "new" ? " over" : ""}`} {...dropProps("new", (id) => app.setSections([...app.sections, { id: crypto.randomUUID(), name: t("newSection"), chatIds: [id] }]))}>
          <button className="row muted" onClick={addSection}>
            <span className="label">{t("newSection")}</span>
          </button>
          <div className="hint">{t("dragHere")}</div>
        </div>

        <button className="section-title" aria-expanded={projectsOpen} onClick={() => setProjectsOpen(!projectsOpen)}>
          {t("projects")} {projectsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        {projectsOpen &&
          projects.slice(0, projectLimit).map((p) => {
            const open = expanded[p.id] ?? true;
            const { plain: list, workspaces } = splitWorkspaceChats(chatsOf(p.id));
            const shown = showAll[p.id] ? list : list.slice(0, 5);
            return (
              <div key={p.id}>
                {editing === `p${p.id}` ? (
                  <div className="row">
                    <InlineEdit value={p.name} onDone={(v) => (setEditing(null), v && renameProject(p.id, v).then(app.reload))} />
                  </div>
                ) : (
                  <div
                    className={`row${menu.isOpen ? "" : ""}${app.draftProject === p.id && app.activeChat === null && app.view === "chat" ? " active" : ""}`}
                    onContextMenu={(e) => (e.preventDefault(), projectMenu(e, p))}
                  >
                    <button className="row-main" aria-expanded={open} onClick={() => setExpanded({ ...expanded, [p.id]: !open })}>
                      {open ? <FolderOpen size={15} /> : <Folder size={15} />}
                      <span className="label">{p.name}</span>
                      {!!p.pinned && <Pin size={11} color="var(--text-3)" aria-label={t("pin")} role="img" />}
                    </button>
                    <span className="actions">
                      <button className="icon-btn" title={t("more")} aria-label={t("more")} aria-haspopup="menu" onClick={(e) => (e.stopPropagation(), projectMenu(e.currentTarget.getBoundingClientRect(), p))}>
                        <MoreHorizontal size={14} />
                      </button>
                      <button className="icon-btn" title={t("newChatInProject")} aria-label={t("newChatInProject")} onClick={(e) => (e.stopPropagation(), newChat(p.id))}>
                        <SquarePen size={14} />
                      </button>
                    </span>
                  </div>
                )}
                {open && shown.map((c) => chatRow(c, true))}
                {open && workspaces.length > 0 && (
                  <div role="group" aria-label={t("workspaceGroup", { name: p.name })}>{workspaces.map((c) => workspaceRowEl(p, c))}</div>
                )}
                {open && p.path && (() => {
                  const q = queueRun(p.path);
                  if (!(q.busy || q.approval || hasUnfinished(q.state))) return null;
                  const sum = summarizeQueue(q.state);
                  return (
                    <button className="row child muted mq-active" onClick={() => setMergeFor({ project: p, preselect: null })}>
                      <GitMerge size={13} aria-hidden="true" />
                      <span className="label">{q.approval ? t("mqSidebarApproval") : q.state?.halted ? t("mqSidebarHalted") : t("mqSidebarActive", { merged: sum.merged, total: sum.total })}</span>
                    </button>
                  );
                })()}
                {open && list.length > 5 && !showAll[p.id] && (
                  <button className="row child muted" onClick={() => setShowAll({ ...showAll, [p.id]: true })}>
                    {t("showMore")}
                  </button>
                )}
              </div>
            );
          })}
        {projectsOpen && projects.length > projectLimit && (
          <button className="row muted" onClick={() => setProjectLimit(projectLimit + 20)}>
            {t("showMore")}
          </button>
        )}
        {projectsOpen && !projects.length && (
          <button className="row muted" onClick={onCreateProject}>
            <FolderPlus size={15} />
            <span className="label">{t("newProject")}</span>
          </button>
        )}
        <button className="section-title" aria-expanded={recentOpen} onClick={() => setRecentOpen(!recentOpen)}>
          {t("recent")} {recentOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        {(recentOpen || q) && app.chats.filter(c => !q || c.title.toLowerCase().includes(q.toLowerCase())).slice(0, q ? undefined : recentLimit).map((c) => chatRow(c, false))}
        {recentOpen && !q && app.chats.length > recentLimit && <button className="hint" onClick={() => setRecentLimit(n => n + 8)}>{t("showMore")}</button>}


      </div>
      {menu.node}
      {workspaceNotice && (
        <div className="hint" role="status" style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <span style={{ flex: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{workspaceNotice}</span>
          <button className="icon-btn" title={t("dismiss")} aria-label={t("dismiss")} onClick={() => setWorkspaceNotice("")}><X size={13} /></button>
        </div>
      )}
      {confirm.node}
      {newWorkspaceFor && <NewWorkspaceDialog projectName={newWorkspaceFor.name} busy={workspaceBusy} error={workspaceError} onCancel={() => setNewWorkspaceFor(null)} onCreate={(title) => void startWorkspace(newWorkspaceFor, title)} />}
      {dirtyArchive && (
        <ConfirmDialog title={t("workspaceArchiveDirtyTitle")} confirmLabel={t("workspaceArchiveAnyway")} danger onCancel={() => setDirtyArchive(null)}
          onConfirm={() => { const d = dirtyArchive; setDirtyArchive(null); void archiveWorkspace(d.project, d.chat, { force: true }); }}>
          <p>{t("workspaceArchiveDirtyBody", { branch: dirtyArchive.chat.workspace_branch ?? dirtyArchive.chat.workspace_task_id ?? "" })}</p>
        </ConfirmDialog>
      )}
      {mergeFor?.project.path && (
        <MergeQueueDialog root={mergeFor.project.path} projectName={mergeFor.project.name} workspaces={queueWorkspaces(mergeFor.project)} preselect={mergeFor.preselect} policy={queuePolicy()}
          onClose={() => setMergeFor(null)} onResolve={(item) => resolveConflicts(mergeFor.project, item)} onArchive={(id) => archiveMerged(mergeFor.project, id)} />
      )}
      {sharing && <ShareHtmlDialog chat={sharing} onClose={() => setSharing(null)} />}
      {memoryUi.node}
      {instructionsFor?.path && <ProjectInstructionsDialog name={instructionsFor.name} path={instructionsFor.path} onClose={() => setInstructionsFor(null)} />}
    </aside>
  );
}
