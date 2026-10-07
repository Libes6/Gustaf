import { createContext, lazy, Suspense, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Code2, PanelRightOpen } from "lucide-react";
import { parseArtifacts, type Artifact } from "../canvas/artifacts";
import { useT } from "../i18n";

const CanvasPanel = lazy(() => import("./CanvasPanel"));
const CanvasContext = createContext<((artifact: Artifact) => void) | null>(null);

export function CanvasCard({ artifact }: { artifact: Artifact }) {
  const open = useContext(CanvasContext);
  const t = useT();
  return (
    <button className="canvas-card" disabled={!artifact.complete || !open} onClick={() => open?.(artifact)}>
      <Code2 size={22} />
      <span>
        <strong>{artifact.title}</strong>
        <small>{t(artifact.complete ? "canvasOpen" : "canvasWriting")}</small>
      </span>
      <PanelRightOpen size={18} />
    </button>
  );
}

/** `aside`: a column at the far right of the layout (the "Background tasks" column); the canvas shares the width that is left. */
export function CanvasWorkspace({
  children,
  sources,
  scope,
  onRepair,
  aside,
}: {
  children: ReactNode;
  sources: string[];
  scope: string;
  onRepair: (prompt: string) => void;
  aside?: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(56);
  const [dragging, setDragging] = useState(false);
  const t = useT();
  const [selection, setSelection] = useState<{ artifact: Artifact; scope: string } | null>(null);
  const selected = selection?.scope === scope ? selection.artifact : null;
  const versions = useMemo(() => {
    if (!selected) return [];
    const artifacts = sources
      .flatMap(parseArtifacts)
      .flatMap((s) =>
        s.type === "canvas" && s.artifact.complete && s.artifact.id === selected.id ? [s.artifact] : [],
      );
    return artifacts.filter((a, i) => i === 0 || a.code !== artifacts[i - 1].code);
  }, [sources, selected]);
  return (
    <CanvasContext.Provider value={(artifact) => setSelection({ artifact, scope })}>
      <div
        ref={container}
        className={`canvas-workspace${selected ? " has-canvas" : ""}${aside ? " has-tasks" : ""}${dragging ? " resizing" : ""}`}
        style={{ "--canvas-width": `${width}%`, "--canvas-ratio": width / 100 } as React.CSSProperties}
      >
        {children}
        {selected && (
          <div
            className="canvas-divider"
            role="separator"
            tabIndex={0}
            aria-label={t("canvasResize")}
            aria-orientation="vertical"
            aria-valuemin={25}
            aria-valuemax={75}
            aria-valuenow={Math.round(width)}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              setDragging(true);
            }}
            // The canvas is a share of what the aside leaves: measure against the canvas pane's own right edge.
            onPointerMove={(e) => {
              if (!dragging) return;
              const left = container.current!.getBoundingClientRect().left;
              const right =
                (e.currentTarget.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().right ??
                container.current!.getBoundingClientRect().right;
              setWidth(Math.max(25, Math.min(75, ((right - e.clientX) / Math.max(1, right - left)) * 100)));
            }}
            onPointerUp={(e) => {
              e.currentTarget.releasePointerCapture(e.pointerId);
              setDragging(false);
            }}
            onLostPointerCapture={() => setDragging(false)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                setWidth((w) => Math.max(25, Math.min(75, w + (e.key === "ArrowLeft" ? 2 : -2))));
              }
            }}
          />
        )}
        {selected && (
          <Suspense fallback={<aside className="canvas-panel" aria-busy="true" />}>
            <CanvasPanel
              key={`${scope}:${selected.id}`}
              artifact={selected}
              versions={versions}
              onSelect={(artifact) => setSelection({ artifact, scope })}
              onClose={() => setSelection(null)}
              onRepair={onRepair}
            />
          </Suspense>
        )}
        {aside}
      </div>
    </CanvasContext.Provider>
  );
}
