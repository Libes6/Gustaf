import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Skills every provider can run: `<workspace>/.agents/skills` and `<userdata>/skills`. */
export const SharedSkillSource = Schema.Literals(["project", "global"]);
export type SharedSkillSource = typeof SharedSkillSource.Type;

/** Claude Code skills that can be copied into a shared source. */
export const ImportableSkillSource = Schema.Literals(["claude-project", "claude-user"]);
export type ImportableSkillSource = typeof ImportableSkillSource.Type;

export const SkillLocation = Schema.Literals([
  ...SharedSkillSource.literals,
  ...ImportableSkillSource.literals,
]);
export type SkillLocation = typeof SkillLocation.Type;

/**
 * What stops or limits running a skill outside its own agent. The `claude-*`
 * entries name features only Claude Code runs; other agents read them as text.
 */
export const SkillCompatibilityIssue = Schema.Literals([
  "invalid-name",
  "invalid-frontmatter",
  "too-large",
  "agent-only",
  "claude-arguments",
  "claude-shell-commands",
  "claude-fork-context",
  "claude-allowed-tools",
]);
export type SkillCompatibilityIssue = typeof SkillCompatibilityIssue.Type;

/** A skill's folder name, which is also what the composer mentions. */
export const SkillName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  // One path segment, so a client cannot name a folder outside the skill roots.
  Schema.isPattern(/^(?!\.{1,2}$)[^/\\\0]+$/),
);
export type SkillName = typeof SkillName.Type;

/** Metadata only: the SKILL.md body is read on demand. */
export const SharedSkill = Schema.Struct({
  location: SkillLocation,
  name: SkillName,
  description: Schema.optionalKey(TrimmedNonEmptyString),
  /** Absolute path of SKILL.md on the environment's host. */
  path: TrimmedNonEmptyString,
  /** The same file with symlinks resolved, when that differs. */
  realPath: Schema.optionalKey(TrimmedNonEmptyString),
  /** Digest of SKILL.md. An import names the revision that was previewed. */
  revision: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  /** Whether a user can run it from the composer. */
  invocable: Schema.Boolean,
  issues: Schema.Array(SkillCompatibilityIssue),
});
export type SharedSkill = typeof SharedSkill.Type;

export const SkillsListInput = Schema.Struct({
  /** The workspace whose project skills to list; absent lists global skills only. */
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
  includeImportable: Schema.optionalKey(Schema.Boolean),
});
export type SkillsListInput = typeof SkillsListInput.Type;

export const SkillsListResult = Schema.Struct({
  skills: Schema.Array(SharedSkill),
  importable: Schema.Array(SharedSkill),
});
export type SkillsListResult = typeof SkillsListResult.Type;

export const SkillsReadInput = Schema.Struct({
  location: SkillLocation,
  name: SkillName,
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SkillsReadInput = typeof SkillsReadInput.Type;

export const SkillFile = Schema.Struct({
  /** Relative to the skill folder, with forward slashes. */
  path: Schema.String,
  bytes: Schema.Number,
});
export type SkillFile = typeof SkillFile.Type;

export const SkillsReadResult = Schema.Struct({
  skill: SharedSkill,
  content: Schema.String,
  files: Schema.Array(SkillFile),
  /** Symlinks leading outside the skill folder, which an import leaves behind. */
  skippedLinks: Schema.Array(Schema.String),
});
export type SkillsReadResult = typeof SkillsReadResult.Type;

export const SkillsSetEnabledInput = Schema.Struct({
  location: SharedSkillSource,
  name: SkillName,
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
});
export type SkillsSetEnabledInput = typeof SkillsSetEnabledInput.Type;

export const SkillsRemoveInput = Schema.Struct({
  location: SharedSkillSource,
  name: SkillName,
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SkillsRemoveInput = typeof SkillsRemoveInput.Type;

export const SkillsImportInput = Schema.Struct({
  from: ImportableSkillSource,
  name: SkillName,
  to: SharedSkillSource,
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
  /** The previewed revision; the import is refused if the source changed since. */
  revision: TrimmedNonEmptyString,
});
export type SkillsImportInput = typeof SkillsImportInput.Type;

export const SkillsMutationResult = Schema.Struct({});
export type SkillsMutationResult = typeof SkillsMutationResult.Type;

export class SharedSkillError extends Schema.TaggedError<SharedSkillError>()("SharedSkillError", {
  reason: Schema.Literals([
    "not-found",
    "already-exists",
    "source-changed",
    "workspace-required",
    "too-large",
    "filesystem",
  ]),
  skillName: Schema.optionalKey(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return "The skill was not found.";
      case "already-exists":
        return "A skill with this name already exists there.";
      case "source-changed":
        return "The skill changed after it was previewed. Open it again.";
      case "workspace-required":
        return "Choose a project for this action.";
      case "too-large":
        return "The skill folder is too large to copy.";
      case "filesystem":
        return "Gustaf could not read or write the skill files.";
    }
  }
}
