import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

/** A user MCP server the provider starts itself, resolved for one thread (secrets read). */
export type McpUserServer =
  | {
      readonly type: "stdio";
      readonly id: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      /** The server's own variables over the host PATH; providers add their own environment. */
      readonly env: Readonly<Record<string, string>>;
      readonly cwd: string;
    }
  | {
      readonly type: "http";
      readonly id: string;
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

/**
 * MCP config a provider instance loads by itself. Gustaf leaves a user server out of the session
 * when it is already there, so it does not start twice.
 */
export interface NativeMcpSources {
  readonly provider: "claudeAgent" | "codex" | "cursor" | "gemini";
  /** The home the provider reads its user config under (`.claude.json`, `.cursor/`, `.gemini/`). */
  readonly homeDir: string;
  /** Codex's effective CODEX_HOME, when it is not `<homeDir>/.codex`. */
  readonly codexHome?: string;
  /** Claude also loads the project's `.mcp.json`. */
  readonly includeProjectMcpJson?: boolean;
}

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Omit preview_* instructions when the user withholds agent browser access. */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /** User MCP servers to start next to `t3-code`, already filtered for this provider. */
  readonly userServers?: ReadonlyArray<McpUserServer>;
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
