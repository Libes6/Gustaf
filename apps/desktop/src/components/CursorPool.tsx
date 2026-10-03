import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useT } from "../i18n";
import { addToPool, isCursorAccount, markAvailable, moveInPool, pickAccount, removeFromPool } from "../providers/cursorAccounts";
import { updatePool, useCursorPool } from "../providers/cursorPoolStore";
import { useApp } from "../state";

/** The ordered rotation pool: when the active account runs out of quota, the next message uses the next one. */
export function CursorPool() {
  const t = useT();
  const app = useApp();
  const pool = useCursorPool();
  const accounts = app.providers.filter(isCursorAccount);
  const members = pool.ids.map((id) => accounts.find((p) => p.id === id)).filter((p) => !!p);
  const free = accounts.filter((p) => !pool.ids.includes(p.id));
  const active = pickAccount(pool, app.providers, Date.now());
  const now = Date.now();
  const exhaustedUntil = (id: string) => (pool.exhausted[id]?.until ?? 0) > now ? pool.exhausted[id].until : undefined;
  const kind = (p: { cliProfile?: string; cliAuth?: string }) => t(p.cliProfile ? "cursorKindLogin" : p.cliAuth === "key" ? "cursorKindKey" : "cursorKindShared");
  return (
    <div className="card">
      <div className="card-row">
        <div className="grow">
          <div className="t">{t("cursorPool")}</div>
          <div className="d">{t("cursorPoolHint")}</div>
        </div>
        {free.length > 0 && (
          <select aria-label={t("cursorPoolAdd")} className="input narrow" value="" onChange={(e) => e.target.value && updatePool((p) => addToPool(p, e.target.value))}>
            <option value="">{t("cursorPoolAdd")}</option>
            {free.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>
      {members.map((p, i) => (
        <div className="card-row" key={p!.id}>
          <div className="grow">
            <div className="t">{i + 1}. {p!.name}</div>
            <div className="d">{kind(p!)}{active.ok && active.id === p!.id ? ` · ${t("cursorPoolActive")}` : ""}{exhaustedUntil(p!.id) ? ` · ${t("cursorPoolExhausted", { time: t.date(exhaustedUntil(p!.id)!) })}` : ""}</div>
          </div>
          {exhaustedUntil(p!.id) && <button className="btn-soft" onClick={() => updatePool((s) => markAvailable(s, p!.id))}>{t("cursorPoolMarkAvailable")}</button>}
          <button className="icon-btn" disabled={i === 0} title={t("moveUp")} onClick={() => updatePool((s) => moveInPool(s, p!.id, -1))}><ArrowUp size={14} /></button>
          <button className="icon-btn" disabled={i === members.length - 1} title={t("moveDown")} onClick={() => updatePool((s) => moveInPool(s, p!.id, 1))}><ArrowDown size={14} /></button>
          <button className="icon-btn" title={t("cursorPoolRemove")} onClick={() => updatePool((s) => removeFromPool(s, p!.id))}><X size={14} /></button>
        </div>
      ))}
      {members.length === 1 && <div className="card-row"><div className="d">{t("cursorPoolNeedTwo")}</div></div>}
    </div>
  );
}
