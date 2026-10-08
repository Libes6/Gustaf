// The live view: the device picture letterboxed in its box, outlines of the inspected elements, and the mouse and
// keyboard handling that turns clicks and drags into device gestures.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { Frame, Point } from "../../device/types";
import { deviceToView, fitScreen, hitTest, type Size, type UiMap, type UiNode } from "../../device/uiMap";
import { boxToDevice, boxToDeviceClamped, chipPosition, classifyGesture, type Gesture } from "./screenGeometry";
import { nodeTitle } from "./mapRows";

export type ScreenMode = "interact" | "inspect";

type Props = {
  frame: Frame | null;
  map: UiMap | null;
  mode: ScreenMode;
  /** Taps are ignored (the agent is in control); the user is told why. */
  locked: boolean;
  /** Name of the action in flight, if any. */
  busy: string | null;
  /** Hovered from the map tree: outlined on the screen. */
  highlight: UiNode | null;
  pinned: UiNode | null;
  onGesture: (g: Gesture) => void;
  onText: (text: string) => void;
  onEnter: () => void;
  onPin: (node: UiNode | null) => void;
  onActivity: () => void;
  onBlocked: () => void;
};

const TYPE_FLUSH_MS = 120;

export function DeviceScreen(p: Props) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [hover, setHover] = useState<UiNode | null>(null);
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const down = useRef<{ view: Point; at: number } | null>(null);

  const framePoints = p.frame?.points;
  const viewport = p.map?.viewport;
  const device: Size = useMemo(() => framePoints ?? viewport ?? { width: 0, height: 0 }, [framePoints, viewport]);
  const shown = useMemo(() => fitScreen(device, box), [device, box]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox((b) => (b.width === r.width && b.height === r.height ? b : { width: r.width, height: r.height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const sizeNow = (): Size => {
    const r = boxRef.current!.getBoundingClientRect();
    return { width: r.width, height: r.height };
  };

  // ---- keyboard: typed characters are batched into one `type` call ----
  const typed = useRef("");
  const typeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushTyped = useCallback(() => {
    clearTimeout(typeTimer.current);
    typeTimer.current = undefined;
    const text = typed.current;
    typed.current = "";
    if (text) p.onText(text);
  }, [p]);
  const flushRef = useRef(flushTyped);
  useEffect(() => {
    flushRef.current = flushTyped;
  });
  useEffect(() => () => flushRef.current(), []);

  const interactive = p.mode === "interact";
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!interactive || e.ctrlKey || e.metaKey || e.altKey) return;
    if (p.locked) {
      if (e.key.length === 1 || e.key === "Enter") p.onBlocked();
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      typed.current += e.key;
      clearTimeout(typeTimer.current);
      typeTimer.current = setTimeout(flushTyped, TYPE_FLUSH_MS);
      p.onActivity();
    } else if (e.key === "Enter") {
      e.preventDefault();
      flushTyped();
      p.onEnter();
    }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (!interactive) return;
    const text = e.clipboardData.getData("text");
    if (!text) return;
    e.preventDefault();
    if (p.locked) return p.onBlocked();
    flushTyped();
    p.onText(text);
  };

  // ---- mouse ----
  const onMouseMove = (e: React.MouseEvent) => {
    p.onActivity();
    if (p.mode !== "inspect" || !p.map || !p.frame) return;
    const at = boxToDevice(device, sizeNow(), local(e));
    const node = at ? hitTest(p.map, at) : null;
    setHover((h) => (h?.index === node?.index ? h : node));
  };
  const onMouseDown = (e: React.MouseEvent) => {
    p.onActivity();
    if (e.button !== 0 || !interactive || !p.frame) return;
    boxRef.current?.focus();
    const view = local(e);
    if (!boxToDevice(device, sizeNow(), view)) return; // in the letterbox bars
    if (p.locked) return p.onBlocked();
    down.current = { view, at: Date.now() };
    setDrag({ from: view, to: view });
    const move = (ev: MouseEvent) => setDrag((d) => (d ? { ...d, to: local(ev) } : d));
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const start = down.current;
      down.current = null;
      setDrag(null);
      if (!start) return;
      const end = local(ev);
      const size = sizeNow();
      const from = boxToDevice(device, size, start.view);
      const to = boxToDeviceClamped(device, size, end);
      if (!from || !to) return;
      p.onGesture(classifyGesture({ viewDown: start.view, viewUp: end, from, to, durationMs: Date.now() - start.at }));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const onClick = (e: React.MouseEvent) => {
    if (p.mode !== "inspect" || !p.map || !p.frame) return;
    const at = boxToDevice(device, sizeNow(), local(e));
    p.onPin(at ? hitTest(p.map, at) : null);
  };

  const outline = (n: UiNode) => deviceToView(device, shown, n.rect);
  const active = p.highlight ?? (p.mode === "inspect" ? hover : null);
  const marks: { node: UiNode; kind: "pinned" | "hover" }[] = [];
  if (p.pinned) marks.push({ node: p.pinned, kind: "pinned" });
  if (active && active.index !== p.pinned?.index) marks.push({ node: active, kind: "hover" });

  const src = p.frame ? `data:${p.frame.mime};base64,${p.frame.data}` : null;
  return (
    <div
      ref={boxRef}
      className={`dev-screen dev-screen-${p.mode}${p.locked ? " locked" : ""}`}
      role="group"
      tabIndex={0}
      aria-label={t("deviceScreenLabel")}
      aria-busy={p.busy !== null}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={() => setHover(null)}
      onClick={onClick}
      onBlur={flushTyped}
    >
      {src && shown.width > 0 && (
        <img
          className="dev-frame"
          src={src}
          alt=""
          draggable={false}
          style={{ left: shown.x, top: shown.y, width: shown.width, height: shown.height }}
        />
      )}
      {!src && <div className="dev-screen-empty">{t("deviceWaitingFrame")}</div>}
      {marks.map(({ node, kind }) => {
        const r = outline(node);
        const label = `${node.role}${nodeTitle(node) ? ` · ${nodeTitle(node)}` : ""}`;
        const c = chipPosition(r, box, { width: Math.min(220, label.length * 6.5 + 12), height: 18 });
        return (
          <div key={kind}>
            <div
              className={`dev-outline ${kind}`}
              data-testid={`dev-outline-${kind}`}
              style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
            />
            <div className={`dev-chip ${kind}`} style={{ left: c.x, top: c.y }}>
              {label}
            </div>
          </div>
        );
      })}
      {drag && (
        <svg className="dev-trail" width={box.width} height={box.height} aria-hidden="true">
          <line x1={drag.from.x} y1={drag.from.y} x2={drag.to.x} y2={drag.to.y} />
          <circle cx={drag.from.x} cy={drag.from.y} r={5} />
        </svg>
      )}
      {p.busy !== null && (
        <div className="dev-busy" role="status">
          <span className="dev-spinner" aria-hidden="true" /> {p.busy}
        </div>
      )}
    </div>
  );
}
