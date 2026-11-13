import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

export const WorktreeInventoryInput = Schema.Struct({
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  inspectPath: Schema.optional(Schema.String),
});
export type WorktreeInventoryInput = typeof WorktreeInventoryInput.Type;
export const WorktreeInventoryThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.String,
  archived: Schema.Boolean,
  deleted: Schema.Boolean,
  pullRequests: Schema.Array(
    Schema.Struct({
      number: Schema.Number,
      url: Schema.String,
      title: Schema.NullOr(Schema.String),
      state: Schema.NullOr(Schema.Literals(["open", "closed", "merged"])),
    }),
  ),
});
export type WorktreeInventoryThread = typeof WorktreeInventoryThread.Type;
export const WorktreeInventoryEntry = Schema.Struct({
  path: Schema.String,
  branch: Schema.NullOr(Schema.String),
  registered: Schema.Boolean,
  exists: Schema.Boolean,
  prunable: Schema.Boolean,
  origin: Schema.Literal("unknown"),
  projectIds: Schema.Array(ProjectId),
  threads: Schema.Array(WorktreeInventoryThread),
  hasWorkingTreeChanges: Schema.NullOr(Schema.Boolean),
  error: Schema.NullOr(Schema.String),
});
export type WorktreeInventoryEntry = typeof WorktreeInventoryEntry.Type;
export const WorktreeInventoryResult = Schema.Struct({
  entries: Schema.Array(WorktreeInventoryEntry),
  errors: Schema.Array(Schema.Struct({ projectId: ProjectId, message: Schema.String })),
});
export type WorktreeInventoryResult = typeof WorktreeInventoryResult.Type;
