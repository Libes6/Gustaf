import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/**
 * Sent by MCP clients that cannot defer tools themselves. The T3 MCP server then
 * lists only a core set plus `tool_search`, which lists the rest on demand.
 */
export const MCP_TOOL_EXPOSURE_HEADER = "t3-tool-exposure";

/** A user MCP server the provider starts itself, resolved for one thread (secrets read). */
export type McpUserServer = (
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
    }
) & {
  /** Tool names the provider must not offer, for providers that can filter them. */
  readonly disabledTools?: ReadonlyArray<string>;
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
  /** True while a delegated task this thread started will wake it with its result. */
  readonly hasPendingWake?: Effect.Effect<boolean>;
  /** User MCP servers to start next to `t3-code`, already filtered for this provider. */
  readonly userServers?: ReadonlyArray<McpUserServer>;
  /** Enabled user servers left out because they cannot start, with the reason. */
  readonly skippedUserServers?: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
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
