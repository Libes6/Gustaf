import { OrchestratorMcpFailure, type MemoryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MemoryService from "../../../memory/MemoryService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { MemoryToolkit } from "./tools.ts";

const toFailure = (error: MemoryError) =>
  error.code === "too_large" || error.code === "invalid_scope" || error.code === "not_found"
    ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
    : unavailable();

const handlers = {
  memory_save: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      let projectId = undefined;
      if (input.scope === "project") {
        const caller = yield* loadCaller();
        if (caller.caller?.projectId === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Project memory requires an active thread belonging to a project.",
          });
        }
        projectId = caller.caller.projectId;
      }
      const saved = yield* memory
        .saveEntry({
          scope: input.scope,
          ...(projectId === undefined ? {} : { projectId }),
          entry: input.entry,
          action: input.action,
        })
        .pipe(Effect.mapError(toFailure));
      return {
        scope: saved.note.scope,
        projectId: saved.note.projectId,
        action: input.action,
        entry: input.entry.trim(),
        previousContent: saved.previousContent,
        previousRevision: saved.previousRevision,
        revision: saved.note.revision,
        content: saved.note.content,
        message:
          saved.note.scope === "project"
            ? `Saved to project memory (revision ${saved.note.revision}).`
            : `Saved to global memory (revision ${saved.note.revision}).`,
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof MemoryToolkit.tools>;

export const layer = McpToolAccess.toLayer(MemoryToolkit, handlers);
