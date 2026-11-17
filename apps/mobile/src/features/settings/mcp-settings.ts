import type { McpServerConfig, McpServerId, ServerSettingsPatch } from "@t3tools/contracts";

export function mcpEnabledPatch(
  id: McpServerId,
  server: McpServerConfig,
  enabled: boolean,
): ServerSettingsPatch {
  return { mcpServers: { [id]: { ...server, enabled } } };
}

export function mcpServerAddress(server: McpServerConfig): string {
  if (server.transport.type === "stdio") return server.transport.command;
  const url = new URL(server.transport.url);
  return `${url.origin}${url.pathname}`;
}
