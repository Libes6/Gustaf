import { Check, ChevronDown, ChevronRight, RotateCw, Search, Settings2, Star } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { cmdKey } from "../lib/shortcuts";
import { displayKeys } from "../lib/platform";
import { useDialogFocus } from "../lib/useDialogFocus";
import { orderProviders } from "../providers/drivers";
import { modelKey as favKey, useApp, type Model } from "../state";
import { ModelIcon } from "./ModelIcon";
import { ProviderIcon } from "./ProviderIcon";

const NEW_MS = 14 * 24 * 3600_000;
const VISIBLE = 8;
/** Entries a CLI adds to its list itself; they never count as models the provider "added". */
const SYNTHETIC = new Set(["default", "auto"]);

/**
 * Models that appeared after the provider's first real listing, within the last two weeks. The first listing is the
 * earliest `firstSeen` of the provider's real models, so a provider whose first answer was only `default` (Codex) does
 * not mark its whole list as new when the full list arrives.
 */
export function newModelKeys(models: Model[], now = Date.now()): Set<string> {
  const baseline = new Map<string, number>();
  for (const m of models)
    if (!SYNTHETIC.has(m.id)) baseline.set(m.providerId, Math.min(baseline.get(m.providerId) ?? Infinity, m.firstSeen));
  return new Set(
    models
      .filter(
        (m) =>
          !SYNTHETIC.has(m.id) && m.firstSeen > (baseline.get(m.providerId) ?? Infinity) && now - m.firstSeen < NEW_MS,
      )
      .map(favKey),
  );
}

