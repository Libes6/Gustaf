import { Bot, Search, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { chatSearch, type SearchHit } from "../lib/api";
import { arrowDown, isSearchShortcut, mergeHits, moveHighlight, PAGE_SIZE, parseSnippet, searchableQuery } from "../lib/searchUtil";
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
  const [more, setMore] = useState({ hasMore: false, total: 0, capped: false, byRecency: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  // What the visible list was searched with, and whether a next page is already requested.
  const searchedRef = useRef<{ q: string; projectId: number | null; model: string | null } | null>(null);
  const loadingMoreRef = useRef(false);
  const advanceRef = useRef<number | null>(null); // row to highlight when the requested page arrives
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
    loadingMoreRef.current = false;
    setLoadingMore(false);
    advanceRef.current = null;
    if (!q) {
      searchedRef.current = null;
      setHits([]);
      setMore({ hasMore: false, total: 0, capped: false, byRecency: false });
      setStatus("idle");
      setError("");
      return;
    }
    setStatus("loading");
    searchedRef.current = { q, projectId, model };
    chatSearch
      .messages(q, { projectId, model, limit: PAGE_SIZE, offset: 0 })
      .then((result) => {
        if (id !== requestRef.current) return;
        setHits(result.hits);
        setMore({ hasMore: result.hasMore, total: result.total, capped: result.totalCapped, byRecency: result.byRecency });
        setActive(0);
        setError("");
        setStatus("done");
      })
      .catch((e) => {
        if (id !== requestRef.current) return;
        setHits([]);
        setMore({ hasMore: false, total: 0, capped: false, byRecency: false });
        setError(String(e instanceof Error ? e.message : e));
        setStatus("error");
      });
  }, [debounced, projectId, model]);

  useEffect(() => {
    document.getElementById(`search-hit-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, hits]);

  // The next page of the current search. A new search (or closing the palette) bumps `requestRef`, so a late page is dropped.
  const loadMore = (advanceTo?: number) => {
    const searched = searchedRef.current;
    if (!searched || !more.hasMore || loadingMoreRef.current) return;
    const id = requestRef.current;
    loadingMoreRef.current = true;
    advanceRef.current = advanceTo ?? null;
    setLoadingMore(true);
    chatSearch
      .messages(searched.q, { projectId: searched.projectId, model: searched.model, limit: PAGE_SIZE, offset: hits.length })
      .then((result) => {
        if (id !== requestRef.current) return;
        loadingMoreRef.current = false;
        setLoadingMore(false);
        setHits((prev) => mergeHits(prev, result.hits));
        setMore({ hasMore: result.hasMore && result.hits.length > 0, total: result.total, capped: result.totalCapped, byRecency: result.byRecency });
        if (advanceRef.current !== null) setActive(advanceRef.current);
        advanceRef.current = null;
      })
      .catch((e) => {
        if (id !== requestRef.current) return;
        loadingMoreRef.current = false;
        setLoadingMore(false);
        advanceRef.current = null;
        setError(String(e instanceof Error ? e.message : e));
        setStatus("error");
      });
  };

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
      const step = arrowDown(active, shown.length, more.hasMore);
      if (step.loadMore) loadMore(shown.length);
      else setActive(step.next);
    } else if (e.key === "ArrowUp" && !inSelect) {
      e.preventDefault();
      setActive(moveHighlight(active, -1, shown.length));
    } else if (e.key === "Enter" && !inSelect && !e.nativeEvent.isComposing) {
      e.preventDefault();
      open(shown[active]);
    } else if (e.key === "Tab") {
      // Keep focus inside the dialog.
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>("input, select, button") ?? [])];
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
    : more.capped ? t("searchShowingCapped", { count: shown.length, total: more.total })
    : more.hasMore ? t("searchShowing", { count: shown.length, total: more.total })
    : t("searchResults", { count: shown.length });
  const currentProject = app.draftProject;

  return (
    <div className="overlay search-overlay" onMouseDown={(e) => e.target === e.currentTarget && dismiss()}>
      <div className="search-palette" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("searchAllChats")} onKeyDown={onKeyDown}>
        <div className="search-input">
          <Search size={16} />
          <input
            autoFocus
            aria-label={t("searchPlaceholder")}
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
          {currentProject !== null && (
            <label className="search-only">
              <input type="checkbox" checked={projectId === currentProject} onChange={(e) => setProjectId(e.target.checked ? currentProject : null)} />
              {t("searchOnlyProject")}
            </label>
          )}
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
        {live && status !== "error" && shown.length > 0 && more.hasMore && (
          <button type="button" className="search-more" disabled={loadingMore} onClick={() => loadMore()}>
            {loadingMore ? t("searchLoadingMore") : t("searchLoadMore")}
          </button>
        )}
        <div className="search-foot" role="status">
          <span>{footer}</span>
          {live && more.byRecency && shown.length > 0 && <span>{t("searchRecentFirst")}</span>}
          <span className="grow" />
          <span>{t("searchKeys")}</span>
        </div>
      </div>
    </div>
  );
}
