import { assert, it } from "@effect/vitest";
import { GitCommandError, ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorktreeInventory from "./WorktreeInventory.ts";

it.effect("joins durable paths with Git records, and inspects only a listed path on request", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:inventory");
    const now = yield* DateTime.now;
    const statusPaths: string[] = [];
    const threads = ["/work/changed", "/work/missing"].map((worktreePath, index) => ({
      id: ThreadId.make(`thread:${index}`),
      projectId,
      worktreePath,
      title: "Old thread",
      branch: "topic",
      archived: index === 0,
      deleted: index === 1,
      pullRequests: [],
    }));
    const layer = WorktreeInventory.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ProjectStore.ProjectStoreV2)({
            list: (input) =>
              Effect.succeed(
                input?.projectIds?.length === 0
                  ? []
                  : [
                      {
                        projectId,
                        workspaceRoot: "/repo",
                        title: "Project",
                        defaultModelSelection: null,
                        defaultThreadEnvMode: null,
                        autoPull: false,
                        faviconPath: null,
                        projectIcon: null,
                        scripts: [],
                        pinnedAt: null,
                        archivedAt: null,
                        deletedAt: null,
                        createdAt: DateTime.formatIso(now),
                        updatedAt: DateTime.formatIso(now),
                      },
                    ],
              ),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getWorktreeInventoryThreads: (ids) => Effect.succeed(ids?.length === 0 ? [] : threads),
          }),
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            listWorktrees: () =>
              Effect.succeed([
                { path: "/work/changed", branch: "topic", prunable: false },
                { path: "/work/detached", branch: null, prunable: false },
                { path: "/work/prunable", branch: "gone", prunable: true },
              ]),
          }),
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: ({ cwd }) => {
              statusPaths.push(cwd);
              return Effect.succeed({
                isRepo: true,
                hasWorkingTreeChanges: true,
                hasPrimaryRemote: false,
                isDefaultRef: false,
                refName: "topic",
                workingTree: { files: [], insertions: 0, deletions: 0 },
              });
            },
          }),
          FileSystem.layerNoop({
            realPath: (value) => Effect.succeed(value),
            exists: (value) =>
              Effect.succeed(!value.endsWith("missing") && !value.endsWith("prunable")),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const inventory = yield* WorktreeInventory.WorktreeInventory;
      const result = yield* inventory.list({ projectIds: [projectId] });
      assert.equal(result.entries.length, 4);
      assert.deepEqual(statusPaths, []);
      assert.equal(
        result.entries.find((e) => e.path.endsWith("missing"))?.threads[0]?.deleted,
        true,
      );
      assert.equal(result.entries.find((e) => e.path.endsWith("detached"))?.branch, null);
      assert.equal(result.entries.find((e) => e.path.endsWith("prunable"))?.prunable, true);
      assert.isTrue(result.entries.every((entry) => entry.origin === "unknown"));
      const inspected = yield* inventory.list({
        projectIds: [projectId],
        inspectPath: "/work/changed",
      });
      assert.equal(
        inspected.entries.find((e) => e.path.endsWith("changed"))?.hasWorkingTreeChanges,
        true,
      );
      assert.deepEqual(statusPaths, ["/work/changed"]);
      const rejected = yield* inventory
        .list({ projectIds: [projectId], inspectPath: "/other/repo" })
        .pipe(Effect.flip);
      assert.instanceOf(rejected, GitCommandError);
      assert.deepEqual(statusPaths, ["/work/changed"]);
      assert.deepEqual((yield* inventory.list({ projectIds: [] })).entries, []);
    }).pipe(Effect.provide(layer));
  }),
);
