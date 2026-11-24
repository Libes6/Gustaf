import { McpServerId, type McpRegistryEntry, type McpServerConfig } from "@t3tools/contracts";
import { MCP_CATALOG } from "@t3tools/shared/mcpCatalog";
import { describe, expect, it } from "vite-plus/test";

import {
  canOneClickInstall,
  catalogEntryToDraft,
  filterCatalogEntries,
  isMarketplaceServerInstalled,
  registryEntryToDraft,
} from "./McpMarketplace.logic";

describe("McpMarketplace.logic", () => {
  it("matches installed servers by id, normalized HTTP url, or stdio command and args", () => {
    const installed: Record<string, McpServerConfig> = {
      mylinear: {
        name: "Linear",
        enabled: true,
        transport: { type: "http", url: "https://mcp.linear.app/mcp/", headers: {} },
      },
      pw: {
        name: "Playwright",
        enabled: true,
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@playwright/mcp@latest"],
          env: {},
          cwd: "thread",
        },
      },
    };
    expect(
      isMarketplaceServerInstalled(installed, {
        id: "linear",
        transport: { type: "http", url: "https://mcp.linear.app/mcp" },
      }),
    ).toBe(true);
    expect(
      isMarketplaceServerInstalled(installed, {
        id: "playwright",
        transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      }),
    ).toBe(true);
    expect(
      isMarketplaceServerInstalled(installed, {
        id: "sentry",
        transport: { type: "http", url: "https://mcp.sentry.dev/mcp" },
      }),
    ).toBe(false);
  });

  it("filters featured entries by category and multilingual search query", () => {
    const browserEntries = filterCatalogEntries(MCP_CATALOG, "", "browser");
    expect(browserEntries.map((entry) => entry.id)).toContain(McpServerId.make("playwright"));
    const ruMatch = filterCatalogEntries(MCP_CATALOG, "дизайн", "all");
    expect(ruMatch.map((entry) => entry.id)).toContain(McpServerId.make("figma"));
  });

  it("allows 1-click install only when no secrets are required and id is free", () => {
    const context7 = MCP_CATALOG.find((entry) => entry.id === "context7")!;
    const brave = MCP_CATALOG.find((entry) => entry.id === "brave-search")!;
    expect(canOneClickInstall(catalogEntryToDraft(context7), {})).toBe(true);
    expect(canOneClickInstall(catalogEntryToDraft(brave), {})).toBe(false);

    const registryEntry: McpRegistryEntry = {
      registryName: "com.example/sentry-mcp",
      suggestedId: "sentry",
      name: "Sentry",
      description: "Issues",
      tags: [],
      transport: {
        type: "http",
        url: "https://mcp.sentry.dev/mcp",
        headers: [{ key: "Authorization" }],
      },
    };
    const draft = registryEntryToDraft(registryEntry);
    expect(draft.secretKeys).toEqual(["Authorization"]);
    expect(canOneClickInstall(draft, {})).toBe(false);
  });
});
