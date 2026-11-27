// @effect-diagnostics nodeBuiltinImport:off - a content digest, not a security primitive.
import * as NodeCrypto from "node:crypto";

import {
  type ProviderInstanceId,
  type ServerProviderSkill,
  type SharedSkill,
  SharedSkillError,
  type SharedSkillSource,
  type SkillCompatibilityIssue,
  type SkillFile,
  type SkillLocation,
  SkillName,
  type SkillsImportInput,
  type SkillsListInput,
  type SkillsListResult,
  type SkillsReadInput,
  type SkillsReadResult,
  type SkillsRemoveInput,
  type SkillsSetEnabledInput,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import {
  parseSkillFrontmatter,
  resolveClaudeConfigDirPath,
} from "../provider/Drivers/ClaudeSkills.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

const MAX_SKILL_BYTES = 100_000;
/** Bodies one message may carry; later mentions are named but not inlined. */
const MAX_PROMPT_SKILL_BYTES = 200_000;
const MAX_ROOT_ENTRIES = 500;
const MAX_IMPORT_FILES = 500;
const MAX_IMPORT_BYTES = 20_000_000;

const DisabledState = Schema.fromJsonString(
  Schema.Struct({ disabled: Schema.Array(Schema.String) }),
);
const decodeDisabledState = Schema.decodeUnknownEffect(DisabledState);
const encodeDisabledState = Schema.encodeSync(DisabledState);

const isSharedSkillError = Schema.is(SharedSkillError);
const isSkillName = Schema.is(SkillName);

export class SharedSkills extends Context.Service<
  SharedSkills,
  {
    readonly list: (input: SkillsListInput) => Effect.Effect<SkillsListResult, SharedSkillError>;
    readonly read: (input: SkillsReadInput) => Effect.Effect<SkillsReadResult, SharedSkillError>;
    readonly setEnabled: (input: SkillsSetEnabledInput) => Effect.Effect<void, SharedSkillError>;
    readonly remove: (input: SkillsRemoveInput) => Effect.Effect<void, SharedSkillError>;
    /** Copies a Claude Code skill folder into a shared source; the original is left alone. */
    readonly importSkill: (input: SkillsImportInput) => Effect.Effect<void, SharedSkillError>;
    /**
     * The instructions a message's skill mentions add to its turn, or `""`. A mention the
     * provider's own CLI resolves is left to it. A skill that cannot be read adds nothing.
     */
    readonly promptContext: (input: {
      readonly text: string;
      readonly cwd: string | null;
      readonly instanceId: ProviderInstanceId;
    }) => Effect.Effect<string>;
  }
>()("t3/skills/SharedSkills") {}

/** The composer's mention grammar, minus the `:` that qualifies a shared skill's source. */
function isMentionableName(name: string): boolean {
  if (name.includes(":")) return false;
  const [mention] = `$${name}`.matchAll(SKILL_MENTION_PATTERN);
  return mention?.[2] === name;
}

function revisionOf(content: string): string {
  return NodeCrypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function claudeOnlyIssues(content: string): Array<SkillCompatibilityIssue> {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
  const issues: Array<SkillCompatibilityIssue> = [];
  if (content.includes("$ARGUMENTS")) issues.push("claude-arguments");
  if (/(^|\s)!`[^`\n]+`/m.test(content)) issues.push("claude-shell-commands");
  if (/^context:\s*fork\b/m.test(frontmatter)) issues.push("claude-fork-context");
  if (/^allowed-tools:/m.test(frontmatter)) issues.push("claude-allowed-tools");
  return issues;
}

function skillPromptBlock(input: {
  readonly mention: string;
  readonly directory: string;
  readonly content: string;
}): string {
  return [
    `The user ran the skill "$${input.mention}". Follow its instructions for this request.`,
    `<skill name="${input.mention}" directory="${input.directory}">`,
    "Relative paths in these instructions, such as references/ and scripts/, start at that directory.",
    "",
    input.content.replaceAll("${CLAUDE_SKILL_DIR}", input.directory).trim(),
    "</skill>",
  ].join("\n");
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const platformContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const stateLock = yield* Semaphore.make(1);
  const statePath = path.join(config.stateDir, "shared-skills.json");
  const globalRoot = path.join(config.stateDir, "skills");

  const filesystemError = (name?: string) => (cause: unknown) =>
    new SharedSkillError({ reason: "filesystem", cause, ...(name ? { skillName: name } : {}) });

  const claudeConfigDir = Effect.fn("SharedSkills.claudeConfigDir")(function* (
    cwd: string | undefined,
  ) {
    const current = yield* settings.getSettings.pipe(Effect.option);
    const instanceConfig =
      current._tag === "Some"
        ? (deriveProviderInstanceConfigMap(current.value) as Record<string, { config?: unknown }>)[
            "claudeAgent"
          ]?.config
        : undefined;
    const homePath = (instanceConfig as { homePath?: unknown } | undefined)?.homePath;
    const environment = yield* HostProcess.Environment;
    return yield* resolveClaudeConfigDirPath(
      { homePath: typeof homePath === "string" ? homePath : "" },
      environment,
      cwd,
    ).pipe(Effect.provideService(Path.Path, path));
  });

  /** The folder holding a location's skills, or undefined when it needs a workspace. */
  const rootOf = Effect.fn("SharedSkills.rootOf")(function* (
    location: SkillLocation,
    cwd: string | undefined,
  ) {
    const workspace = cwd !== undefined && path.isAbsolute(cwd) ? cwd : undefined;
    switch (location) {
      case "project":
        return workspace && path.join(workspace, ".agents", "skills");
      case "global":
        return globalRoot;
      case "claude-project":
        return workspace && path.join(workspace, ".claude", "skills");
      case "claude-user":
        return path.join(yield* claudeConfigDir(workspace), "skills");
    }
  });

  const requireRoot = Effect.fn("SharedSkills.requireRoot")(function* (
    location: SkillLocation,
    cwd: string | undefined,
  ) {
    const root = yield* rootOf(location, cwd);
    if (root === undefined) {
      return yield* new SharedSkillError({ reason: "workspace-required" });
    }
    return root;
  });

  const readDisabled = fileSystem.readFileString(statePath).pipe(
    Effect.flatMap(decodeDisabledState),
    Effect.map((state) => new Set(state.disabled)),
    Effect.orElseSucceed(() => new Set<string>()),
  );

  const writeDisabled = (key: string, disabled: boolean) =>
    stateLock.withPermits(1)(
      Effect.gen(function* () {
        const next = yield* readDisabled;
        if (disabled ? next.has(key) : !next.has(key)) return;
        if (disabled) next.add(key);
        else next.delete(key);
        yield* writeFileStringAtomically({
          filePath: statePath,
          contents: encodeDisabledState({ disabled: [...next].sort() }),
        }).pipe(Effect.provide(platformContext), Effect.mapError(filesystemError()));
      }),
    );

  /** One skill folder's metadata and body, or undefined when it holds no readable SKILL.md. */
  const loadSkill = Effect.fn("SharedSkills.loadSkill")(function* (
    location: SkillLocation,
    root: string,
    name: string,
    disabled: ReadonlySet<string>,
  ) {
    const directory = path.join(root, name);
    const skillPath = path.join(directory, "SKILL.md");
    const info = yield* fileSystem.stat(skillPath).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") return undefined;
    const tooLarge = info.value.size > BigInt(MAX_SKILL_BYTES);
    const content = tooLarge
      ? ""
      : yield* fileSystem.readFileString(skillPath).pipe(Effect.orElseSucceed(() => undefined));
    if (content === undefined) return undefined;
    const frontmatter = parseSkillFrontmatter(content);
    const issues: Array<SkillCompatibilityIssue> = [];
    if (!isMentionableName(name)) issues.push("invalid-name");
    if (frontmatter.kind === "malformed") issues.push("invalid-frontmatter");
    if (tooLarge) issues.push("too-large");
    if (frontmatter.kind === "parsed" && frontmatter.userInvocable === false) {
      issues.push("agent-only");
    }
    const invocable = issues.length === 0;
    issues.push(...claudeOnlyIssues(content));
    const realPath = yield* fileSystem
      .realPath(skillPath)
      .pipe(Effect.orElseSucceed(() => skillPath));
    const description = frontmatter.kind === "parsed" ? frontmatter.description : undefined;
    const skill: SharedSkill = {
      location,
      name,
      path: skillPath,
      revision: tooLarge ? `size-${info.value.size}` : revisionOf(content),
      enabled: !disabled.has(directory),
      invocable,
      issues,
      ...(realPath === skillPath ? {} : { realPath }),
      ...(description ? { description } : {}),
    };
    return { skill, content, directory };
  });

  const listLocation = Effect.fn("SharedSkills.listLocation")(function* (
    location: SkillLocation,
    cwd: string | undefined,
    disabled: ReadonlySet<string>,
  ) {
    const root = yield* rootOf(location, cwd);
    if (root === undefined) return [];
    const entries = yield* fileSystem
      .readDirectory(root)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const names = entries
      // A name the wire schema rejects would fail the whole list.
      .filter((entry) => !entry.startsWith(".") && isSkillName(entry))
      .sort()
      .slice(0, MAX_ROOT_ENTRIES);
    const loaded = yield* Effect.forEach(
      names,
      (name) => loadSkill(location, root, name, disabled),
      { concurrency: 8 },
    );
    return loaded.flatMap((entry) => (entry ? [entry.skill] : []));
  });

  const requireSkill = Effect.fn("SharedSkills.requireSkill")(function* (
    location: SkillLocation,
    name: string,
    cwd: string | undefined,
  ) {
    const root = yield* requireRoot(location, cwd);
    const loaded = yield* loadSkill(location, root, name, yield* readDisabled);
    if (loaded === undefined) {
      return yield* new SharedSkillError({ reason: "not-found", skillName: name });
    }
    return loaded;
  });

  /**
   * Every file of a skill folder. A symlink is followed only while it stays inside the folder,
   * so a copy cannot pull in unrelated files.
   */
  const walkSkill = Effect.fn("SharedSkills.walkSkill")(function* (
    directory: string,
    name: string,
  ) {
    const realRoot = yield* fileSystem.realPath(directory);
    const files: Array<SkillFile & { readonly source: string }> = [];
    const skippedLinks: Array<string> = [];
    let totalBytes = 0;
    const visit = Effect.fnUntraced(function* (
      realDirectory: string,
      relative: string,
      ancestors: ReadonlySet<string>,
    ): Effect.fn.Return<void, SharedSkillError | PlatformError.PlatformError> {
      const entries = yield* fileSystem.readDirectory(realDirectory);
      for (const entry of [...entries].sort()) {
        if (entry === ".git" || entry === ".DS_Store") continue;
        const entryPath = path.join(realDirectory, entry);
        const entryRelative = relative ? `${relative}/${entry}` : entry;
        const realPath = yield* fileSystem
          .realPath(entryPath)
          .pipe(Effect.orElseSucceed(() => undefined));
        const relativeToRoot = realPath === undefined ? ".." : path.relative(realRoot, realPath);
        const inside =
          relativeToRoot !== ".." &&
          !relativeToRoot.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativeToRoot);
        if (realPath === undefined || !inside) {
          skippedLinks.push(entryRelative);
          continue;
        }
        const info = yield* fileSystem.stat(realPath);
        if (info.type === "Directory") {
          if (ancestors.has(realPath)) {
            skippedLinks.push(entryRelative);
            continue;
          }
          yield* visit(realPath, entryRelative, new Set([...ancestors, realPath]));
        } else if (info.type === "File") {
          totalBytes += Number(info.size);
          files.push({ path: entryRelative, bytes: Number(info.size), source: realPath });
          if (files.length > MAX_IMPORT_FILES || totalBytes > MAX_IMPORT_BYTES) {
            return yield* new SharedSkillError({ reason: "too-large", skillName: name });
          }
        }
      }
    });
    yield* visit(realRoot, "", new Set([realRoot]));
    return { files, skippedLinks };
  });

  const asSkillError = (name: string) => (cause: SharedSkillError | PlatformError.PlatformError) =>
    isSharedSkillError(cause) ? cause : filesystemError(name)(cause);

  const list = Effect.fn("SharedSkills.list")(function* (input: SkillsListInput) {
    const disabled = yield* readDisabled;
    const collect = (locations: ReadonlyArray<SkillLocation>) =>
      Effect.forEach(locations, (location) => listLocation(location, input.cwd, disabled)).pipe(
        Effect.map((groups) => groups.flat()),
      );
    return {
      skills: yield* collect(["project", "global"]),
      importable: input.includeImportable ? yield* collect(["claude-project", "claude-user"]) : [],
    };
  });

  const read = Effect.fn("SharedSkills.read")(function* (input: SkillsReadInput) {
    const loaded = yield* requireSkill(input.location, input.name, input.cwd);
    const { files, skippedLinks } = yield* walkSkill(loaded.directory, input.name).pipe(
      Effect.mapError(asSkillError(input.name)),
    );
    return {
      skill: loaded.skill,
      content: loaded.content,
      files: files.map(({ path: filePath, bytes }) => ({ path: filePath, bytes })),
      skippedLinks,
    };
  });

  const setEnabled = Effect.fn("SharedSkills.setEnabled")(function* (input: SkillsSetEnabledInput) {
    const loaded = yield* requireSkill(input.location, input.name, input.cwd);
    yield* writeDisabled(loaded.directory, !input.enabled);
  });

  const remove = Effect.fn("SharedSkills.remove")(function* (input: SkillsRemoveInput) {
    const loaded = yield* requireSkill(input.location, input.name, input.cwd);
    // Removing a symlinked skill folder removes the link, not what it points to.
    yield* fileSystem
      .remove(loaded.directory, { recursive: true })
      .pipe(Effect.mapError(filesystemError(input.name)));
    yield* writeDisabled(loaded.directory, false);
  });

  const importSkill = Effect.fn("SharedSkills.importSkill")(function* (input: SkillsImportInput) {
    const source = yield* requireSkill(input.from, input.name, input.cwd);
    const root = yield* requireRoot(input.to, input.cwd);
    const destination = path.join(root, input.name);
    if (source.skill.revision !== input.revision) {
      return yield* new SharedSkillError({ reason: "source-changed", skillName: input.name });
    }
    if (yield* fileSystem.exists(destination).pipe(Effect.mapError(filesystemError(input.name)))) {
      return yield* new SharedSkillError({ reason: "already-exists", skillName: input.name });
    }
    yield* Effect.gen(function* () {
      const { files } = yield* walkSkill(source.directory, input.name);
      yield* fileSystem.makeDirectory(root, { recursive: true });
      // Copied beside the destination first, so a failed copy never leaves a partial skill.
      const staging = yield* fileSystem.makeTempDirectory({ directory: root, prefix: ".import-" });
      yield* Effect.gen(function* () {
        for (const file of files) {
          const target = path.join(staging, ...file.path.split("/"));
          yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
          yield* fileSystem.copyFile(file.source, target);
        }
        yield* fileSystem.chmod(staging, 0o755);
        yield* fileSystem.rename(staging, destination);
      }).pipe(
        Effect.ensuring(
          fileSystem.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );
    }).pipe(Effect.mapError(asSkillError(input.name)));
    // A skill re-imported under a name that was once disabled starts enabled.
    yield* writeDisabled(destination, false);
  });

  /** What the instance's CLI itself resolves in this workspace. */
  const nativeSkills = Effect.fn("SharedSkills.nativeSkills")(function* (
    instanceId: ProviderInstanceId,
    cwd: string | null,
  ) {
    const providers = yield* registry.getProviders;
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    const skills: ReadonlyArray<ServerProviderSkill> =
      provider?.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)?.skills ??
      provider?.skills ??
      [];
    return new Set(
      skills
        .filter((skill) => skill.enabled && skill.userInvocable !== false)
        .map((skill) => skill.name),
    );
  });

  const promptContext = Effect.fn("SharedSkills.promptContext")(
    function* (input: {
      readonly text: string;
      readonly cwd: string | null;
      readonly instanceId: ProviderInstanceId;
    }) {
      const mentions = new Set(
        [...input.text.matchAll(SKILL_MENTION_PATTERN)].map((match) => match[2] ?? ""),
      );
      if (mentions.size === 0) return "";
      const cwd = input.cwd ?? undefined;
      const disabled = yield* readDisabled;
      const native = yield* nativeSkills(input.instanceId, input.cwd);
      const blocks: Array<string> = [];
      const included = new Set<string>();
      let bytes = 0;
      for (const mention of mentions) {
        // The provider runs its own skill of this exact name.
        if (native.has(mention)) continue;
        const qualified = /^(project|global):(.+)$/.exec(mention);
        const sources: ReadonlyArray<SharedSkillSource> = qualified
          ? [qualified[1] as SharedSkillSource]
          : ["project", "global"];
        const name = qualified?.[2] ?? mention;
        if (!isMentionableName(name)) continue;
        for (const source of sources) {
          const root = yield* rootOf(source, cwd);
          if (root === undefined) continue;
          const loaded = yield* loadSkill(source, root, name, disabled);
          if (!loaded?.skill.enabled || !loaded.skill.invocable) continue;
          if (included.has(loaded.directory)) break;
          included.add(loaded.directory);
          bytes += Buffer.byteLength(loaded.content);
          blocks.push(
            bytes > MAX_PROMPT_SKILL_BYTES
              ? `The user ran the skill "$${mention}". Read ${loaded.skill.path} and follow it.`
              : skillPromptBlock({
                  mention,
                  directory: loaded.directory,
                  content: loaded.content,
                }),
          );
          break;
        }
      }
      return blocks.join("\n\n");
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to read shared skills for a turn", { cause }).pipe(Effect.as("")),
    ),
  );

  return SharedSkills.of({ list, read, setEnabled, remove, importSkill, promptContext });
});

export const layer = Layer.effect(SharedSkills, make);
