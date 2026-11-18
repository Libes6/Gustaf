import {
  McpServerConfig,
  type McpImportInput,
  type McpImportableServer,
  type McpListImportableInput,
  type McpListImportableResult,
  type McpImportResult,
  McpServerImportError,
  type McpServerId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { NativeMcpConfigs } from "./import/NativeMcpConfigs.ts";
import { findNativeDuplicate, toMcpServerName } from "./import/matcher.ts";
import type { NativeMcpServer } from "./import/nativeMcp.ts";

/** Copies MCP servers from other agents' configs on this environment into Gustaf's settings. */
export class McpServerImport extends Context.Service<
  McpServerImport,
  {
    /** What can be imported; env and header values stay here, only their names go out. */
    readonly list: (
      input: McpListImportableInput,
    ) => Effect.Effect<McpListImportableResult, McpServerImportError>;
    /** Writes the chosen entries turned off, their env and header values as stored secrets. */
    readonly importServers: (
      input: McpImportInput,
    ) => Effect.Effect<McpImportResult, McpServerImportError>;
  }
>()("t3/mcpServers/McpServerImport") {}

const decodeConfig = Schema.decodeUnknownEffect(McpServerConfig);

const sameEntry = (
  native: NativeMcpServer,
  key: { readonly source: string; readonly name: string; readonly projectDir?: string },
) =>
  native.source === key.source && native.name === key.name && native.projectDir === key.projectDir;

const isInGustaf = (native: NativeMcpServer, configs: ReadonlyArray<McpServerConfig>) =>
  configs.some(
    ({ transport }) =>
      findNativeDuplicate(
        transport.type === "stdio"
          ? {
              name: native.name,
              transport: "stdio",
              command: transport.command,
              args: transport.args,
            }
          : { name: native.name, transport: "http", url: transport.url },
        [native],
      ) !== undefined,
  );

const toImportable = (
  native: NativeMcpServer,
  configs: ReadonlyArray<McpServerConfig>,
): McpImportableServer => ({
  source: native.source,
  name: native.name,
  ...(native.projectDir === undefined ? {} : { projectDir: native.projectDir }),
  sourcePath: native.sourcePath,
  suggestedId: toMcpServerName(native.name),
  enabledInSource: native.enabled,
  transport:
    native.transport === "stdio"
      ? {
          type: "stdio",
          command: native.command,
          args: native.args,
          envKeys: Object.keys(native.env),
        }
      : {
          type: "http",
          url: native.url,
          headerKeys: Object.keys(native.headers),
          ...(native.bearerTokenEnvVar === undefined
            ? {}
            : { bearerTokenEnvVar: native.bearerTokenEnvVar }),
        },
  alreadyInGustaf: isInGustaf(native, configs),
});

const make = Effect.gen(function* () {
  const nativeConfigs = yield* NativeMcpConfigs;
  const settings = yield* ServerSettings.ServerSettingsService;
  const policy = yield* ManagedPolicy.ManagedPolicy;

  const readNative = Effect.fn("McpServerImport.readNative")(function* (projectDir?: string) {
    const homeDir = yield* HostProcess.HomeDirectory;
    const codexHome = (yield* HostProcess.Environment).CODEX_HOME?.trim();
    return yield* nativeConfigs.list({
      homeDir,
      ...(codexHome ? { codexHome } : {}),
      ...(projectDir === undefined ? {} : { projectDir }),
    });
  });

  const currentServers = settings.getSettings.pipe(
    Effect.map((current) => current.mcpServers),
    Effect.mapError((cause) => new McpServerImportError({ reason: "settings", cause })),
  );

  const list = Effect.fn("McpServerImport.list")(function* (input: McpListImportableInput) {
    const configs = Object.values(yield* currentServers);
    const { servers, errors } = yield* readNative(input.projectDir);
    return {
      servers: servers.map((native) => toImportable(native, configs)),
      unreadablePaths: errors.map((error) => error.sourcePath),
    };
  });

  const importServers = Effect.fn("McpServerImport.importServers")(function* (
    input: McpImportInput,
  ) {
    if (
      ManagedPolicy.deniedBy(policy, "localMcpServers") !== undefined &&
      input.entries.some((entry) => entry.transport === "stdio")
    ) {
      return yield* new McpServerImportError({ reason: "local-servers-disallowed" });
    }
    const existing = yield* currentServers;
    const { servers } = yield* readNative(input.projectDir);
    const patch: Record<McpServerId, McpServerConfig> = {};
    for (const entry of input.entries) {
      const fail = (reason: McpServerImportError["reason"], cause?: unknown) =>
        new McpServerImportError({ reason, id: entry.id, cause });
      if (Object.hasOwn(existing, entry.id) || Object.hasOwn(patch, entry.id)) {
        return yield* fail("id-taken");
      }
      const native = servers.find((server) => sameEntry(server, entry));
      if (native === undefined) return yield* fail("entry-not-found");
      if (native.transport !== entry.transport) return yield* fail("transport-mismatch");
      // Literal values here become stored secrets when settings are written, like typed ones.
      patch[entry.id] = yield* decodeConfig({
        name: native.name,
        enabled: false,
        transport:
          native.transport === "stdio"
            ? { type: "stdio", command: native.command, args: native.args, env: native.env }
            : { type: "http", url: native.url, headers: native.headers },
      }).pipe(Effect.mapError((cause) => fail("invalid-entry", cause)));
    }
    yield* settings
      .updateSettings({ mcpServers: patch })
      .pipe(Effect.mapError((cause) => new McpServerImportError({ reason: "settings", cause })));
    return { imported: Object.keys(patch) as McpServerId[] };
  });

  return McpServerImport.of({ list, importServers });
});

export const layer = Layer.effect(McpServerImport, make);
