import { describe, expect, it } from "vite-plus/test";
import { McpServerId, type McpServerConfig } from "@t3tools/contracts";
import { mcpEnabledPatch, mcpServerAddress } from "./mcp-settings";

describe("mobile MCP settings", () => {
  it("patches only the selected entry without dropping redacted credentials", () => {
    const server: McpServerConfig = {
      enabled: false,
      transport: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "" } },
    };
    expect(mcpEnabledPatch(McpServerId.make("tools"), server, true)).toEqual({
      mcpServers: { tools: { ...server, enabled: true } },
    });
    expect(mcpEnabledPatch(McpServerId.make("tools"), { ...server, enabled: true }, false)).toEqual(
      {
        mcpServers: { tools: server },
      },
    );
    expect(server.enabled).toBe(false);
  });
  it("hides credentials and query parameters in HTTP addresses", () => {
    expect(
      mcpServerAddress({
        enabled: true,
        transport: {
          type: "http",
          url: "https://user:password@example.com/mcp?token=secret#secret",
          headers: {},
        },
      }),
    ).toBe("https://example.com/mcp");
  });
});
