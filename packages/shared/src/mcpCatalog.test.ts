import { McpServerConfig, McpServerId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { catalogEntryToMcpServerConfig, MCP_CATALOG } from "./mcpCatalog.ts";

describe("MCP_CATALOG", () => {
  it("contains unique valid server ids and decodable configs", () => {
    const decodeId = Schema.decodeUnknownSync(McpServerId);
    const decodeConfig = Schema.decodeUnknownSync(McpServerConfig);
    const ids = new Set<string>();
    for (const entry of MCP_CATALOG) {
      expect(decodeId(entry.id)).toBe(entry.id);
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.descriptionEn.trim().length).toBeGreaterThan(0);
      expect(entry.descriptionRu.trim().length).toBeGreaterThan(0);
      expect(() => new URL(entry.homepageUrl)).not.toThrow();
      const config = decodeConfig(catalogEntryToMcpServerConfig(entry));
      expect(config.enabled).toBe(true);
    }
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(20);
  });
});
