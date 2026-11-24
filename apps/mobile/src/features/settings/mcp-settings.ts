import {
  PROVIDER_DISPLAY_NAMES,
  type McpServerConfig,
  type McpServerId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export function mcpEnabledPatch(
  id: McpServerId,
  server: McpServerConfig,
  enabled: boolean,
): ServerSettingsPatch {
  return { mcpServers: { [id]: { ...server, enabled } } };
}

/** Which agents get the server: absent means every agent. */
export function mcpServerAgents(server: McpServerConfig, resolve: MessageResolver = m): string {
  if (server.providers === undefined) return resolve(msg("All agents"));
  if (server.providers.length === 0) return resolve(msg("No agents"));
  const names = server.providers.map((driver) => PROVIDER_DISPLAY_NAMES[driver] ?? driver);
  return resolve(msg("Only {names}", { names: names.join(", ") }));
}

export function mcpServerAddress(server: McpServerConfig): string {
  if (server.transport.type === "stdio") return server.transport.command;
  const url = new URL(server.transport.url);
  return `${url.origin}${url.pathname}`;
}
