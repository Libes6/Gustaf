import {
  MCP_TOOL_FILTER_DRIVERS,
  type McpServerConfig,
  type McpServerToolSummary,
  type ProviderDriverKind,
} from "@t3tools/contracts";

export type McpToolGroupMode = "all" | "none" | "custom";

/** Which config changes ask for a new status check; switching tools does not. */
export function mcpStatusKey(config: McpServerConfig | undefined): string {
  if (config === undefined) return "";
  const { disabledTools: _disabledTools, ...checked } = config;
  return JSON.stringify(checked);
}

/** Read-only tools first, as `annotations.readOnlyHint` declares; a tool without the hint writes. */
export function groupMcpTools(tools: ReadonlyArray<McpServerToolSummary>) {
  return {
    reads: tools.filter((tool) => tool.readOnly === true).map((tool) => tool.name),
    writes: tools.filter((tool) => tool.readOnly !== true).map((tool) => tool.name),
  };
}

export function mcpToolGroupMode(
  names: ReadonlyArray<string>,
  disabled: ReadonlyArray<string>,
): McpToolGroupMode {
  const off = names.filter((name) => disabled.includes(name)).length;
  return off === 0 ? "all" : off === names.length ? "none" : "custom";
}

/**
 * The disabled list after a group or a single tool is switched. Names outside `names` stay as
 * they are, so a tool the server stopped listing for now keeps its switch.
 */
export function setMcpToolsEnabled(
  disabled: ReadonlyArray<string>,
  names: ReadonlyArray<string>,
  enabled: boolean,
): ReadonlyArray<string> {
  const rest = disabled.filter((name) => !names.includes(name));
  return enabled ? rest : [...rest, ...names];
}

export function withDisabledTools(
  config: McpServerConfig,
  disabled: ReadonlyArray<string>,
): McpServerConfig {
  const { disabledTools: _previous, ...rest } = config;
  return disabled.length === 0 ? rest : { ...rest, disabledTools: [...disabled] };
}

/** Agents that get this server but would still see its disabled tools. */
export function mcpToolFilterUnsupported(
  providers: ReadonlyArray<ProviderDriverKind> | undefined,
  installed: ReadonlyArray<ProviderDriverKind>,
): ReadonlyArray<ProviderDriverKind> {
  return [...new Set(providers ?? installed)].filter(
    (driver) => !MCP_TOOL_FILTER_DRIVERS.includes(driver),
  );
}
