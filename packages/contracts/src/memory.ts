import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MEMORY_MAX_CHARS = 8_000;

export const MemoryScope = Schema.Literals(["global", "project"]);
export type MemoryScope = typeof MemoryScope.Type;

export const MemorySaveAction = Schema.Literals(["append", "replace"]);
export type MemorySaveAction = typeof MemorySaveAction.Type;

export const MemoryImportRecord = Schema.Struct({
  sourcePath: Schema.String,
  sourceLabel: Schema.String,
  importedAt: IsoDateTime,
});
export type MemoryImportRecord = typeof MemoryImportRecord.Type;

export const MemoryNote = Schema.Struct({
  scope: MemoryScope,
  projectId: Schema.NullOr(ProjectId),
  content: Schema.String,
  revision: NonNegativeInt,
  maxChars: NonNegativeInt,
  updatedAt: Schema.NullOr(IsoDateTime),
  imports: Schema.Array(MemoryImportRecord),
});
export type MemoryNote = typeof MemoryNote.Type;

export const MemoryReadInput = Schema.Struct({
  scope: MemoryScope,
  projectId: Schema.optionalKey(ProjectId),
});
export type MemoryReadInput = typeof MemoryReadInput.Type;

export const MemoryWriteInput = Schema.Struct({
  scope: MemoryScope,
  projectId: Schema.optionalKey(ProjectId),
  content: Schema.String,
});
export type MemoryWriteInput = typeof MemoryWriteInput.Type;

export const MemoryClearInput = Schema.Struct({
  scope: MemoryScope,
  projectId: Schema.optionalKey(ProjectId),
});
export type MemoryClearInput = typeof MemoryClearInput.Type;

export const MemoryClaudeImportableEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  sourcePath: Schema.String,
  projectSlug: Schema.String,
  projectLabel: Schema.String,
  fileName: Schema.String,
  title: Schema.String,
  preview: Schema.String,
  charCount: NonNegativeInt,
  modifiedAt: Schema.NullOr(IsoDateTime),
});
export type MemoryClaudeImportableEntry = typeof MemoryClaudeImportableEntry.Type;

export const MemoryListImportableFromClaudeInput = Schema.Struct({});
export type MemoryListImportableFromClaudeInput = typeof MemoryListImportableFromClaudeInput.Type;

export const MemoryListImportableFromClaudeResult = Schema.Struct({
  entries: Schema.Array(MemoryClaudeImportableEntry),
});
export type MemoryListImportableFromClaudeResult = typeof MemoryListImportableFromClaudeResult.Type;

export const MemoryImportFromClaudeInput = Schema.Struct({
  scope: MemoryScope,
  projectId: Schema.optionalKey(ProjectId),
  entryIds: Schema.Array(TrimmedNonEmptyString),
  mode: MemorySaveAction,
});
export type MemoryImportFromClaudeInput = typeof MemoryImportFromClaudeInput.Type;

export const MemoryImportFromClaudeResult = Schema.Struct({
  note: MemoryNote,
  importedCount: NonNegativeInt,
});
export type MemoryImportFromClaudeResult = typeof MemoryImportFromClaudeResult.Type;

export const MemoryErrorCode = Schema.Literals([
  "invalid_scope",
  "too_large",
  "not_found",
  "io_error",
]);
export type MemoryErrorCode = typeof MemoryErrorCode.Type;

export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
  code: MemoryErrorCode,
  message: Schema.String,
  maxChars: Schema.optionalKey(NonNegativeInt),
  actualChars: Schema.optionalKey(NonNegativeInt),
  cause: Schema.optional(Schema.Defect()),
}) {}
