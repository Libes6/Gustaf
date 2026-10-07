import { useMemo, useState } from "react";
import { collapseContext, diffFiles } from "../canvas/diff";
import type { Artifact } from "../canvas/artifacts";
import { useT } from "../i18n";

/** Unified line diff between two revisions of one artifact (all files, matched by name). */
export default function CanvasDiff({ versions, current }: { versions: Artifact[]; current: number }) {
  const t = useT();
  const last = current >= 0 ? current : versions.length - 1;
  const [to, setTo] = useState(last);
  const [from, setFrom] = useState(Math.max(0, last - 1));
  const files = useMemo(() => diffFiles(versions[from]?.files ?? [], versions[to]?.files ?? []), [versions, from, to]);
  const changed = files.filter((f) => f.status !== "unchanged");
  const picker = (name: "canvasCompareFrom" | "canvasCompareTo", value: number, set: (n: number) => void) => (
    <label className="canvas-diff-pick">
      {t(name)}
      <select value={value} onChange={(e) => set(Number(e.target.value))}>
        {versions.map((_, i) => (
          <option key={i} value={i}>
            {t("canvasVersion")} {i + 1}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="canvas-diff-pane">
      <div className="canvas-diff-bar">
        {picker("canvasCompareFrom", from, setFrom)}
        {picker("canvasCompareTo", to, setTo)}
      </div>
      <div className="canvas-diff-body">
        {from === to || !changed.length ? (
          <p className="canvas-diff-empty" role="status">
            {t("canvasNoChanges")}
          </p>
        ) : (
          changed.map((file) => (
            <section key={file.name} className="canvas-diff-file">
              <h3>
                <code>{file.name}</code>{" "}
                <small>
                  {file.status === "added"
                    ? `${t("canvasFileAdded")} `
                    : file.status === "removed"
                      ? `${t("canvasFileRemoved")} `
                      : ""}
                  +{file.added} −{file.removed}
                </small>
              </h3>
              <div className="diff" role="table" aria-label={file.name}>
                {collapseContext(file.lines).map((row, i) =>
                  row.kind === "skip" ? (
                    <div key={i} className="hunk" role="row">
                      {t("canvasUnchangedLines", { count: row.count })}
                    </div>
                  ) : (
                    <div key={i} role="row" className={row.kind === "same" ? undefined : row.kind}>
                      <span className="canvas-diff-no" aria-hidden="true">
                        {row.newNo ?? row.oldNo}
                      </span>
                      {row.kind === "add" ? "+ " : row.kind === "del" ? "− " : "  "}
                      {row.text}
                    </div>
                  ),
                )}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
