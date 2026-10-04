import { ChevronDown, ChevronRight, Search, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { cmdKey } from "../lib/shortcuts";
import { displayKeys } from "../lib/platform";
import { useDialogFocus } from "../lib/useDialogFocus";
import { modelKey as favKey, useApp, type Model } from "../state";
import { ModelIcon } from "./ModelIcon";
import { ProviderIcon } from "./ProviderIcon";

const NEW_MS = 14 * 24 * 3600_000;
const VISIBLE = 8;

export function ModelPicker({ onClose }: { onClose: () => void }) {
  const t = useT();
  const app = useApp();
  const [tab, setTab] = useState<string>(app.favorites.length ? "fav" : app.selection?.providerId ?? app.providers[0]?.id ?? "fav");
  const [q, setQ] = useState("");
  const [more, setMore] = useState(false);
  const [hl, setHl] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  const kindOf = (id: string) => app.providers.find((p) => p.id === id)?.kind ?? "custom";
  const nameOf = (id: string) => app.providers.find((p) => p.id === id)?.name ?? id;

  const providers = app.providers.filter((p) => !p.disabled);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const models = app.models.filter((m) => !app.hiddenModels.includes(favKey(m)));
    let ms = s
      ? models.filter((m) => m.id.toLowerCase().includes(s) || m.name.toLowerCase().includes(s))
      : tab === "fav"
        ? models.filter((m) => app.favorites.includes(favKey(m)))
        : models.filter((m) => m.providerId === tab);
    ms = [...ms].sort((a, b) => b.created - a.created || a.name.localeCompare(b.name));
    return ms;
  }, [app.models, app.favorites, app.hiddenModels, tab, q]);
  const visible = more || q ? list : list.slice(0, VISIBLE);

  const pick = (m: Model) => {
    app.setSelection({ providerId: m.providerId, model: m.id });
    onClose();
  };

  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    setTimeout(() => addEventListener("mousedown", down));
    return () => removeEventListener("mousedown", down);
  }, []);
  // Opening the picker is when API providers' lists are refreshed (at most every 10 minutes each); launch shows the cache.
  useEffect(() => void Promise.resolve(app.ensureModels?.()).catch(() => {}), []);
  useEffect(() => setHl(0), [tab, q]);
  useEffect(() => { document.getElementById(`model-opt-${hl}`)?.scrollIntoView({ block: "nearest" }); }, [hl]);

  const toggleFav = (m: Model) => {
    const fav = app.favorites.includes(favKey(m));
    app.setFavorites(fav ? app.favorites.filter((k) => k !== favKey(m)) : [...app.favorites, favKey(m)]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") (e.preventDefault(), setHl(Math.min(hl + 1, visible.length - 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setHl(Math.max(hl - 1, 0)));
    else if (e.key === "Enter" && visible[hl]) pick(visible[hl]);
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && visible[hl]) (e.preventDefault(), toggleFav(visible[hl]));
    else if (cmdKey(e) && /^[1-9]$/.test(e.key) && visible[Number(e.key) - 1]) (e.preventDefault(), pick(visible[Number(e.key) - 1]));
  };

  return (
    <div className="popover picker" ref={ref} role="dialog" aria-label={t("modelPicker")} onKeyDown={onKey}>
      <div className="picker-rail">
        <button className={tab === "fav" && !q ? "active" : ""} title={t("favorites")} aria-label={t("favorites")} aria-pressed={tab === "fav" && !q} onClick={() => setTab("fav")}>
          <Star size={17} fill={tab === "fav" ? "currentColor" : "none"} />
        </button>
        {providers.map((p) => (
          <button key={p.id} className={tab === p.id && !q ? "active" : ""} title={p.name} aria-label={p.name} aria-pressed={tab === p.id && !q} onClick={() => setTab(p.id)}>
            <ProviderIcon kind={p.kind} cli={p.cli} size={18} />
          </button>
        ))}
      </div>
      <div className="picker-main">
        <div className="picker-search">
          <Search size={15} />
          <input
            autoFocus role="combobox" aria-label={t("searchModels")} aria-expanded aria-controls="model-list" aria-autocomplete="list" aria-keyshortcuts="Control+D Meta+D"
            aria-activedescendant={visible[hl] ? `model-opt-${hl}` : undefined} placeholder={t("searchModels")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="picker-list">
          <div id="model-list" role="listbox" aria-label={t("modelPicker")} style={{ display: "contents" }}>
          {visible.map((m, i) => {
            const fav = app.favorites.includes(favKey(m));
            const sel = app.selection?.providerId === m.providerId && app.selection.model === m.id;
            return (
              <div key={favKey(m)} id={`model-opt-${i}`} role="option" aria-selected={sel} className={`model-row${i === hl ? " hl" : ""}${sel ? " sel" : ""}`} onMouseEnter={() => setHl(i)} onClick={() => pick(m)}>
                <div className="info">
                  <div className="model-name">
                    <ModelIcon model={`${m.id} ${m.name}`} provider={app.providers.find(p => p.id === m.providerId)} size={18} /> {m.name}
                    {Date.now() - m.firstSeen < NEW_MS && <span className="badge-new">NEW</span>}
                  </div>
                  <div className="model-prov">
                    <ProviderIcon kind={kindOf(m.providerId)} size={12} /> {nameOf(m.providerId)}
                  </div>
                </div>
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
          {!visible.length && (
            <div className="picker-empty">
              {tab === "fav" && !q ? t("noFavorites") : app.modelErrors[tab] ? app.modelErrors[tab] : t("noModels")}
            </div>
          )}
          {!q && list.length > VISIBLE && (
            <button className="picker-more" onClick={() => setMore(!more)}>
              {more ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {t("otherModels", { count: list.length - VISIBLE })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
