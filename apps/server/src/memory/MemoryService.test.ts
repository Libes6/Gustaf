import { MEMORY_MAX_CHARS, ProjectId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { MemoryService, make as makeMemoryService } from "./MemoryService.ts";

const makeTempDir = (prefix: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })));

function makeTestLayer(baseDir: string, claudeConfigDir: string) {
  const configLayer = ServerConfig.layerTest(process.cwd(), baseDir);
  return Layer.effect(MemoryService, makeMemoryService({ claudeConfigDir })).pipe(
    Layer.provide(configLayer),
    Layer.provide(NodeServices.layer),
  );
}

describe("MemoryService", () => {
  it.effect("reads empty notes, writes with revision increments, and clears", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempDir("gustaf-mem-base-");
      const claudeDir = yield* makeTempDir("gustaf-mem-claude-");
      const projectId = ProjectId.make("proj-1");

      yield* Effect.gen(function* () {
        const memory = yield* MemoryService;

        const initial = yield* memory.read({ scope: "global" });
        expect(initial.content).toBe("");
        expect(initial.revision).toBe(0);

        const written = yield* memory.write({
          scope: "global",
          content: "- Always run vp test run",
        });
        expect(written.content).toBe("- Always run vp test run");
        expect(written.revision).toBe(1);

        const saved = yield* memory.saveEntry({
          scope: "project",
          projectId,
          entry: "Use Effect.fn for server services",
          action: "append",
        });
        expect(saved.previousContent).toBe("");
        expect(saved.previousRevision).toBe(0);
        expect(saved.note.revision).toBe(1);
        expect(saved.note.content).toContain("Use Effect.fn for server services");

        const cleared = yield* memory.clear({ scope: "project", projectId });
        expect(cleared.content).toBe("");
        expect(cleared.revision).toBe(2);

        const bundle = yield* memory.readBundle({ projectId });
        expect(bundle.global.content).toBe("- Always run vp test run");
        expect(bundle.project?.content).toBe("");
      }).pipe(Effect.provide(makeTestLayer(baseDir, claudeDir)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("enforces maxChars limit and rejects invalid projectId traversal", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempDir("gustaf-mem-limit-");
      const claudeDir = yield* makeTempDir("gustaf-mem-claude-");

      yield* Effect.gen(function* () {
        const memory = yield* MemoryService;

        const tooLarge = yield* memory
          .write({ scope: "global", content: "x".repeat(MEMORY_MAX_CHARS + 1) })
          .pipe(Effect.flip);
        expect(tooLarge.code).toBe("too_large");

        const traversal = yield* memory
          .read({ scope: "project", projectId: ProjectId.make("../escape") })
          .pipe(Effect.flip);
        expect(traversal.code).toBe("invalid_scope");
      }).pipe(Effect.provide(makeTestLayer(baseDir, claudeDir)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("lists and imports Claude Code memory files with provenance", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTempDir("gustaf-mem-imp-");
      const claudeDir = yield* makeTempDir("gustaf-mem-claude-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectMemoryDir = path.join(claudeDir, "projects", "-Users-dev-gustaf", "memory");
      yield* fs.makeDirectory(projectMemoryDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(projectMemoryDir, "testing.md"),
        "---\nname: Testing rules\n---\n\nRun `vp test run` from the repo root.\n",
      );

      yield* Effect.gen(function* () {
        const memory = yield* MemoryService;

        const listed = yield* memory.listImportableFromClaude();
        expect(listed.entries).toHaveLength(1);
        expect(listed.entries[0]?.title).toBe("Testing rules");

        const imported = yield* memory.importFromClaude({
          scope: "global",
          entryIds: [listed.entries[0]!.id],
          mode: "append",
        });
        expect(imported.importedCount).toBe(1);
        expect(imported.note.content).toContain("Run `vp test run` from the repo root.");
        expect(imported.note.imports).toHaveLength(1);
        expect(imported.note.imports[0]?.sourcePath).toContain("testing.md");
      }).pipe(Effect.provide(makeTestLayer(baseDir, claudeDir)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
