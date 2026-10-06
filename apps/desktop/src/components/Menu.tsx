import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { rovingTarget } from "../lib/dialogFocus";

export type MenuEntry =
  | { label: string; description?: string; icon?: ReactNode; kbd?: string; checked?: boolean; danger?: boolean; onClick: () => void }
  | { sep: true }
  | { heading: string };
type Anchor = { x: number; y: number; top?: number };
const OPEN_EVENT = "gustaf-menu-open";

/** Portalled menu: measured before paint, flips above its trigger and never clips inside the composer. */
export function Menu({ at, items, onClose, trigger, wide = false, keyboard = false }: { at: Anchor; items: MenuEntry[]; onClose: () => void; trigger?: HTMLElement | null; wide?: boolean; keyboard?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: at.x, y: at.y, above: false });
  useLayoutEffect(() => {
    const place = () => {
      const r = ref.current!.getBoundingClientRect();
      const above = at.top !== undefined && at.y + r.height > innerHeight - 8;
      setPos({ x: Math.max(8, Math.min(at.x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(above ? at.top! - r.height - 8 : at.y, innerHeight - r.height - 8)), above });
    };
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, [at.x, at.y, at.top, items]);
  useEffect(() => {
    const previous = trigger ?? document.activeElement as HTMLElement | null;
    const el = ref.current;
    (keyboard ? (el?.querySelector<HTMLElement>('[aria-checked="true"]') ?? el?.querySelector<HTMLElement>('[role^="menuitem"]')) : el)?.focus();
    return () => {
      if (previous?.isConnected && (document.activeElement === document.body || el?.contains(document.activeElement))) previous.focus();
    };
  }, [trigger, keyboard]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") { e.preventDefault(); onClose(); return; }
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    const to = rovingTarget(e.key, list.length, list.indexOf(document.activeElement as HTMLElement));
    if (to !== null) { e.preventDefault(); list[to].focus(); }
  };
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !trigger?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    const scroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("mousedown", down, true);
    document.addEventListener("click", down, true);
    addEventListener("keydown", key);
    addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("click", down, true);
      removeEventListener("keydown", key);
      removeEventListener("scroll", scroll, true);
    };
  }, [onClose, trigger]);
  return createPortal(
    <div className={`menu floating-menu${wide ? " menu-wide" : ""}`} ref={ref} style={{ left: pos.x, top: pos.y, transformOrigin: pos.above ? "bottom left" : "top left" }} role="menu" tabIndex={-1} aria-orientation="vertical" onKeyDown={onKeyDown}>
      {items.map((it, i) => "sep" in it ? <div key={i} className="menu-sep" role="separator" /> : "heading" in it ? <div key={i} className="menu-label" role="presentation">{it.heading}</div> : (
        <button key={i} role={it.checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={it.checked} className={`menu-item${it.danger ? " danger" : ""}`} onClick={() => { onClose(); it.onClick(); }}>
          {it.icon}<span className="grow"><span>{it.label}</span>{it.description && <span className="menu-desc">{it.description}</span>}</span>
          {(it.kbd || it.checked) && <span className="kbd">{it.checked ? "✓" : it.kbd}</span>}
        </button>
      ))}
    </div>, document.body,
  );
}

export function useMenu() {
  const [menu, setMenu] = useState<{ at: Anchor; items: MenuEntry[]; trigger: HTMLElement | null; wide: boolean; keyboard: boolean } | null>(null);
  const owner = useRef({});
  const input = useRef<"pointer" | "keyboard">("pointer");
  useEffect(() => {
    const pointer = () => { input.current = "pointer"; };
    const key = () => { input.current = "keyboard"; };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("mousedown", pointer, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("mousedown", pointer, true);
      document.removeEventListener("keydown", key, true);
    };
  }, []);
  const close = useCallback(() => setMenu(null), []);
  useEffect(() => {
    const other = (e: Event) => { if ((e as CustomEvent).detail !== owner.current) close(); };
    addEventListener(OPEN_EVENT, other);
    return () => removeEventListener(OPEN_EVENT, other);
  }, [close]);
  const open = (e: { clientX: number; clientY: number } | DOMRect, items: MenuEntry[], options?: { wide?: boolean }) => {
    const hit = "clientX" in e ? null : document.elementFromPoint?.(e.left + e.width / 2, e.top + e.height / 2)?.closest<HTMLElement>("button,[role=button]");
    const active = document.activeElement;
    const trigger = hit ?? (active instanceof HTMLButtonElement && !active.closest('[role=menu]') ? active : null);
    dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: owner.current }));
    const at = "clientX" in e ? { x: e.clientX, y: e.clientY } : { x: e.left, y: e.bottom + 8, top: e.top };
    setMenu(old => old && old.at.x === at.x && old.at.y === at.y ? null : { at, items, trigger, wide: !!options?.wide, keyboard: input.current === "keyboard" });
  };
  const node = menu && <Menu at={menu.at} items={menu.items} trigger={menu.trigger} wide={menu.wide} keyboard={menu.keyboard} onClose={close} />;
  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (!menu) e.currentTarget.click(); }
  };
  return { open, close, node, onTriggerKeyDown, isOpen: !!menu };
}
