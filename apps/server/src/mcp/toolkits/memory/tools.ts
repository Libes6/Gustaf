import {
  MEMORY_MAX_CHARS,
  MemorySaveAction,
  MemoryScope,
  NonNegativeInt,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import { MEMORY_SAVE_TOOL_NAME } from "@t3tools/shared/toolOutput";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as MemoryService from "../../../memory/MemoryService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const MemorySaveTool = Tool.make(MEMORY_SAVE_TOOL_NAME, {
  description:
    "Save a short Markdown note to Gustaf Memory so future turns and sessions across any provider remember it. Use when the user asks you to remember something (e.g. preferences, conventions, project facts). Choose scope 'project' for this project or 'global' for personal preferences across all projects. Returns previousContent and revision so the user can undo.",
  parameters: Schema.Struct({
    scope: MemoryScope.annotate({
      description:
        "'project' for this project's memory note, or 'global' for personal memory across all projects.",
    }),
    entry: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MEMORY_MAX_CHARS),
    ).annotate({
      description: "Markdown note text to save.",
    }),
    action: MemorySaveAction.annotate({
      description:
        "'append' adds the entry to the existing note; 'replace' overwrites the entire note.",
    }),
  }),
  success: Schema.Struct({
    scope: MemoryScope,
    projectId: Schema.NullOr(ProjectId),
    action: MemorySaveAction,
    entry: Schema.String,
    previousContent: Schema.String,
    previousRevision: NonNegativeInt,
    revision: NonNegativeInt,
    content: Schema.String,
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    MemoryService.MemoryService,
  ],
})
  .annotate(Tool.Title, "Save to Gustaf Memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const MemoryToolkit = Toolkit.make(MemorySaveTool);
