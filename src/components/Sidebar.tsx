import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Archive, Bell, ChevronDown, ChevronRight, Clock, FileDown, Folder, FolderOpen, FolderPlus, HelpCircle, Home, Import,
  LayoutList, LogOut, MoreHorizontal, Pencil, Pin, Plug, Search, Settings, SquarePen, TextSearch, Trash2, X, BarChart3, Languages,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "../i18n";
import { archiveChat, archiveProjectChats, removeProject, renameChat, renameProject, togglePin, type Chat, type Project } from "../lib/data";
import { useApp } from "../state";
import { runChatExport } from "./ImportPanel";
import { useMenu } from "./Menu";

function InlineEdit({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  return (
    <input
      className="input"
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

export function Rail({ onCreateProject }: { onCreateProject: () => void }) {
  const t = useT();
  const app = useApp();
  const menu = useMenu();
  const more = useMenu();
  return (
    <nav className="rail drag">
      <button className={`rail-btn${app.view === "chat" ? " active" : ""}`} title={t("home")} onClick={() => app.setView("chat")}>
        <Home size={17} />
      </button>
      <button className="rail-btn" title={t("toggleSidebar")} onClick={() => app.setSideHidden(!app.sideHidden)}>
        <Clock size={17} />
      </button>
      <button className="rail-btn" title={t("newProject")} onClick={onCreateProject}>
        <FolderPlus size={17} />
      </button>
      <button className="rail-btn" title="MCP" onClick={() => app.openSettings("mcp")}>
        <Plug size={17} />
      </button>
      <button
        className="rail-btn"
        title={t("more")}
        onClick={(e) =>
          more.open(e.currentTarget.getBoundingClientRect(), [
            { label: t("import"), icon: <Import size={15} />, onClick: () => app.openSettings("import") },
            { label: t("archivedChats"), icon: <Archive size={15} />, onClick: () => app.openSettings("archive") },
          ])
        }
      >
        <MoreHorizontal size={17} />
      </button>
      <div className="spacer" />
      <button className="rail-btn" title={t("help")} onClick={() => app.openSettings("general")}>
        <HelpCircle size={17} />
      </button>
      <button
        className="rail-btn"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          menu.open({ clientX: r.right + 6, clientY: r.top - 190 }, [
            { heading: "M Code" },
            { label: t("usage"), icon: <BarChart3 size={15} />, onClick: () => app.openSettings("usage") },
            { label: t("language"), icon: <Languages size={15} />, kbd: app.locale.toUpperCase(), onClick: () => app.setLocale(app.locale === "ru" ? "en" : "ru") },
            { label: t("settings"), icon: <Settings size={15} />, kbd: "⌘,", onClick: () => app.openSettings() },
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
  const [query, setQuery] = useState<string | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [recentLimit, setRecentLimit] = useState(8);
  const [recentOpen, setRecentOpen] = useState(true);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [showAll, setShowAll] = useState<Record<number, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState<string | null>(null);
  const [projectLimit, setProjectLimit] = useState(8);

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

  const openChat = (c: Chat) => {
    app.openChat(c.id, c.project_id);
    app.setView("chat");
  };
  const newChat = (projectId: number | null) => {
    app.newChat(projectId);
    app.setView("chat");
  };

  const chatMenu = (e: React.MouseEvent, c: Chat) => {
    e.preventDefault();
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
      ...(p.path ? [{ label: t("showInFinder"), icon: <FolderOpen size={15} />, onClick: () => revealItemInDir(p.path!) }] : []),
      { sep: true },
      { label: t("archiveChats"), icon: <Archive size={15} />, onClick: () => archiveProjectChats(p.id).then(app.reload) },
      { label: t("removeProject"), icon: <X size={15} />, onClick: () => removeProject(p.id).then(app.reload) },
    ]);

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
        onClick={() => openChat(c)}
        onContextMenu={(e) => chatMenu(e, c)}
      >
        <span className="label">{c.title}</span>
        {app.sessions.items.some(s => s.chatId === c.id && s.busy) && <span className="status-dot spin" aria-label={t("thinking")} style={{ background: "var(--accent)" }} />}
        <span className="actions">
          <button className="icon-btn" title={t("archive")} onClick={(e) => (e.stopPropagation(), archiveChat(c.id).then(app.reload))}>
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
    <aside className="sidebar">
      <div className="side-head drag">
        <div className="title">
          M Code <ChevronDown size={14} color="var(--text-2)" />
        </div>
        <span className="grow" />
        <button className="icon-btn" title={t("notifications")}>
          <Bell size={15} />
        </button>
        <button className="icon-btn" title={`${t("searchAllChats")} ⌘K`} aria-label={t("searchAllChats")} onClick={onSearch}>
          <TextSearch size={15} />
        </button>
        <button className="icon-btn" title={t("search")} onClick={() => setQuery(query === null ? "" : null)}>
          <Search size={15} />
        </button>
      </div>
      {query !== null && (
        <div className="side-search">
          <input className="input" autoFocus placeholder={t("searchChats")} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery(null)} />
        </div>
      )}
      <div className="side-scroll">
        <div className={`row${app.activeChat === null && app.draftProject === null && app.view === "chat" ? " active" : ""}`} onClick={() => newChat(null)}>
          <SquarePen size={15} />
          <span className="label">{t("newChat")}</span>
        </div>

        {app.sections.map((s) =>
          editing === `s${s.id}` ? (
            <div key={s.id} className="row">
              <InlineEdit value={s.name} onDone={(v) => (setEditing(null), v && app.setSections(app.sections.map((x) => (x.id === s.id ? { ...x, name: v } : x))))} />
            </div>
          ) : (
            <div key={s.id} className={`dropzone${dropOver === s.id ? " over" : ""}`} {...dropProps(s.id, (id) => app.setSections(app.sections.map((x) => (x.id === s.id ? { ...x, chatIds: [...new Set([...x.chatIds, id])] } : x))))}>
              <div className="section-title" onDoubleClick={() => setEditing(`s${s.id}`)}>
                <span style={{ flex: 1 }}>{s.name}</span>
                <button className="icon-btn" title={t("delete")} onClick={() => app.setSections(app.sections.filter((x) => x.id !== s.id))}>
                  <Trash2 size={13} />
                </button>
              </div>
              {s.chatIds.map((id) => chatById.get(id)).filter((c): c is Chat => !!c && match(c)).map((c) => chatRow(c, false))}
              {!s.chatIds.length && <div className="hint">{t("dragHere")}</div>}
            </div>
          ),
        )}
        <div className={`dropzone${dropOver === "new" ? " over" : ""}`} {...dropProps("new", (id) => app.setSections([...app.sections, { id: crypto.randomUUID(), name: t("newSection"), chatIds: [id] }]))}>
          <div className="row muted" onClick={addSection}>
            <span className="label">{t("newSection")}</span>
          </div>
          <div className="hint">{t("dragHere")}</div>
        </div>

        <div className="section-title" onClick={() => setProjectsOpen(!projectsOpen)}>
          {t("projects")} {projectsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>
        {projectsOpen &&
          projects.slice(0, projectLimit).map((p) => {
            const open = expanded[p.id] ?? true;
            const list = chatsOf(p.id);
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
                    onClick={() => setExpanded({ ...expanded, [p.id]: !open })}
                    onContextMenu={(e) => (e.preventDefault(), projectMenu(e, p))}
                  >
                    {open ? <FolderOpen size={15} /> : <Folder size={15} />}
                    <span className="label">{p.name}</span>
                    {!!p.pinned && <Pin size={11} color="var(--text-3)" />}
                    <span className="actions">
                      <button className="icon-btn" title={t("more")} onClick={(e) => (e.stopPropagation(), projectMenu(e.currentTarget.getBoundingClientRect(), p))}>
                        <MoreHorizontal size={14} />
                      </button>
                      <button className="icon-btn" title={t("newChatInProject")} onClick={(e) => (e.stopPropagation(), newChat(p.id))}>
                        <SquarePen size={14} />
                      </button>
                    </span>
                  </div>
                )}
                {open && shown.map((c) => chatRow(c, true))}
                {open && list.length > 5 && !showAll[p.id] && (
                  <div className="row child muted" onClick={() => setShowAll({ ...showAll, [p.id]: true })}>
                    {t("showMore")}
                  </div>
                )}
              </div>
            );
          })}
        {projectsOpen && projects.length > projectLimit && (
          <div className="row muted" onClick={() => setProjectLimit(projectLimit + 20)}>
            {t("showMore")}
          </div>
        )}
        {projectsOpen && !projects.length && (
          <div className="row muted" onClick={onCreateProject}>
            <FolderPlus size={15} />
            <span className="label">{t("newProject")}</span>
          </div>
        )}
        <div className="section-title" onClick={() => setRecentOpen(!recentOpen)}>
          {t("recent")} {recentOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>
        {(recentOpen || q) && app.chats.filter(c => !q || c.title.toLowerCase().includes(q.toLowerCase())).slice(0, q ? undefined : recentLimit).map((c) => chatRow(c, false))}
        {recentOpen && !q && app.chats.length > recentLimit && <button className="hint" onClick={() => setRecentLimit(n => n + 8)}>{t("showMore")}</button>}


      </div>
      {menu.node}
    </aside>
  );
}
