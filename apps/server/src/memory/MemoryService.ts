import * as NodeOS from "node:os";
import {
  IsoDateTime,
  MEMORY_MAX_CHARS,
  MemoryError,
  MemoryImportRecord,
  NonNegativeInt,
  type MemoryClaudeImportableEntry,
  type MemoryClearInput,
  type MemoryImportFromClaudeInput,
  type MemoryImportFromClaudeResult,
  type MemoryListImportableFromClaudeResult,
  type MemoryNote,
  type MemoryReadInput,
  type MemorySaveAction,
  type MemoryScope,
  type MemoryWriteInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

const MemoryMeta = Schema.Struct({
  revision: NonNegativeInt,
  updatedAt: Schema.NullOr(IsoDateTime),
  imports: Schema.Array(MemoryImportRecord),
});
type MemoryMeta = typeof MemoryMeta.Type;

const decodeMemoryMeta = Schema.decodeUnknownOption(Schema.fromJsonString(MemoryMeta));
const encodeMemoryMeta = Schema.encodeSync(Schema.fromJsonString(MemoryMeta));

const CLAUDE_PREVIEW_MAX_CHARS = 320;
const INVALID_SEGMENT_PATTERN = /[/\\\0]|\.\./;

export interface MemorySaveEntryInput {
  readonly scope: MemoryScope;
  readonly projectId?: ProjectId;
  readonly entry: string;
  readonly action: MemorySaveAction;
}

export interface MemorySaveEntryResult {
  readonly note: MemoryNote;
  readonly previousContent: string;
  readonly previousRevision: number;
}

export interface MemoryBundle {
  readonly global: MemoryNote;
  readonly project: MemoryNote | null;
}

export interface MemoryServiceOptions {
  readonly claudeConfigDir?: string;
}

export class MemoryService extends Context.Service<
  MemoryService,
  {
    readonly read: (input: MemoryReadInput) => Effect.Effect<MemoryNote, MemoryError>;
    readonly write: (input: MemoryWriteInput) => Effect.Effect<MemoryNote, MemoryError>;
    readonly clear: (input: MemoryClearInput) => Effect.Effect<MemoryNote, MemoryError>;
    readonly saveEntry: (
      input: MemorySaveEntryInput,
    ) => Effect.Effect<MemorySaveEntryResult, MemoryError>;
    readonly listImportableFromClaude: () => Effect.Effect<
      MemoryListImportableFromClaudeResult,
      MemoryError
    >;
    readonly importFromClaude: (
      input: MemoryImportFromClaudeInput,
    ) => Effect.Effect<MemoryImportFromClaudeResult, MemoryError>;
    readonly readBundle: (input: {
      readonly projectId?: ProjectId;
    }) => Effect.Effect<MemoryBundle, MemoryError>;
  }
>()("t3/memory/MemoryService") {}

function decodeClaudeProjectLabel(projectSlug: string): string {
  const trimmed = projectSlug.trim();
  if (trimmed === "") return projectSlug;
  const parts = trimmed.replace(/^-+/, "").split("-").filter(Boolean);
  if (parts.length === 0) return projectSlug;
  return parts.length <= 3 ? parts.join("/") : `…/${parts.slice(-2).join("/")}`;
}

function extractMarkdownTitle(content: string, fileName: string): string {
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (frontmatterMatch?.[1] !== undefined) {
    const nameLine = /^\s*name\s*:\s*(.+)$/mu.exec(frontmatterMatch[1]);
    if (nameLine?.[1]?.trim()) {
      return nameLine[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  const headingMatch = /^\s*#\s+(.+)$/mu.exec(content);
  if (headingMatch?.[1]?.trim()) {
    return headingMatch[1].trim();
  }
  return fileName.replace(/\.md$/i, "");
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "").trim();
}

function buildPreview(content: string): string {
  const body = stripFrontmatter(content).replace(/\s+/g, " ").trim();
  if (body.length <= CLAUDE_PREVIEW_MAX_CHARS) return body;
  return `${body.slice(0, CLAUDE_PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

function formatIsoDateDay(iso: IsoDateTime): string {
  return iso.slice(0, 10);
}

export const make = Effect.fn("MemoryService.make")(function* (options: MemoryServiceOptions = {}) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writeLock = yield* Semaphore.make(1);

  const resolveClaudeProjectsDir = () => {
    const base =
      options.claudeConfigDir ??
      process.env.CLAUDE_CONFIG_DIR?.trim() ??
      path.join(NodeOS.homedir(), ".claude");
    return path.join(base, "projects");
  };

  const resolvePaths = Effect.fn("MemoryService.resolvePaths")(function* (
    scope: MemoryScope,
    projectId?: ProjectId,
  ) {
    if (scope === "global") {
      return {
        projectId: null as ProjectId | null,
        dir: config.memoryDir,
        notePath: path.join(config.memoryDir, "global.md"),
        metaPath: path.join(config.memoryDir, "global.meta.json"),
      };
    }
    if (projectId === undefined || INVALID_SEGMENT_PATTERN.test(projectId)) {
      return yield* new MemoryError({
        code: "invalid_scope",
        message:
          projectId === undefined
            ? "A projectId is required for project memory."
            : "Invalid projectId for memory storage.",
      });
    }
    const projectsDir = path.join(config.memoryDir, "projects");
    return {
      projectId,
      dir: projectsDir,
      notePath: path.join(projectsDir, `${projectId}.md`),
      metaPath: path.join(projectsDir, `${projectId}.meta.json`),
    };
  });

  const readInternal = Effect.fn("MemoryService.readInternal")(function* (
    scope: MemoryScope,
    projectId?: ProjectId,
  ) {
    const target = yield* resolvePaths(scope, projectId);
    const [noteExists, metaExists] = yield* Effect.all([
      fs.exists(target.notePath).pipe(Effect.orElseSucceed(() => false)),
      fs.exists(target.metaPath).pipe(Effect.orElseSucceed(() => false)),
    ]);

    const content = noteExists
      ? yield* fs.readFileString(target.notePath).pipe(
          Effect.mapError(
            (cause) =>
              new MemoryError({
                code: "io_error",
                message: "Failed to read memory note.",
                cause,
              }),
          ),
        )
      : "";

    let meta: MemoryMeta | undefined;
    if (metaExists) {
      const rawMeta = yield* fs
        .readFileString(target.metaPath)
        .pipe(Effect.orElseSucceed(() => ""));
      const parsed = decodeMemoryMeta(rawMeta);
      if (Option.isSome(parsed)) {
        meta = parsed.value;
      }
    }

    let updatedAt: IsoDateTime | null = meta?.updatedAt ?? null;
    if (updatedAt === null && noteExists) {
      const stat = yield* fs.stat(target.notePath).pipe(Effect.option);
      if (Option.isSome(stat) && Option.isSome(stat.value.mtime)) {
        updatedAt = IsoDateTime.make(stat.value.mtime.value.toISOString());
      }
    }

    const revision = meta?.revision ?? (noteExists && content.trim() !== "" ? 1 : 0);
    return {
      scope,
      projectId: target.projectId,
      content,
      revision,
      maxChars: MEMORY_MAX_CHARS,
      updatedAt,
      imports: meta?.imports ?? [],
    } satisfies MemoryNote;
  });

  const writeInternal = Effect.fn("MemoryService.writeInternal")(function* (input: {
    readonly scope: MemoryScope;
    readonly projectId?: ProjectId;
    readonly content: string;
    readonly imports?: ReadonlyArray<MemoryImportRecord>;
  }) {
    if (input.content.length > MEMORY_MAX_CHARS) {
      return yield* new MemoryError({
        code: "too_large",
        message: `Memory note exceeds the ${MEMORY_MAX_CHARS.toLocaleString("en-US")} character limit.`,
        maxChars: MEMORY_MAX_CHARS,
        actualChars: input.content.length,
      });
    }
    const target = yield* resolvePaths(input.scope, input.projectId);
    const current = yield* readInternal(input.scope, input.projectId);
    const now = yield* DateTime.now;
    const updatedAt = IsoDateTime.make(DateTime.formatIso(now));
    const nextRevision = current.revision + 1;
    const nextImports = input.imports ?? current.imports;
    const normalizedContent = input.content.trim() === "" ? "" : input.content;

    yield* fs.makeDirectory(target.dir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new MemoryError({
            code: "io_error",
            message: "Failed to prepare memory storage directory.",
            cause,
          }),
      ),
    );

    if (normalizedContent === "") {
      yield* fs.remove(target.notePath, { force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new MemoryError({
              code: "io_error",
              message: "Failed to clear memory note.",
              cause,
            }),
        ),
      );
    } else {
      yield* fs.writeFileString(target.notePath, normalizedContent).pipe(
        Effect.mapError(
          (cause) =>
            new MemoryError({
              code: "io_error",
              message: "Failed to write memory note.",
              cause,
            }),
        ),
      );
    }

    const metaPayload = encodeMemoryMeta({
      revision: nextRevision,
      updatedAt,
      imports: [...nextImports],
    });
    yield* fs.writeFileString(target.metaPath, metaPayload).pipe(
      Effect.mapError(
        (cause) =>
          new MemoryError({
            code: "io_error",
            message: "Failed to write memory metadata.",
            cause,
          }),
      ),
    );

    return {
      scope: input.scope,
      projectId: target.projectId,
      content: normalizedContent,
      revision: nextRevision,
      maxChars: MEMORY_MAX_CHARS,
      updatedAt,
      imports: [...nextImports],
    } satisfies MemoryNote;
  });

  const read = Effect.fn("MemoryService.read")(function* (input: MemoryReadInput) {
    return yield* readInternal(input.scope, input.projectId);
  });

  const write = Effect.fn("MemoryService.write")(function* (input: MemoryWriteInput) {
    return yield* writeLock.withPermits(1)(
      writeInternal({
        scope: input.scope,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        content: input.content,
      }),
    );
  });

  const clear = Effect.fn("MemoryService.clear")(function* (input: MemoryClearInput) {
    return yield* writeLock.withPermits(1)(
      writeInternal({
        scope: input.scope,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        content: "",
        imports: [],
      }),
    );
  });

  const saveEntry = Effect.fn("MemoryService.saveEntry")(function* (input: MemorySaveEntryInput) {
    return yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* readInternal(input.scope, input.projectId);
        const trimmedEntry = input.entry.trim();
        const nextContent =
          input.action === "replace"
            ? trimmedEntry
            : current.content.trim() === ""
              ? trimmedEntry
              : `${current.content.trimEnd()}\n\n${trimmedEntry}`;
        const note = yield* writeInternal({
          scope: input.scope,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          content: nextContent,
        });
        return {
          note,
          previousContent: current.content,
          previousRevision: current.revision,
        } satisfies MemorySaveEntryResult;
      }),
    );
  });

  const scanClaudeEntries = Effect.fn("MemoryService.scanClaudeEntries")(function* () {
    const projectsDir = resolveClaudeProjectsDir();
    const exists = yield* fs.exists(projectsDir).pipe(Effect.orElseSucceed(() => false));
    if (!exists)
      return [] as ReadonlyArray<MemoryClaudeImportableEntry & { readonly content: string }>;

    const projectDirs = yield* fs
      .readDirectory(projectsDir)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

    const results: Array<MemoryClaudeImportableEntry & { readonly content: string }> = [];
    for (const projectSlug of projectDirs) {
      if (INVALID_SEGMENT_PATTERN.test(projectSlug)) continue;
      const memoryDir = path.join(projectsDir, projectSlug, "memory");
      const memoryDirExists = yield* fs.exists(memoryDir).pipe(Effect.orElseSucceed(() => false));
      if (!memoryDirExists) continue;
      const files = yield* fs
        .readDirectory(memoryDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      for (const fileName of files) {
        if (!fileName.toLowerCase().endsWith(".md") || INVALID_SEGMENT_PATTERN.test(fileName)) {
          continue;
        }
        const sourcePath = path.join(memoryDir, fileName);
        const content = yield* fs.readFileString(sourcePath).pipe(Effect.option);
        if (Option.isNone(content) || content.value.trim() === "") continue;
        const stat = yield* fs.stat(sourcePath).pipe(Effect.option);
        const modifiedAt =
          Option.isSome(stat) && Option.isSome(stat.value.mtime)
            ? IsoDateTime.make(stat.value.mtime.value.toISOString())
            : null;
        results.push({
          id: `${projectSlug}/${fileName}`,
          sourcePath,
          projectSlug,
          projectLabel: decodeClaudeProjectLabel(projectSlug),
          fileName,
          title: extractMarkdownTitle(content.value, fileName),
          preview: buildPreview(content.value),
          charCount: content.value.length,
          modifiedAt,
          content: content.value,
        });
      }
    }

    results.sort((a, b) => {
      if (a.modifiedAt && b.modifiedAt && a.modifiedAt !== b.modifiedAt) {
        return b.modifiedAt.localeCompare(a.modifiedAt);
      }
      return a.id.localeCompare(b.id);
    });
    return results;
  });

  const listImportableFromClaude = Effect.fn("MemoryService.listImportableFromClaude")(
    function* () {
      const scanned = yield* scanClaudeEntries();
      return {
        entries: scanned.map(({ content: _content, ...entry }) => entry),
      } satisfies MemoryListImportableFromClaudeResult;
    },
  );

  const importFromClaude = Effect.fn("MemoryService.importFromClaude")(function* (
    input: MemoryImportFromClaudeInput,
  ) {
    return yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const scanned = yield* scanClaudeEntries();
        const byId = new Map(scanned.map((entry) => [entry.id, entry]));
        const selected = input.entryIds
          .map((id) => byId.get(id))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
        if (selected.length === 0) {
          return yield* new MemoryError({
            code: "not_found",
            message: "No matching Claude Code memory entries were found to import.",
          });
        }

        const current = yield* readInternal(input.scope, input.projectId);
        const now = yield* DateTime.now;
        const importedAt = IsoDateTime.make(DateTime.formatIso(now));
        const day = formatIsoDateDay(importedAt);

        const formattedBlocks = selected.map((entry) => {
          const body = stripFrontmatter(entry.content);
          return `<!-- Imported from Claude Code: ${entry.projectLabel} / ${entry.fileName} (${day}) -->\n${body}`;
        });
        const importedText = formattedBlocks.join("\n\n");
        const nextContent =
          input.mode === "replace"
            ? importedText
            : current.content.trim() === ""
              ? importedText
              : `${current.content.trimEnd()}\n\n${importedText}`;

        const newImportRecords: ReadonlyArray<MemoryImportRecord> = selected.map((entry) => ({
          sourcePath: entry.sourcePath,
          sourceLabel: `${entry.projectLabel} / ${entry.fileName}`,
          importedAt,
        }));
        const baseImports = input.mode === "replace" ? [] : current.imports;
        const note = yield* writeInternal({
          scope: input.scope,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          content: nextContent,
          imports: [...baseImports, ...newImportRecords],
        });

        return {
          note,
          importedCount: selected.length,
        } satisfies MemoryImportFromClaudeResult;
      }),
    );
  });

  const readBundle = Effect.fn("MemoryService.readBundle")(function* (input: {
    readonly projectId?: ProjectId;
  }) {
    const global = yield* readInternal("global");
    const project =
      input.projectId === undefined ? null : yield* readInternal("project", input.projectId);
    return { global, project } satisfies MemoryBundle;
  });

  return MemoryService.of({
    read,
    write,
    clear,
    saveEntry,
    listImportableFromClaude,
    importFromClaude,
    readBundle,
  });
});

export const layer = Layer.effect(MemoryService, make());
