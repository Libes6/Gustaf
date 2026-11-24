import { McpServerConfig, McpServerId, ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  currentMcpStatus,
  groupMcpTools,
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
