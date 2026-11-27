import { useAtomValue } from "@effect/atom-react";
import { ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { BrainIcon, PencilIcon, Undo2Icon } from "lucide-react";
import { use, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { TimelineRowCtx } from "./timelineRowContext";

const PREVIEW_MAX_CHARS = 180;

function formatEntryPreview(entry: string): string {
  const singleLine = entry.replace(/\s+/g, " ").trim();
  if (singleLine.length <= PREVIEW_MAX_CHARS) return singleLine;
  return `${singleLine.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

export function MemorySaveTimelineRow({
  row,
}: {
  readonly row: Extract<MessagesTimelineRow, { kind: "memory-save" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const gt = useGT();
  const navigate = useNavigate();
  const environmentId = ctx.activeThreadEnvironmentId;
  const canWrite = useAtomValue(serverEnvironment.writeMemoryNote.permissionAtom(environmentId));
  const writeMemory = useAtomCommand(serverEnvironment.writeMemoryNote);
  const clearMemory = useAtomCommand(serverEnvironment.clearMemoryNote);
  const [undoState, setUndoState] = useState<"idle" | "busy" | "undone">("idle");

  const { memorySave } = row;
  const projectId =
    memorySave.scope === "project" && memorySave.projectId !== null
      ? ProjectId.make(memorySave.projectId)
      : undefined;

  async function handleUndo() {
    if (environmentId === undefined || undoState !== "idle") return;
    setUndoState("busy");
    const result =
      memorySave.previousContent.trim() === ""
        ? await clearMemory({
            environmentId,
            input: {
              scope: memorySave.scope,
              ...(projectId === undefined ? {} : { projectId }),
            },
          })
        : await writeMemory({
            environmentId,
            input: {
              scope: memorySave.scope,
              ...(projectId === undefined ? {} : { projectId }),
              content: memorySave.previousContent,
            },
          });

    if (result._tag === "Success") {
      setUndoState("undone");
      toastManager.add({
        type: "success",
        title: gt("Memory restored"),
      });
    } else {
      setUndoState("idle");
      toastManager.add({
        type: "error",
        title: gt("Could not undo memory update"),
      });
    }
  }

  function handleEdit() {
    void navigate({ to: "/settings/memory" });
  }

  return (
    <div className="rounded-lg border border-border/70 bg-card/60 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <BrainIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium text-foreground">
            {memorySave.scope === "project" ? (
              <T>Saved to project memory</T>
            ) : (
              <T>Saved to global memory</T>
            )}
          </span>
          <Badge variant="outline" size="sm">
            {memorySave.action === "replace" ? <T>Replaced</T> : <T>Appended</T>}
          </Badge>
          <span className="text-muted-foreground">
            <T>
              rev <Var>{memorySave.revision}</Var>
            </T>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {undoState === "undone" ? (
            <span className="px-1.5 text-muted-foreground">
              <T>Undone</T>
            </span>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={!canWrite || environmentId === undefined || undoState === "busy"}
              onClick={() => void handleUndo()}
            >
              <Undo2Icon className="size-3" />
              <T>Undo</T>
            </Button>
          )}
          <Button type="button" size="xs" variant="ghost" onClick={handleEdit}>
            <PencilIcon className="size-3" />
            <T>Edit</T>
          </Button>
        </div>
      </div>
      {memorySave.entry.trim() !== "" ? (
        <p className="mt-1.5 line-clamp-2 text-muted-foreground">
          {formatEntryPreview(memorySave.entry)}
        </p>
      ) : null}
    </div>
  );
}
