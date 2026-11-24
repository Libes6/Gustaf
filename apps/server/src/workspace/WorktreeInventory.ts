import {
  GitCommandError,
  ProjectId,
  ThreadId,
  type WorktreeInventoryEntry,
  type WorktreeInventoryInput,
  type WorktreeInventoryResult,
  type WorktreeInventoryThread,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export class WorktreeInventory extends Context.Service<
  WorktreeInventory,
  {
    readonly list: (
      input: WorktreeInventoryInput,
    ) => Effect.Effect<WorktreeInventoryResult, GitCommandError>;
  }
>()("t3/workspace/WorktreeInventory") {}

const isGitCommandError = Schema.is(GitCommandError);

// Only the fields the inventory shows; links written by older servers may lack the rest.
const decodePullRequests = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          number: Schema.Number,
          url: Schema.String,
          snapshot: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                title: Schema.optional(Schema.String),
                state: Schema.optional(Schema.Literals(["open", "closed", "merged"])),
              }),
            ),
          ),
        }),
      ),
    ),
  ),
);

interface WorktreeThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly branch: string | null;
  readonly worktree_path: string;
  readonly archived_at: string | null;
  readonly deleted_at: string | null;
  readonly pull_requests: string | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Deleted and archived threads stay in: their worktrees are what an inventory is for.
  const readThreads = Effect.fn("WorktreeInventory.readThreads")(function* (
    projectIds: ReadonlyArray<ProjectId>,
  ) {
    if (projectIds.length === 0) return [];
    const rows = yield* sql<WorktreeThreadRow>`
      SELECT
        thread_id,
        project_id,
        title,
        json_extract(payload_json, '$.branch') AS branch,
        json_extract(payload_json, '$.worktreePath') AS worktree_path,
        archived_at,
        deleted_at,
        json_extract(payload_json, '$.pullRequests') AS pull_requests
      FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL
        AND ${sql.in("project_id", projectIds)}
      ORDER BY thread_id
    `;
    return yield* Effect.forEach(rows, (row) =>
      decodePullRequests(row.pull_requests ?? "null").pipe(
        Effect.orElseSucceed(() => null),
        Effect.map((pullRequests): WorktreeInventoryThread => ({
          id: ThreadId.make(row.thread_id),
          projectId: ProjectId.make(row.project_id),
          title: row.title,
          branch: row.branch,
          worktreePath: row.worktree_path,
          archived: row.archived_at !== null,
          deleted: row.deleted_at !== null,
          pullRequests: (pullRequests ?? []).map((pr) => ({
            number: pr.number,
            url: pr.url,
            title: pr.snapshot?.title ?? null,
            state: pr.snapshot?.state ?? null,
          })),
        })),
      ),
    );
  });

  const list: WorktreeInventory["Service"]["list"] = Effect.fn("WorktreeInventory.list")(
    function* (input) {
      const selected = yield* projects.list(
        input.projectIds === undefined ? {} : { projectIds: input.projectIds },
      );
      const threads = yield* readThreads(selected.map((project) => project.projectId));
      // Resolve aliases without losing the durable path of a missing directory.
      const canonical = (value: string) =>
        fs.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
      const entries = new Map<string, WorktreeInventoryEntry>();
      const errors: Array<WorktreeInventoryResult["errors"][number]> = [];
      for (const project of selected) {
        const listed = yield* git.listWorktrees(project.workspaceRoot).pipe(
          Effect.catch(() => {
            errors.push({
              projectId: project.projectId,
              message: "Could not read the project's Git worktrees.",
            });
            return Effect.succeed([]);
          }),
        );
        for (const worktree of listed) {
          const key = yield* canonical(worktree.path);
          const previous = entries.get(key);
          entries.set(key, {
            path: worktree.path,
            branch: worktree.branch,
            registered: true,
            exists: yield* fs.exists(worktree.path),
            prunable: worktree.prunable,
            origin: "unknown",
            projectIds: [...new Set([...(previous?.projectIds ?? []), project.projectId])],
            threads: previous?.threads ?? [],
            hasWorkingTreeChanges: null,
            error: null,
          });
        }
      }
      for (const thread of threads) {
        const key = yield* canonical(thread.worktreePath);
        const entry = entries.get(key) ?? {
          path: thread.worktreePath,
          branch: thread.branch,
          registered: false,
          exists: yield* fs.exists(thread.worktreePath),
          prunable: false,
          origin: "unknown" as const,
          projectIds: [],
          threads: [],
          hasWorkingTreeChanges: null,
          error: null,
        };
        entries.set(key, {
          ...entry,
          projectIds: [...new Set([...entry.projectIds, thread.projectId])],
          threads: [...entry.threads, thread],
        });
      }
      // Checking for file changes runs Git in the folder, so only the one path asked about.
      if (input.inspectPath !== undefined) {
        const key = yield* canonical(input.inspectPath);
        const entry = entries.get(key);
        if (entry === undefined)
          return yield* new GitCommandError({
            operation: "WorktreeInventory.inspect",
            command: "inventory",
            cwd: input.inspectPath,
            detail: "Worktree is not in the selected projects.",
          });
        if (entry.exists) {
          const status = yield* workflow.localStatus({ cwd: entry.path }).pipe(
            Effect.map((status) => ({
              hasWorkingTreeChanges: status.isRepo ? status.hasWorkingTreeChanges : null,
              error: status.isRepo ? null : "The folder is no longer a Git repository.",
            })),
            Effect.orElseSucceed(() => ({
              hasWorkingTreeChanges: null,
              error: "Could not check for file changes.",
            })),
          );
          entries.set(key, { ...entry, ...status });
        }
      }
      return {
        entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
        errors,
      };
    },
    Effect.mapError((cause) =>
      isGitCommandError(cause)
        ? cause
        : new GitCommandError({
            operation: "WorktreeInventory.list",
            command: "inventory",
            cwd: "",
            detail: "Unable to read worktree inventory.",
            cause,
          }),
    ),
  );
  return WorktreeInventory.of({ list });
});

export const layer = Layer.effect(WorktreeInventory, make);
