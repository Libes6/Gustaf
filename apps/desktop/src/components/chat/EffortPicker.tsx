import { ChevronRight, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useT } from "../../i18n";
import { useDialogFocus } from "../../lib/useDialogFocus";
import type { Reasoning } from "../../providers/types";

type Props = {
  /** Levels the model offers, weakest first. */
  levels: readonly Reasoning[];
  value: Reasoning;
  defaultValue: Reasoning;
  onChange: (r: Reasoning) => void;
  modelName: string;
  /** Opens the model list in place of this popover. */
  onOpenModels: () => void;
  onClose: () => void;
};

/** 0..1 position of a level on the track; a single-level model sits at the end. */
export const levelFraction = (index: number, count: number) => (count > 1 ? index / (count - 1) : 1);

/** Nearest stop for a pointer at `x` (0..1 along the usable track). */
export const stopAt = (x: number, count: number) => Math.max(0, Math.min(count - 1, Math.round(x * (count - 1))));

/**
 * Reasoning effort popover: level name, the model (opens the model list), reset, and a slider with one stop per level.
 * The filled track warms up with the level; the top stops get drifting sparks (static under prefers-reduced-motion).
 */
export function EffortPicker(p: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pulse, setPulse] = useState(0);
  const count = p.levels.length;
  const index = Math.max(0, p.levels.indexOf(p.value));
  const fraction = levelFraction(index, count);
  useDialogFocus(ref, p.onClose);

  useEffect(() => {
    // The trigger chip shares the parent: its own click toggles the popover, so it is not an outside click.
    const down = (e: MouseEvent) => !(ref.current?.parentElement ?? ref.current)?.contains(e.target as Node) && p.onClose();
    const id = setTimeout(() => addEventListener("mousedown", down));
    return () => (clearTimeout(id), removeEventListener("mousedown", down));
  }, []);

  const set = (i: number) => {
    const next = p.levels[Math.max(0, Math.min(count - 1, i))];
    if (next && next !== p.value) {
      p.onChange(next);
      setPulse((n) => n + 1);
    }
  };
  const fromPointer = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width <= 44) return;
    set(stopAt((clientX - r.left - 22) / (r.width - 44), count));
  };
  const dragging = useRef(false);
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    fromPointer(e.clientX);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (step) set(index + step);
    else if (e.key === "Home") set(0);
    else if (e.key === "End") set(count - 1);
    else return;
    e.preventDefault();
  };

  // Sparks on the upper stops; nothing is animated when the user asked for reduced motion or the canvas is unavailable.
  const hot = count > 2 && fraction >= 0.66;
  const top = fraction === 1 && count > 1;
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext?.("2d");
    if (!el || !ctx || !hot || matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    type Spark = { x: number; y: number; vx: number; vy: number; a: number; r: number };
    let sparks: Spark[] = [];
    let frame = 0;
    const tick = () => {
      const dpr = devicePixelRatio || 1;
      const w = el.clientWidth, h = el.clientHeight;
      if (el.width !== w * dpr) (el.width = w * dpr), (el.height = h * dpr);
      const edge = 22 + (w - 44) * fraction + 10;
      ctx.clearRect(0, 0, el.width, el.height);
      for (let k = 0; k < (top ? 3 : 1); k++)
        if (sparks.length < 90) sparks.push({ x: Math.random() * edge, y: Math.random() * h, vx: 0.2 + Math.random() * 0.6, vy: (Math.random() - 0.5) * 0.3, a: 1, r: 0.6 + Math.random() * 1.6 });
      sparks = sparks.filter((s) => s.a > 0 && s.x < edge);
      for (const s of sparks) {
        s.x += s.vx; s.y += s.vy; s.a -= 0.012;
        ctx.fillStyle = `rgba(255,255,255,${(s.a * 0.9).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(s.x * dpr, s.y * dpr, s.r * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => (cancelAnimationFrame(frame), ctx.clearRect(0, 0, el.width, el.height));
  }, [hot, top, fraction]);

  const label = t(`reasoning_${p.value}`);
  return (
    <div className="popover effort-pop" ref={ref} role="dialog" aria-label={t("effortTitle")} style={{ ["--effort" as string]: fraction }}>
      <div className="effort-head">
        <span className="effort-spacer" />
        <div className="effort-title">
          <div className={`effort-level${top ? " top" : ""}`} aria-live="polite">{label}</div>
          <button type="button" className="effort-model" onClick={p.onOpenModels} title={t("chooseModel")}>
            <span>{p.modelName}</span> <ChevronRight size={12} aria-hidden="true" />
          </button>
        </div>
        <button type="button" className="effort-reset" onClick={() => set(p.levels.indexOf(p.defaultValue))} aria-label={t("effortReset")} title={t("effortReset")} disabled={p.value === p.defaultValue}>
          <RotateCcw size={15} aria-hidden="true" />
        </button>
      </div>
      <div
        ref={track}
        className={`effort-track${top ? " top" : ""}`}
        role="slider"
        tabIndex={0}
        data-autofocus
        aria-label={t("effortTitle")}
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={index}
        aria-valuetext={label}
        onPointerDown={onDown}
        onPointerMove={(e) => dragging.current && fromPointer(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onKeyDown={onKey}
        onWheel={(e) => set(index + (e.deltaY > 0 ? -1 : 1))}
      >
        <div className="effort-fill" />
        {p.levels.map((l, i) => i > index && <span key={l} className="effort-stop" style={{ left: `calc(22px + (100% - 44px) * ${levelFraction(i, count)})` }} />)}
        <canvas ref={canvas} className="effort-sparks" aria-hidden="true" />
        <span key={pulse} className={`effort-thumb${pulse ? " pulse" : ""}`} />
      </div>
      <div className="effort-hint"><span>{t("effortHintLow")}</span><span>{t("effortHintHigh")}</span></div>
    </div>
  );
}
