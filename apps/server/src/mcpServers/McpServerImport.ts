import {
  McpServerConfig,
  isSecretReference,
  type McpImportInput,
  type McpImportSource,
  type McpImportableServer,
  type McpListImportableInput,
  type McpListImportableResult,
  type McpImportResult,
  McpServerImportError,
  type McpServerId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
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

/** A server from one agent's own config was set up for that agent, so only it gets the import. */
const importedFor: Record<McpImportSource, ProviderDriverKind | undefined> = {
  codex: ProviderDriverKind.make("codex"),
  claude: ProviderDriverKind.make("claudeAgent"),
  cursor: ProviderDriverKind.make("cursor"),
  gemini: ProviderDriverKind.make("antigravity"),
  "project-mcp-json": undefined,
};

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
              env: transport.env,
              ...(transport.cwd === "thread" ? {} : { cwd: transport.cwd }),
            }
          : {
              name: native.name,
              transport: "http",
              url: transport.url,
              headers: transport.headers,
              ...(transport.requiresSignIn === true ? { requiresSignIn: true } : {}),
              ...(transport.bearerTokenEnvVar === undefined
                ? {}
                : { bearerTokenEnvVar: transport.bearerTokenEnvVar }),
            },
        [native],
      ) !== undefined,
  );

const toImportable = (
  native: NativeMcpServer,
  configs: ReadonlyArray<McpServerConfig>,
  environment: NodeJS.ProcessEnv,
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
  ...(native.transport === "http"
    ? {
        authStatus:
          native.bearerTokenEnvVar !== undefined
            ? environment[native.bearerTokenEnvVar]?.trim()
              ? ("credentials-available" as const)
              : ("missing-environment-variable" as const)
            : Object.keys(native.headers).some((key) => key.toLowerCase() === "authorization")
              ? ("credentials-available" as const)
              : native.requiresSignIn === true
                ? ("sign-in-required" as const)
                : ("unknown" as const),
      }
    : {}),
  alreadyInGustaf: isInGustaf(native, configs),
});

const make = Effect.gen(function* () {
  const nativeConfigs = yield* NativeMcpConfigs;
  const settings = yield* ServerSettings.ServerSettingsService;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const secrets = yield* SecretResolver.SecretResolver;

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
    const configs = yield* Effect.forEach(Object.values(yield* currentServers), (config) =>
      Effect.gen(function* () {
        const slots =
          config.transport.type === "stdio" ? config.transport.env : config.transport.headers;
        const entries = Object.entries(slots);
        const references = entries.map(([, value]) => value).filter(isSecretReference);
        const values = references.length === 0 ? [] : yield* secrets.read(references);
        const resolved = new Map(references.map((reference, index) => [reference, values[index]]));
        const literals = Object.fromEntries(
          entries.map(([key, value]) => [
            key,
            isSecretReference(value) ? (resolved.get(value) ?? value) : value,
          ]),
        );
        return {
          ...config,
          transport:
            config.transport.type === "stdio"
              ? { ...config.transport, env: literals }
              : { ...config.transport, headers: literals },
        };
      }),
    );
    const { servers, errors } = yield* readNative(input.projectDir);
    const environment = yield* HostProcess.Environment;
    return {
      servers: servers.map((native) => toImportable(native, configs, environment)),
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
      const provider = importedFor[native.source];
      // Literal values here become stored secrets when settings are written, like typed ones.
      patch[entry.id] = yield* decodeConfig({
        name: native.name,
        enabled: false,
        ...(provider === undefined ? {} : { providers: [provider] }),
        transport:
          native.transport === "stdio"
            ? {
                type: "stdio",
                command: native.command,
                args: native.args,
                env: native.env,
                ...(native.cwd === undefined ? {} : { cwd: native.cwd }),
              }
            : {
                type: "http",
                url: native.url,
                headers: native.headers,
                ...(native.bearerTokenEnvVar === undefined
                  ? {}
                  : { bearerTokenEnvVar: native.bearerTokenEnvVar }),
                ...(native.requiresSignIn === true ? { requiresSignIn: true } : {}),
              },
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