/** `200K`, `1M`: the context window as a short label. */
export const contextLabel = (tokens?: number) =>
  !tokens ? "" : tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`;

/** Several models for one prompt (T7): shift-click toggles a model in `keys` instead of choosing it. */
export type MultiPick = { keys: string[]; toggle: (m: Model) => void; max: number };

export function ModelPicker({ onClose, multi }: { onClose: () => void; multi?: MultiPick }) {
  const t = useT();
  const app = useApp();
  const selKey = app.selection ? favKey({ providerId: app.selection.providerId, id: app.selection.model }) : "";
  // Open where the current model is: favourites when it is starred, else its provider's tab.
  const [tab, setTab] = useState<string>(() =>
    selKey && app.favorites.includes(selKey)
      ? "fav"
      : (app.selection?.providerId ?? (app.favorites.length ? "fav" : (app.providers[0]?.id ?? "fav"))),
  );
  const [q, setQ] = useState("");
  const [more, setMore] = useState(false);
  const [hl, setHl] = useState(0);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Only keyboard moves scroll the list; a hover that scrolled would move the rows under the pointer.
  const scrollToHl = useRef(false);
  useDialogFocus(ref, onClose);
  const kindOf = (id: string) => app.providers.find((p) => p.id === id)?.kind ?? "custom";
  const nameOf = (id: string) => app.providers.find((p) => p.id === id)?.name ?? id;

  // Same order as the providers page: Claude, GPT / Codex, Cursor, Grok, then the rest.
  const providers = orderProviders(app.providers.filter((p) => !p.disabled));
  const rank = new Map(providers.map((p, i) => [p.id, i]));
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const models = app.models.filter((m) => !app.hiddenModels.includes(favKey(m)));
    let ms = s
      ? models.filter((m) => m.id.toLowerCase().includes(s) || m.name.toLowerCase().includes(s))
      : tab === "fav"
        ? models.filter((m) => app.favorites.includes(favKey(m)))
        : models.filter((m) => m.providerId === tab);
    // Grouped by provider (pinned order) when several providers are listed (search, favourites), newest first within each.
    ms = [...ms].sort(
      (a, b) =>
        (rank.get(a.providerId) ?? 1e9) - (rank.get(b.providerId) ?? 1e9) ||
        b.created - a.created ||
        a.name.localeCompare(b.name),
    );
    return ms;
  }, [app.models, app.favorites, app.hiddenModels, app.providers, tab, q]);
  const visible = more || q ? list : list.slice(0, VISIBLE);

  const fresh = useMemo(() => newModelKeys(app.models), [app.models]);
  // The picker opens upwards from the composer; in a short window it shrinks instead of leaving the top edge.
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r && r.top < 8) setHeight(Math.max(200, r.height - (8 - r.top)));
  }, []);

  const pick = (m: Model) => {
    app.setSelection({ providerId: m.providerId, model: m.id });
    onClose();
  };

  // Outside clicks close the picker. The listener is added after the opening click has finished; the timer is cancelled
  // on unmount, otherwise a picker closed before it fired (or React's double mount in dev) left a listener whose `ref` is
  // empty, and it closed every later picker on any click, even inside it.
  useEffect(() => {
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const timer = setTimeout(() => addEventListener("mousedown", down));
    return () => {
      clearTimeout(timer);
      removeEventListener("mousedown", down);
    };
  }, []);
  // Opening the picker is when API providers' lists are refreshed (at most every 10 minutes each); launch shows the cache.
  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.resolve(app.ensureModels?.())
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);
  // On open: highlight the current model and bring it into view (expanding "other models" if it is below the fold).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !list.length) return;
    opened.current = true;
    const i = list.findIndex((m) => favKey(m) === selKey);
    if (i < 0) return;
    if (i >= VISIBLE) setMore(true);
    setHl(i);
    scrollToHl.current = true;
  }, [list]);
  // A new tab or query starts at the top (compared by value, so a repeated mount effect does not reset the highlight).
  const shownFor = useRef(`${tab}\n${q}`);
  useEffect(() => {
    if (shownFor.current === `${tab}\n${q}`) return;
    shownFor.current = `${tab}\n${q}`;
    setHl(0);
  }, [tab, q]);
  useEffect(() => {
    if (!scrollToHl.current) return;
    scrollToHl.current = false;
    document.getElementById(`model-opt-${hl}`)?.scrollIntoView({ block: "nearest" });
  }, [hl, more]);
  const move = (i: number) => ((scrollToHl.current = true), setHl(i));
  const retry = () => {
    setLoading(true);
    Promise.resolve(app.refreshModels({ only: [tab] }))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const toggleFav = (m: Model) => {
    const fav = app.favorites.includes(favKey(m));
    app.setFavorites(fav ? app.favorites.filter((k) => k !== favKey(m)) : [...app.favorites, favKey(m)]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") (e.preventDefault(), move(Math.min(hl + 1, visible.length - 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), move(Math.max(hl - 1, 0)));
    else if (e.key === "Home" && e.target === e.currentTarget) (e.preventDefault(), move(0));
    else if (e.key === "End" && e.target === e.currentTarget) (e.preventDefault(), move(visible.length - 1));
    else if (e.key === "Enter" && visible[hl]) pick(visible[hl]);
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && visible[hl])
      (e.preventDefault(), toggleFav(visible[hl]));
    else if (cmdKey(e) && /^[1-9]$/.test(e.key) && visible[Number(e.key) - 1])
      (e.preventDefault(), pick(visible[Number(e.key) - 1]));
  };

  return (
    <div
      className="popover picker"
      ref={ref}
      role="dialog"
      aria-label={t("modelPicker")}
      onKeyDown={onKey}
      style={height ? { height } : undefined}
    >
      <div className="picker-rail">
        <button
          className={tab === "fav" && !q ? "active" : ""}
          title={t("favorites")}
          aria-label={t("favorites")}
          aria-pressed={tab === "fav" && !q}
          onClick={() => setTab("fav")}
        >
          <Star size={17} fill={tab === "fav" ? "currentColor" : "none"} />
        </button>
        {providers.map((p) => (
          <button
            key={p.id}
            className={tab === p.id && !q ? "active" : ""}
            title={p.name}
            aria-label={p.name}
            aria-pressed={tab === p.id && !q}
            onClick={() => setTab(p.id)}
          >
            <ProviderIcon kind={p.kind} cli={p.cli} size={18} />
          </button>
        ))}
      </div>
      <div className="picker-main">
        <div className="picker-search">
          <Search size={15} />
          <input
            autoFocus
            role="combobox"
            aria-label={t("searchModels")}
            aria-expanded
            aria-controls="model-list"
            aria-autocomplete="list"
            aria-keyshortcuts="Control+D Meta+D"
            aria-activedescendant={visible[hl] ? `model-opt-${hl}` : undefined}
            placeholder={t("searchModels")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="picker-list">
          <div id="model-list" role="listbox" aria-label={t("modelPicker")} style={{ display: "contents" }}>
            {visible.map((m, i) => {
              const fav = app.favorites.includes(favKey(m));
              const sel = favKey(m) === selKey;
              const ctx = contextLabel(m.contextWindow);
              return (
                <div
                  key={favKey(m)}
                  id={`model-opt-${i}`}
                  role="option"
                  aria-selected={sel}
                  className={`model-row${i === hl ? " hl" : ""}${sel ? " sel" : ""}`}
                  onMouseMove={() => i !== hl && setHl(i)}
                  onClick={(e) => (multi && e.shiftKey ? multi.toggle(m) : pick(m))}
                >
                  <div className="info">
                    <div className="model-name" title={m.name !== m.id ? `${m.name} · ${m.id}` : m.name}>
                      <ModelIcon
                        model={`${m.id} ${m.name}`}
                        provider={app.providers.find((p) => p.id === m.providerId)}
                        size={18}
                      />{" "}
                      <span className="model-label">{m.name}</span>
                      {fresh.has(favKey(m)) && <span className="badge-new">NEW</span>}
                    </div>
                    <div className="model-prov">
                      <ProviderIcon kind={kindOf(m.providerId)} size={12} />{" "}
                      <span className="model-label">{nameOf(m.providerId)}</span>
                      {ctx && (
                        <span
                          className="model-ctx"
                          title={t("contextWindowTokens", { tokens: m.contextWindow!.toLocaleString(app.locale) })}
                        >
                          {ctx}
                        </span>
                      )}
                    </div>
                  </div>
                  {multi?.keys.includes(favKey(m)) && (
                    <span className="multi-mark" role="img" aria-label={t("fanOutPicked")}>
                      {multi.keys.indexOf(favKey(m)) + 1}
                    </span>
                  )}
                  {sel && <Check size={15} className="sel-check" aria-hidden="true" />}
                  {i < 9 && <span className="kbd-chip">{displayKeys(`⌘${i + 1}`)}</span>}
                  <button
                    className={`star${fav ? " on" : ""}`}
                    title={t("favorite")}
                    aria-label={t("favorite")}
                    aria-pressed={fav}
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFav(m);
                    }}
                  >
                    <Star size={14} fill={fav ? "currentColor" : "none"} />
                  </button>
                </div>
              );
            })}
          </div>
          {!q && tab !== "fav" && app.modelErrors[tab] ? (
            <div className={visible.length ? "picker-error inline" : "picker-error"} role="alert">
              <span>{visible.length ? t("modelsRefreshFailed") : app.modelErrors[tab]}</span>
              <button className="btn-soft" onClick={retry} disabled={loading}>
                <RotateCw size={12} aria-hidden="true" /> {t("retry")}
              </button>
            </div>
          ) : (
            !visible.length && (
              <div className="picker-empty" aria-live="polite">
                {loading && !(tab === "fav" && !q)
                  ? t("modelsLoading")
                  : tab === "fav" && !q
                    ? t("noFavorites")
                    : t("noModels")}
              </div>
            )
          )}
          {!q && list.length > VISIBLE && (
            <button className="picker-more" onClick={() => setMore(!more)}>
              {more ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{" "}
              {t("otherModels", { count: list.length - VISIBLE })}
            </button>
          )}
        </div>
        {multi && (
          <div className="picker-hint">
            {multi.keys.length ? t("fanOutPickedHint", { count: multi.keys.length, max: multi.max }) : t("fanOutHint")}
          </div>
        )}
        <button className="picker-more picker-manage" onClick={() => (onClose(), app.openSettings("providers"))}>
          <Settings2 size={13} /> {t("provManage")}
        </button>
      </div>
    </div>
  );
}
