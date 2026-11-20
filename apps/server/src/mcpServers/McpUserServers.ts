import {
  isSecretReference,
  type McpServerConfig,
  type McpServerId,
  type ProjectId,
  type ProviderDriverKind,
  type SecretReference,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import type { McpUserServer, NativeMcpSources } from "@t3tools/provider-core/server/mcpSession";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { NativeMcpConfigs } from "./import/NativeMcpConfigs.ts";
import {
  findNativeDuplicate,
  nativeServersForProvider,
  toMcpServerName,
} from "./import/matcher.ts";
import * as ServerSettings from "../serverSettings.ts";

/** A user MCP server ready to hand a provider; the provider starts it. */
export type ResolvedMcpServer = McpUserServer & { readonly id: McpServerId };

export class McpUserServers extends Context.Service<
  McpUserServers,
  {
    /**
     * The user MCP servers enabled for a thread, with secrets read. Never fails, so a session
     * always starts: a server whose settings or secrets cannot be read is left out and logged.
     */
    readonly resolveForThread: (input: {
      readonly projectId: ProjectId;
      /** The session's provider; servers limited to other providers are left out. */
      readonly driver: ProviderDriverKind;
      /** The thread's working directory: its worktree when it has one. */
      readonly cwd: string;
      /**
       * Set when the provider also loads its own native MCP config: a server it already loads is
       * left out so it does not start twice. Omit for isolated provider homes.
       */
      readonly native?: NativeMcpSources;
    }) => Effect.Effect<ReadonlyArray<ResolvedMcpServer>>;
    /** One server as a session would get it; the key of a secret that cannot be read otherwise. */
    readonly resolveServer: (input: {
      readonly id: McpServerId;
      readonly server: McpServerConfig;
      readonly cwd: string;
    }) => Effect.Effect<ResolvedMcpServer | { readonly unreadableKey: string }>;
  }
>()("t3/mcpServers/McpUserServers") {}

const WINDOWS_SHIM = /\.(?:cmd|bat)$/i;

const slotsOf = ({ transport }: McpServerConfig) =>
  transport.type === "stdio" ? transport.env : transport.headers;

// Runs once per server inside the traced resolve calls below.
const withSecrets = Effect.fnUntraced(function* (
  id: McpServerId,
  server: McpServerConfig,
  cwd: string,
  literal: (value: SettingsSecretValue) => string | undefined,
): Effect.fn.Return<ResolvedMcpServer | { readonly unreadableKey: string }> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(slotsOf(server))) {
    const secret = literal(value);
    if (secret === undefined) return { unreadableKey: key };
    values[key] = secret;
  }
  const { transport } = server;
  if (transport.type === "http") {
    return { type: "http", id, url: transport.url, headers: values };
  }
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const isPathKey = (key: string) =>
    platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH";
  const hostPathKey = Object.keys(hostEnvironment).find(isPathKey);
  // Providers spawn without a login shell, so the server needs the PATH the server hydrated.
  const env =
    hostPathKey === undefined || Object.keys(values).some(isPathKey)
      ? values
      : { [hostPathKey]: hostEnvironment[hostPathKey] ?? "", ...values };
  // Node and most provider runtimes cannot spawn npm's `.cmd` shims by their bare name.
  const executable =
    platform === "win32"
      ? resolveExecutable(transport.command, platform, { ...hostEnvironment, ...env })
      : undefined;
  return {
    type: "stdio",
    id,
    command:
      executable !== undefined && WINDOWS_SHIM.test(executable) ? executable : transport.command,
    args: transport.args,
    env,
    cwd: transport.cwd === "thread" ? cwd : transport.cwd,
  };
});

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const nativeConfigs = yield* NativeMcpConfigs;

  const nativeDuplicateFilter = Effect.fn("McpUserServers.nativeDuplicateFilter")(function* (
    native: NativeMcpSources,
    cwd: string,
  ) {
    const { servers, errors } = yield* nativeConfigs.list({
      homeDir: native.homeDir,
      ...(native.codexHome === undefined ? {} : { codexHome: native.codexHome }),
      projectDir: cwd,
    });
    if (errors.length > 0) {
      yield* Effect.logWarning("Some native MCP configs could not be read", {
        paths: errors.map((error) => error.sourcePath),
      });
    }
    const loaded = nativeServersForProvider(native.provider, servers, cwd, {
      includeProjectMcpJson: native.includeProjectMcpJson ?? false,
    }).map((server) => ({ ...server, name: toMcpServerName(server.name) }));
    return ([id, { transport }]: readonly [McpServerId, McpServerConfig]) =>
      findNativeDuplicate(
        transport.type === "stdio"
          ? { name: id, transport: "stdio", command: transport.command, args: transport.args }
          : { name: id, transport: "http", url: transport.url },
        loaded,
      ) !== undefined;
  });

  const resolveForThread = Effect.fn("McpUserServers.resolveForThread")(function* (input: {
    readonly projectId: ProjectId;
    readonly driver: ProviderDriverKind;
    readonly cwd: string;
    readonly native?: NativeMcpSources;
  }) {
    const current = yield* settings.getSettings.pipe(
      Effect.catchTags({
        ServerSettingsError: (cause) =>
          Effect.logWarning("MCP servers left out of a session: settings unreadable", {
            cause,
          }).pipe(Effect.as(undefined)),
      }),
    );
    if (current === undefined) return [];
    const overrides = current.projectSettingsOverrides[input.projectId]?.mcpServers;
    const localDenied = ManagedPolicy.deniedBy(policy, "localMcpServers") !== undefined;
    let enabled = (Object.entries(current.mcpServers) as Array<[McpServerId, McpServerConfig]>)
      .filter(([id, server]) => overrides?.[id]?.enabled ?? server.enabled)
      .filter(([, server]) => server.providers?.includes(input.driver) ?? true)
      .filter(([, server]) => !(localDenied && server.transport.type === "stdio"));
    if (enabled.length === 0) return [];
    if (input.native !== undefined) {
      const isDuplicate = yield* nativeDuplicateFilter(input.native, input.cwd);
      enabled = enabled.filter((entry) => !isDuplicate(entry));
      if (enabled.length === 0) return [];
    }

    const references = enabled.flatMap(([, server]) =>
      Object.values(slotsOf(server)).filter(isSecretReference),
    );
    const read = references.length === 0 ? [] : yield* secrets.read(references);
    const secretFor = new Map<SecretReference, string | undefined>(
      references.map((reference, index) => [reference, read[index]]),
    );
    const literal = (value: SettingsSecretValue) =>
      isSecretReference(value) ? secretFor.get(value)?.trim() || undefined : value;

    const resolved: Array<ResolvedMcpServer> = [];
    for (const [id, server] of enabled) {
      const result = yield* withSecrets(id, server, input.cwd, literal);
      if ("unreadableKey" in result) {
        yield* Effect.logWarning("MCP server left out of a session: its secret cannot be read", {
          mcpServerId: id,
          key: result.unreadableKey,
        });
        continue;
      }
      resolved.push(result);
    }
    return resolved;
  });

  const resolveServer = Effect.fn("McpUserServers.resolveServer")(function* (input: {
    readonly id: McpServerId;
    readonly server: McpServerConfig;
    readonly cwd: string;
  }) {
    const references = Object.values(slotsOf(input.server)).filter(isSecretReference);
    const read = references.length === 0 ? [] : yield* secrets.read(references);
    const secretFor = new Map<SecretReference, string | undefined>(
      references.map((reference, index) => [reference, read[index]]),
    );
    return yield* withSecrets(input.id, input.server, input.cwd, (value) =>
      isSecretReference(value) ? secretFor.get(value)?.trim() || undefined : value,
    );
  });

  return McpUserServers.of({ resolveForThread, resolveServer });
});

export const layer = Layer.effect(McpUserServers, make);
