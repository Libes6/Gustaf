import {
  PROVIDER_DISPLAY_NAMES,
  type McpServerConfig,
  type McpServerId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

import { t } from "../../i18n";

export function mcpEnabledPatch(
  id: McpServerId,
  server: McpServerConfig,
  enabled: boolean,
): ServerSettingsPatch {
  return { mcpServers: { [id]: { ...server, enabled } } };
}

/** Which agents get the server: absent means every agent. */
export function mcpServerAgents(server: McpServerConfig): string {
  if (server.providers === undefined) return t("All agents");
  if (server.providers.length === 0) return t("No agents");
  const names = server.providers.map((driver) => PROVIDER_DISPLAY_NAMES[driver] ?? driver);
  return `${t("Only")} ${names.join(", ")}`;
}

export function mcpServerAddress(server: McpServerConfig): string {
  if (server.transport.type === "stdio") return server.transport.command;
  const url = new URL(server.transport.url);
  return `${url.origin}${url.pathname}`;
}
