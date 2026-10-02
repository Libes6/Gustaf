import { Bot, Search, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { chatSearch, type SearchHit } from "../lib/api";
import { isSearchShortcut, moveHighlight, parseSnippet, RESULT_LIMIT, searchableQuery } from "../lib/searchUtil";
import { useApp } from "../state";
import "../styles/search.css";

const DEBOUNCE_MS = 180;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

/** Cmd+K palette: full-text search over every message (SQLite FTS5, see `search_messages` in db.rs). */
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const t = useT();
  const app = useApp();
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const debounced = useDebounced(query, DEBOUNCE_MS);
  const live = searchableQuery(query) !== null;

  useEffect(() => {
    let cancelled = false;
    chatSearch.models().then((m) => !cancelled && setModels(m)).catch(() => {});
    return () => {
      cancelled = true;
      requestRef.current++; // late answers are ignored once the palette is gone
    };
  }, []);

  // Typing is debounced; changing a filter searches right away. Only the latest request may update the list.
  useEffect(() => {
    const q = searchableQuery(debounced);
    const id = ++requestRef.current;
    if (!q) {
      setHits([]);
      setStatus("idle");
      setError("");
      return;
    }
    setStatus("loading");
    chatSearch
      .messages(q, { projectId, model, limit: RESULT_LIMIT })
      .then((result) => {
        if (id !== requestRef.current) return;
        setHits(result);
        setActive(0);
        setError("");
        setStatus("done");
      })
      .catch((e) => {
        if (id !== requestRef.current) return;
        setHits([]);
        setError(String(e instanceof Error ? e.message : e));
        setStatus("error");
      });
  }, [debounced, projectId, model]);

  useEffect(() => {
    document.getElementById(`search-hit-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, hits]);

  const dismiss = () => {
    onClose();
    previousFocus.current?.focus?.();
  };

  const open = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onClose();
    app.openChatAt(hit.chatId, hit.projectId, hit.messageId);
  };

  const shown = live ? hits : [];

  const onKeyDown = (e: React.KeyboardEvent) => {
    const inSelect = (e.target as HTMLElement).tagName === "SELECT";
    if (e.key === "Escape" || isSearchShortcut(e.nativeEvent)) {
      e.preventDefault();
      dismiss();
    } else if (e.key === "ArrowDown" && !inSelect) {
      e.preventDefault();
      setActive(moveHighlight(active, 1, shown.length));
    } else if (e.key === "ArrowUp" && !inSelect) {
      e.preventDefault();
      setActive(moveHighlight(active, -1, shown.length));
    } else if (e.key === "Enter" && !inSelect && !e.nativeEvent.isComposing) {
      e.preventDefault();
      open(shown[active]);
    } else if (e.key === "Tab") {
      // Keep focus inside the dialog.
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>("input, select") ?? [])];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length];
      if (next) (e.preventDefault(), next.focus());
    }
    // Shortcuts of the app (new chat, settings, approvals ...) must not fire behind the palette.
    e.stopPropagation();
  };

  const roleLabel = (role: string) => (role === "user" ? t("searchYou") : t("searchAssistant"));
  const searching = live && !shown.length && status !== "done" && status !== "error";
  const footer =
    status === "error" ? null
    : !live ? t("searchHint")
    : searching ? t("searchSearching")
    : !shown.length ? null
    : shown.length >= RESULT_LIMIT ? t("searchTopResults", { count: shown.length })
    : t("searchResults", { count: shown.length });

  return (
    <div className="overlay search-overlay" onMouseDown={(e) => e.target === e.currentTarget && dismiss()}>
      <div className="search-palette" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("searchAllChats")} onKeyDown={onKeyDown}>
        <div className="search-input">
          <Search size={16} />
          <input
            autoFocus
            role="combobox"
            aria-expanded={shown.length > 0}
            aria-controls="search-hits"
            aria-activedescendant={shown.length ? `search-hit-${active}` : undefined}
            aria-autocomplete="list"
            spellCheck={false}
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="search-filters">
          <select aria-label={t("searchProject")} value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t("searchAllProjects")}</option>
            {app.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select aria-label={t("searchModel")} value={model ?? ""} onChange={(e) => setModel(e.target.value || null)}>
            <option value="">{t("searchAllModels")}</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {model && !models.includes(model) && <option value={model}>{model}</option>}
          </select>
        </div>
        <div className="search-hits" id="search-hits" role="listbox" aria-label={t("searchAllChats")}>
          {status === "error" && (
            <div className="search-empty err" role="alert">
              {t("searchFailed", { error })}
            </div>
          )}
          {live && status === "done" && !shown.length && <div className="search-empty">{t("searchNoResults", { query: query.trim() })}</div>}
          {shown.map((hit, i) => (
            <div
              key={hit.messageId}
              id={`search-hit-${i}`}
              role="option"
              aria-selected={i === active}
              className={`search-hit${i === active ? " hl" : ""}`}
              onMouseMove={() => i !== active && setActive(i)}
              onClick={() => open(hit)}
            >
              <div className="search-hit-head">
                <span className="search-role" title={roleLabel(hit.role)}>
                  {hit.role === "user" ? <User size={13} /> : <Bot size={13} />}
                </span>
                <span className="search-title">{hit.chatTitle}</span>
                <span className="search-date">{t.date(hit.createdAt)}</span>
              </div>
              <div className="search-snippet">
                {parseSnippet(hit.snippet).map((part, j) => (part.hit ? <mark key={j}>{part.text}</mark> : <span key={j}>{part.text}</span>))}
              </div>
              <div className="search-meta">
                <span>{roleLabel(hit.role)}</span>
                <span>{hit.projectName ?? t("searchNoProject")}</span>
                {hit.model && <span>{hit.model}</span>}
                {hit.archived && <span className="search-badge">{t("searchArchived")}</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="search-foot" role="status">
          <span>{footer}</span>
          <span className="grow" />
          <span>{t("searchKeys")}</span>
        </div>
      </div>
    </div>
  );
}
