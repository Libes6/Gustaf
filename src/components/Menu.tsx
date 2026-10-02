import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type MenuEntry =
  | { label: string; icon?: ReactNode; kbd?: string; danger?: boolean; onClick: () => void }
  | { sep: true }
  | { heading: string };

/** Fixed-position menu that closes on outside click / Escape and stays inside the window. */
export function Menu({ at, items, onClose }: { at: { x: number; y: number }; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: Math.min(at.x, innerWidth - r.width - 8), y: Math.min(at.y, innerHeight - r.height - 8) });
  }, [at.x, at.y]);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    setTimeout(() => addEventListener("mousedown", down));
    addEventListener("keydown", key);
    return () => {
      removeEventListener("mousedown", down);
      removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((it, i) =>
        "sep" in it ? (
          <div key={i} className="menu-sep" />
        ) : "heading" in it ? (
          <div key={i} className="menu-label">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item${it.danger ? " danger" : ""}`}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            {it.icon}
            <span className="grow">{it.label}</span>
            {it.kbd && <span className="kbd">{it.kbd}</span>}
          </button>
        ),
      )}
    </div>
  );
}

export function useMenu() {
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuEntry[] } | null>(null);
  const open = (e: { clientX: number; clientY: number } | DOMRect, items: MenuEntry[]) =>
    setMenu({ at: "clientX" in e ? { x: e.clientX, y: e.clientY } : { x: e.left, y: e.bottom + 4 }, items });
  const node = menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />;
  return { open, node, isOpen: !!menu };
}
