import { assert, it } from "@effect/vitest";
import { GitCommandError, ProjectId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorktreeInventory from "./WorktreeInventory.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const projectId = ProjectId.make("project:inventory");
const at = "2026-11-01T00:00:00.000Z";

it.effect("joins durable paths with Git records, and inspects only a listed path on request", () =>
  Effect.gen(function* () {
    const statusPaths: string[] = [];
    const layer = WorktreeInventory.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ProjectStore.ProjectStoreV2)({
            list: (input) =>
              Effect.succeed(
                input?.projectIds?.length === 0
                  ? []
                  : [{ projectId, workspaceRoot: "/repo" } as ProjectStore.ProjectRow],
              ),
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
              } as never);
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
    const sql = yield* SqlClient.SqlClient;
    const fixtures = [
      {
        id: "thread:archived",
        worktreePath: "/work/changed",
        archived: true,
        pullRequests: [
          {
            number: 7,
            url: "https://example.test/pr/7",
            snapshot: { title: "Fix", state: "merged" },
          },
        ],
      },
      { id: "thread:deleted", worktreePath: "/work/missing", deleted: true },
      { id: "thread:local", worktreePath: null },
    ];
    for (const fixture of fixtures) {
      const payload = yield* encodePayload({
        branch: "topic",
        worktreePath: fixture.worktreePath,
        pullRequests: fixture.pullRequests,
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          ${fixture.id}, ${projectId}, 'Old thread', 'codex', 'full-access', 'default',
          ${at}, ${at}, ${fixture.archived ? at : null}, ${fixture.deleted ? at : null}, ${payload}
        )
      `;
    }

    yield* Effect.gen(function* () {
      const inventory = yield* WorktreeInventory.WorktreeInventory;
      const result = yield* inventory.list({ projectIds: [projectId] });
      assert.deepEqual(
        result.entries.map((entry) => [entry.path, entry.branch, entry.registered, entry.exists]),
        [
          ["/work/changed", "topic", true, true],
          ["/work/detached", null, true, true],
          ["/work/missing", "topic", false, false],
          ["/work/prunable", "gone", true, false],
        ],
      );
      assert.deepEqual(statusPaths, []);
      const changed = result.entries.find((entry) => entry.path === "/work/changed");
      assert.equal(changed?.threads[0]?.archived, true);
      assert.deepEqual(changed?.threads[0]?.pullRequests, [
        { number: 7, url: "https://example.test/pr/7", title: "Fix", state: "merged" },
      ]);
      assert.equal(
        result.entries.find((entry) => entry.path === "/work/missing")?.threads[0]?.deleted,
        true,
      );

      const inspected = yield* inventory.list({
        projectIds: [projectId],
        inspectPath: "/work/changed",
      });
      assert.equal(
        inspected.entries.find((entry) => entry.path === "/work/changed")?.hasWorkingTreeChanges,
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
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
