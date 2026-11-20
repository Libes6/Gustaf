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
import { McpServerAuth } from "./McpServerAuth.ts";
import { NativeMcpConfigs } from "./import/NativeMcpConfigs.ts";
import {
  commandInDirectory,
  findNativeDuplicate,
  nativeServersForProvider,
  toMcpServerName,
} from "./import/matcher.ts";
import * as ServerSettings from "../serverSettings.ts";

/** A user MCP server ready to hand a provider; the provider starts it. */
export type ResolvedMcpServer = McpUserServer & { readonly id: McpServerId };

/** An enabled server left out of a session because it cannot start, with the reason. */
export interface SkippedMcpServer {
  readonly id: McpServerId;
  readonly reason: string;
}

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
      /** Servers the caller already knows will not start, with the reason; they are left out. */
      readonly unusable?: ReadonlyMap<McpServerId, string>;
    }) => Effect.Effect<{
      readonly servers: ReadonlyArray<ResolvedMcpServer>;
      readonly skipped: ReadonlyArray<SkippedMcpServer>;
    }>;
    /** One server as a session would get it, or why it cannot start. */
    readonly resolveServer: (input: {
      readonly id: McpServerId;
      readonly server: McpServerConfig;
      readonly cwd: string;
      /** Refreshes a Gustaf sign-in's token first, for a server that just refused it. */
      readonly refreshToken?: boolean;
    }) => Effect.Effect<ResolvedMcpServer | { readonly unusable: string }>;
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
  bearer: string | undefined,
): Effect.fn.Return<ResolvedMcpServer | { readonly unusable: string }> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(slotsOf(server))) {
    const secret = literal(value);
    if (secret === undefined) return { unusable: `The secret for ${key} cannot be read.` };
    values[key] = secret;
  }
  const { transport } = server;
  const disabledTools =
    server.disabledTools === undefined || server.disabledTools.length === 0
      ? {}
      : { disabledTools: server.disabledTools };
  if (transport.type === "http") {
    return {
      type: "http",
      id,
      ...disabledTools,
      url: transport.url,
      headers: bearer === undefined ? values : { ...values, Authorization: `Bearer ${bearer}` },
    };
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
  const serverCwd = transport.cwd === "thread" ? cwd : transport.cwd;
  const { command } = transport;
  // Providers spawn from their own directory, so a relative path is pinned to the server's cwd.
  const pinned = commandInDirectory(command, serverCwd);
  // A provider that cannot start one server may refuse the whole session (Antigravity does).
  const executable = resolveExecutable(pinned, platform, { ...hostEnvironment, ...env });
  if (executable === undefined) return { unusable: `Command not found: ${command}` };
  return {
    type: "stdio",
    id,
    ...disabledTools,
    // Node and most provider runtimes cannot spawn npm's `.cmd` shims by their bare name.
    command: pinned !== command || WINDOWS_SHIM.test(executable) ? executable : command,
    args: transport.args,
    env,
    cwd: serverCwd,
  };
});

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const nativeConfigs = yield* NativeMcpConfigs;
  const auth = yield* McpServerAuth;

  // The token of a server signed in through Gustaf, unless the user set their own header.
  const bearerFor = (id: McpServerId, { transport }: McpServerConfig, force = false) =>
    transport.type !== "http" ||
    Object.keys(transport.headers).some((key) => key.toLowerCase() === "authorization")
      ? Effect.undefined
      : auth.accessToken(id, transport.url, { force });

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
    readonly unusable?: ReadonlyMap<McpServerId, string>;
  }) {
    const none = { servers: [], skipped: [] };
    const current = yield* settings.getSettings.pipe(
      Effect.catchTags({
        ServerSettingsError: (cause) =>
          Effect.logWarning("MCP servers left out of a session: settings unreadable", {
            cause,
          }).pipe(Effect.as(undefined)),
      }),
    );
    if (current === undefined) return none;
    const overrides = current.projectSettingsOverrides[input.projectId]?.mcpServers;
    const localDenied = ManagedPolicy.deniedBy(policy, "localMcpServers") !== undefined;
    let enabled = (Object.entries(current.mcpServers) as Array<[McpServerId, McpServerConfig]>)
      .filter(([id, server]) => overrides?.[id]?.enabled ?? server.enabled)
      .filter(([, server]) => server.providers?.includes(input.driver) ?? true)
      .filter(([, server]) => !(localDenied && server.transport.type === "stdio"));
    if (enabled.length === 0) return none;
    if (input.native !== undefined) {
      const isDuplicate = yield* nativeDuplicateFilter(input.native, input.cwd);
      enabled = enabled.filter((entry) => !isDuplicate(entry));
      if (enabled.length === 0) return none;
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

    const servers: Array<ResolvedMcpServer> = [];
    const skipped: Array<SkippedMcpServer> = [];
    for (const [id, server] of enabled) {
      const known = input.unusable?.get(id);
      const result =
        known === undefined
          ? yield* withSecrets(id, server, input.cwd, literal, yield* bearerFor(id, server))
          : { unusable: known };
      if ("unusable" in result) {
        yield* Effect.logWarning("MCP server left out of a session: it cannot start", {
          mcpServerId: id,
          driver: input.driver,
          reason: result.unusable,
        });
        skipped.push({ id, reason: result.unusable });
        continue;
      }
      servers.push(result);
    }
    return { servers, skipped };
  });

  const resolveServer = Effect.fn("McpUserServers.resolveServer")(function* (input: {
    readonly id: McpServerId;
    readonly server: McpServerConfig;
    readonly cwd: string;
    readonly refreshToken?: boolean;
  }) {
    const references = Object.values(slotsOf(input.server)).filter(isSecretReference);
    const read = references.length === 0 ? [] : yield* secrets.read(references);
    const secretFor = new Map<SecretReference, string | undefined>(
      references.map((reference, index) => [reference, read[index]]),
    );
    const bearer = yield* bearerFor(input.id, input.server, input.refreshToken === true);
    return yield* withSecrets(
      input.id,
      input.server,
      input.cwd,
      (value) => (isSecretReference(value) ? secretFor.get(value)?.trim() || undefined : value),
      bearer,
    );
  });

  return McpUserServers.of({ resolveForThread, resolveServer });
});

export const layer = Layer.effect(McpUserServers, make);
