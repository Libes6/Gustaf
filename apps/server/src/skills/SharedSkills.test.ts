import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SharedSkills from "./SharedSkills.ts";

const instanceId = ProviderInstanceId.make("codex");

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skills-home-" });
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skills-workspace-" });
  const config = yield* ServerConfig.ServerConfig;
  const writeSkill = (root: string, name: string, body: string, frontmatter = "") =>
    Effect.gen(function* () {
      const directory = path.join(root, name);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} skill\n${frontmatter}---\n${body}\n`,
      );
      return directory;
    });
  /** Native skill names the running provider reports for this workspace. */
  const native: Array<string> = [];
  const service = yield* Effect.gen(function* () {
    return yield* SharedSkills.SharedSkills;
  }).pipe(
    Effect.provide(
      SharedSkills.layer.pipe(
        Layer.provide(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.sync(() => [
              {
                instanceId,
                skills: native.map((name) => ({ name, path: `/native/${name}`, enabled: true })),
              } as unknown as ServerProvider,
            ]),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
      ),
    ),
    Effect.provideService(HostProcess.HomeDirectory, home),
  );
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, {}),
    );
  return {
    fileSystem,
    path,
    cwd,
    native,
    service,
    run,
    writeSkill,
    projectRoot: path.join(cwd, ".agents", "skills"),
    globalRoot: path.join(config.stateDir, "skills"),
    claudeUserRoot: path.join(home, ".claude", "skills"),
  };
});

const layerTest = ServerConfig.layerTest(process.cwd(), { prefix: "t3-shared-skills-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layerTest)("SharedSkills", (it) => {
  it.effect("injects a mentioned skill unless the provider runs that name itself", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      const project = yield* t.writeSkill(t.projectRoot, "deploy", "Run ${CLAUDE_SKILL_DIR}/go.sh");
      yield* t.writeSkill(t.globalRoot, "deploy", "Global deploy.");
      yield* t.writeSkill(t.globalRoot, "hidden", "Agent only.", "user-invocable: false\n");
      const prompt = (text: string) =>
        t.run(t.service.promptContext({ text, cwd: t.cwd, instanceId }));

      const bare = yield* prompt("please $deploy and $hidden but not $5 or $HOME");
      assert.include(bare, `directory="${project}"`);
      assert.include(bare, `Run ${project}/go.sh`);
      assert.notInclude(bare, "Global deploy.");
      assert.notInclude(bare, "Agent only.");

      t.native.push("deploy");
      assert.equal(yield* prompt("$deploy"), "");
      // The qualified name picks the shared copy past the provider's own.
      assert.include(yield* prompt("$global:deploy"), "Global deploy.");

      t.native.length = 0;
      yield* t.run(
        t.service.setEnabled({ location: "project", name: "deploy", cwd: t.cwd, enabled: false }),
      );
      assert.include(yield* prompt("$deploy"), "Global deploy.");
      assert.equal(yield* prompt("$project:deploy"), "");
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "imports a whole Claude skill folder without following links out of it",
    () =>
      Effect.gen(function* () {
        const t = yield* setup;
        const source = yield* t.writeSkill(t.claudeUserRoot, "review", "Review $ARGUMENTS.");
        yield* t.fileSystem.makeDirectory(t.path.join(source, "scripts"));
        yield* t.fileSystem.writeFileString(t.path.join(source, "scripts", "run.sh"), "echo hi\n");
        const outside = yield* t.fileSystem.makeTempFileScoped({ prefix: "t3-skills-outside-" });
        yield* t.fileSystem.symlink(outside, t.path.join(source, "secret"));

        const preview = yield* t.run(
          t.service.read({ location: "claude-user", name: "review", cwd: t.cwd }),
        );
        assert.deepEqual(
          preview.files.map((file) => file.path),
          ["SKILL.md", "scripts/run.sh"],
        );
        assert.deepEqual(preview.skippedLinks, ["secret"]);
        assert.deepEqual(preview.skill.issues, ["claude-arguments"]);

        const input = {
          from: "claude-user",
          name: "review",
          to: "project",
          cwd: t.cwd,
          revision: preview.skill.revision,
        } as const;
        const stale = yield* Effect.flip(
          t.run(t.service.importSkill({ ...input, revision: "stale" })),
        );
        assert.equal(stale.reason, "source-changed");

        yield* t.run(t.service.importSkill(input));
        const imported = t.path.join(t.projectRoot, "review");
        assert.equal(
          yield* t.fileSystem.readFileString(t.path.join(imported, "scripts", "run.sh")),
          "echo hi\n",
        );
        assert.isFalse(yield* t.fileSystem.exists(t.path.join(imported, "secret")));
        // No staging folder is left behind, and the original stays.
        assert.deepEqual(yield* t.fileSystem.readDirectory(t.projectRoot), ["review"]);
        assert.isTrue(yield* t.fileSystem.exists(t.path.join(source, "SKILL.md")));

        const again = yield* Effect.flip(t.run(t.service.importSkill(input)));
        assert.equal(again.reason, "already-exists");

        yield* t.run(t.service.remove({ location: "project", name: "review", cwd: t.cwd }));
        const listed = yield* t.run(t.service.list({ cwd: t.cwd, includeImportable: true }));
        assert.isFalse(listed.skills.some((skill) => skill.name === "review"));
        assert.isTrue(listed.importable.some((skill) => skill.name === "review"));
      }),
  );
});
