// The interface map next to the screen: app info, search, "interactive only" and the tree of visible elements.

import { useMemo, useState } from "react";
import { useT } from "../../i18n";
import type { UiMap, UiNode } from "../../device/uiMap";
import { mapRows, nodeTitle } from "./mapRows";

type Props = {
  map: UiMap | null;
  loading: boolean;
  selected: UiNode | null;
  /** Taps are disabled (agent in control or no helper). */
  tapDisabled: boolean;
  onHover: (node: UiNode | null) => void;
  onSelect: (node: UiNode) => void;
  onTap: (node: UiNode) => void;
  onRefresh: () => void;
};

export function DeviceMap(p: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [interactiveOnly, setInteractiveOnly] = useState(false);
  const rows = useMemo(
    () => (p.map ? mapRows(p.map, { query, interactiveOnly }) : []),
    [p.map, query, interactiveOnly],
  );
  const map = p.map;
  return (
    <div className="dev-map">
      <div className="dev-map-head">
        <div className="dev-map-app">
          {map ? (
            <>
              <strong>{map.app?.name ?? t("deviceMapUnknownApp")}</strong>
              {map.app?.bundleId && <span className="dev-dim"> {map.app.bundleId}</span>}
              <div className="dev-dim">
                {Math.round(map.viewport.width)}×{Math.round(map.viewport.height)} ·{" "}
                {t("deviceMapCount", { count: map.nodes.length })}
              </div>
            </>
          ) : (
            <span className="dev-dim">{p.loading ? t("deviceMapLoading") : t("deviceMapEmpty")}</span>
          )}
        </div>
        <button className="dev-btn" onClick={p.onRefresh} disabled={p.loading}>
          {t("deviceRefreshMap")}
        </button>
      </div>
      <div className="dev-map-tools">
        <input
          className="input dev-search"
          type="search"
          value={query}
          placeholder={t("deviceSearchPlaceholder")}
          aria-label={t("deviceSearchPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="dev-check">
          <input type="checkbox" checked={interactiveOnly} onChange={(e) => setInteractiveOnly(e.target.checked)} />{" "}
          {t("deviceInteractiveOnly")}
        </label>
      </div>
      {map?.truncated && <div className="dev-note">{t("deviceMapTruncated")}</div>}
      {map && rows.length === 0 && <div className="dev-dim dev-pad">{t("deviceMapNoMatches")}</div>}
      <ul className="dev-tree" role="list" aria-label={t("deviceMapLabel")} onMouseLeave={() => p.onHover(null)}>
        {rows.map(({ node, level, actionable }) => (
          <li
            key={node.index}
            className={`dev-row${p.selected?.index === node.index ? " selected" : ""}`}
            style={{ paddingInlineStart: 6 + Math.min(level, 8) * 12 }}
            onMouseEnter={() => p.onHover(node)}
          >
            <button
              className="dev-row-main"
              aria-pressed={p.selected?.index === node.index}
              aria-label={`${node.role} ${nodeTitle(node) || node.ref}`}
              onClick={() => p.onSelect(node)}
              onFocus={() => p.onHover(node)}
              onBlur={() => p.onHover(null)}
            >
              <span className="dev-role">{node.role}</span>
              <span className="dev-row-title">{nodeTitle(node) || <i>{node.ref}</i>}</span>
            </button>
            {actionable && (
              <button
                className="dev-btn dev-row-tap"
                disabled={p.tapDisabled}
                aria-label={t("deviceTapNamed", { name: nodeTitle(node) || node.ref })}
                onClick={() => p.onTap(node)}
              >
                {t("deviceTap")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
