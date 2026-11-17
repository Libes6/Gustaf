import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  NativeMcpConfigError,
  type NativeMcpServer,
  parseClaudeConfig,
  parseCodexConfig,
  parseCursorConfig,
  parseGeminiConfig,
  parseProjectMcpConfig,
} from "./nativeMcp.ts";

export interface NativeMcpConfigLocations {
  readonly homeDir: string;
  readonly projectDir?: string;
}

export interface NativeMcpConfigList {
  readonly servers: ReadonlyArray<NativeMcpServer>;
  readonly errors: ReadonlyArray<NativeMcpConfigError>;
}

export class NativeMcpConfigs extends Context.Service<
  NativeMcpConfigs,
  {
    readonly list: (locations: NativeMcpConfigLocations) => Effect.Effect<NativeMcpConfigList>;
  }
>()("t3/mcpServers/import/NativeMcpConfigs") {}

const isNativeMcpConfigError = Schema.is(NativeMcpConfigError);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const list = Effect.fn("NativeMcpConfigs.list")(function* ({
    homeDir,
    projectDir,
  }: NativeMcpConfigLocations) {
    const home = path.resolve(homeDir);
    const project = projectDir === undefined ? undefined : path.resolve(projectDir);
    const files = [
      { path: path.join(home, ".codex/config.toml"), parse: parseCodexConfig },
      { path: path.join(home, ".cursor/mcp.json"), parse: parseCursorConfig },
      { path: path.join(home, ".claude.json"), parse: parseClaudeConfig },
      { path: path.join(home, ".gemini/settings.json"), parse: parseGeminiConfig },
      ...(project === undefined
        ? []
        : [
            {
              path: path.join(project, ".cursor/mcp.json"),
              parse: (text: string, file: string) => parseCursorConfig(text, file, project),
            },
            {
              path: path.join(project, ".mcp.json"),
              parse: (text: string, file: string) => parseProjectMcpConfig(text, file, project),
            },
          ]),
    ];
    const servers: NativeMcpServer[] = [];
    const errors: NativeMcpConfigError[] = [];
    for (const file of files) {
      const result = yield* fs.readFileString(file.path).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.undefined
              : Effect.fail(
                  new NativeMcpConfigError({ sourcePath: file.path, operation: "read", cause }),
                ),
        }),
        Effect.flatMap((text) =>
          text === undefined
            ? Effect.succeed([])
            : Effect.try({
                try: () => file.parse(text, file.path),
                catch: (cause) =>
                  isNativeMcpConfigError(cause)
                    ? cause
                    : new NativeMcpConfigError({
                        sourcePath: file.path,
                        operation: "decode",
                        cause,
                      }),
              }),
        ),
        Effect.result,
      );
      if (result._tag === "Success") servers.push(...result.success);
      else errors.push(result.failure);
    }
    return { servers, errors };
  });
  return NativeMcpConfigs.of({ list });
});

export const layer = Layer.effect(NativeMcpConfigs, make);
