import { McpServerConfig, McpServerId, ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  currentMcpStatus,
  codexLoadsOwnServers,
  groupMcpTools,
  isHeavyMcpServer,
  mcpServerWeight,
  mcpStatusKey,
  mcpToolFilterUnsupported,
  mcpToolGroupMode,
  recordMcpStatuses,
  setMcpToolsEnabled,
  withDisabledTools,
} from "./McpSettings.logic";

const decodeConfig = Schema.decodeSync(McpServerConfig);
const config = decodeConfig({
  enabled: true,
  transport: { type: "http", url: "https://mcp.example.test/mcp" },
});

describe("MCP server statuses", () => {
  it("shows the answer to a check started after an edit for the edited config", () => {
    const id = McpServerId.make("figma");
    const edited = decodeConfig({
      enabled: true,
      transport: { type: "http", url: "https://mcp.example.test/v2/mcp" },
    });
    const before = { [id]: config };
    const answer = [{ id, status: "connected" as const, tools: [] }];

    // The edit's save resolves before settings re-render, so the check carries the edited configs.
    const checked = recordMcpStatuses(new Map(), { ...before, [id]: edited }, answer);
    expect(currentMcpStatus(checked, id, edited)?.status).toBe("connected");
    // Filed under the pre-edit configs, the row would wait on "Checking…" for good.
    expect(currentMcpStatus(recordMcpStatuses(new Map(), before, answer), id, edited)).toBe(
      undefined,
    );
  });
});

describe("MCP tool switches", () => {
  it("groups tools by readOnlyHint, and a tool without the hint writes", () => {
    expect(
      groupMcpTools([
        { name: "get_file", readOnly: true },
        { name: "delete_file", readOnly: false },
        { name: "render" },
      ]),
    ).toEqual({ reads: ["get_file"], writes: ["delete_file", "render"] });
  });

  it("derives a group's mode and switches the group without touching other tools", () => {
    const writes = ["delete_file", "render"];
    expect(mcpToolGroupMode(writes, [])).toBe("all");
    expect(mcpToolGroupMode(writes, ["render"])).toBe("custom");
    expect(mcpToolGroupMode(writes, ["render", "delete_file", "gone"])).toBe("none");

    // `gone` is a tool the server does not list right now; its switch survives.
    expect(setMcpToolsEnabled(["gone", "render"], writes, false)).toEqual([
      "gone",
      "delete_file",
      "render",
    ]);
    expect(setMcpToolsEnabled(["gone", "render"], writes, true)).toEqual(["gone"]);
    expect(setMcpToolsEnabled([], ["render"], false)).toEqual(["render"]);
  });

  it("stores only switched-off tools and drops the field when none are", () => {
    const off = withDisabledTools(config, ["render"]);
    expect(off.disabledTools).toEqual(["render"]);
    expect("disabledTools" in withDisabledTools(off, [])).toBe(false);
    // Switching tools never asks for a new status check.
    expect(mcpStatusKey(off)).toBe(mcpStatusKey(config));
  });

  it("names the agents that would still get every tool", () => {
    const [codex, claude, cursor] = ["codex", "claudeAgent", "cursor"].map((driver) =>
      ProviderDriverKind.make(driver),
    );
    expect(mcpToolFilterUnsupported(undefined, [codex!, claude!, cursor!])).toEqual([cursor]);
    expect(mcpToolFilterUnsupported([codex!], [codex!, cursor!])).toEqual([]);
  });
});

describe("MCP server weight", () => {
  it("flags only servers above ten thousand tokens", () => {
    expect(isHeavyMcpServer({})).toBe(false);
    expect(isHeavyMcpServer({ approxTokens: 10_000 })).toBe(false);
    expect(isHeavyMcpServer({ approxTokens: 10_001 })).toBe(true);
  });
});

describe("MCP server weight with switched-off tools", () => {
  const status = {
    approxTokens: 100,
    tools: [
      { name: "render", approxTokens: 60 },
      { name: "delete_file", approxTokens: 40 },
    ],
  };

  it("leaves out switched-off tools and keeps the total for agents that cannot", () => {
    expect(mcpServerWeight(status, config)).toEqual({ tokens: 100 });
    const off = withDisabledTools(config, ["delete_file"]);
    expect(mcpServerWeight(status, off)).toEqual({ tokens: 60 });
  });

  it("shows the total while a status has no per-tool sizes", () => {
    const off = withDisabledTools(config, ["delete_file"]);
    expect(mcpServerWeight({ approxTokens: 100, tools: [{ name: "delete_file" }] }, off)).toEqual({
      tokens: 100,
    });
    expect(mcpServerWeight({ tools: status.tools }, off)).toBeUndefined();
  });
});

describe("Codex's own MCP servers", () => {
  it("is mentioned only where Codex is installed", () => {
    expect(codexLoadsOwnServers([ProviderDriverKind.make("claudeAgent")])).toBe(false);
    expect(
      codexLoadsOwnServers([
        ProviderDriverKind.make("claudeAgent"),
        ProviderDriverKind.make("codex"),
      ]),
    ).toBe(true);
  });
});
