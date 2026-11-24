import { McpServerId, type McpRegistryEntry, type McpServerConfig } from "@t3tools/contracts";
import {
  catalogEntryToMcpServerConfig,
  type McpCatalogCategory,
  type McpCatalogEntry,
} from "@t3tools/shared/mcpCatalog";
import * as Schema from "effect/Schema";

const isMcpServerId = Schema.is(McpServerId);

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

function sameStdio(
  left: { readonly command: string; readonly args: ReadonlyArray<string> },
  right: { readonly command: string; readonly args: ReadonlyArray<string> },
): boolean {
  return (
    left.command.trim() === right.command.trim() &&
    left.args.length === right.args.length &&
    left.args.every((arg, index) => arg === right.args[index])
  );
}

export function isMarketplaceServerInstalled(
  installed: Readonly<Record<string, McpServerConfig>>,
  candidate: {
    readonly id: string;
    readonly transport:
      | { readonly type: "http"; readonly url: string }
      | { readonly type: "stdio"; readonly command: string; readonly args: ReadonlyArray<string> };
  },
): boolean {
  if (Object.hasOwn(installed, candidate.id)) return true;
  for (const config of Object.values(installed)) {
    if (candidate.transport.type === "http" && config.transport.type === "http") {
      if (normalizeUrl(config.transport.url) === normalizeUrl(candidate.transport.url)) return true;
    }
    if (candidate.transport.type === "stdio" && config.transport.type === "stdio") {
      if (sameStdio(config.transport, candidate.transport)) return true;
    }
  }
  return false;
}

export function filterCatalogEntries(
  entries: ReadonlyArray<McpCatalogEntry>,
  query: string,
  category: McpCatalogCategory | "all",
): ReadonlyArray<McpCatalogEntry> {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (category !== "all" && entry.category !== category) return false;
    if (!needle) return true;
    return (
      entry.name.toLowerCase().includes(needle) ||
      entry.id.toLowerCase().includes(needle) ||
      entry.descriptionEn.toLowerCase().includes(needle) ||
      entry.descriptionRu.toLowerCase().includes(needle) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(needle))
    );
  });
}

export interface MarketplaceDraft {
  readonly id: string;
  readonly config: McpServerConfig;
  readonly secretKeys: ReadonlyArray<string>;
}

export function catalogEntryToDraft(entry: McpCatalogEntry): MarketplaceDraft {
  return {
    id: entry.id,
    config: catalogEntryToMcpServerConfig(entry),
    secretKeys: entry.requiredSecrets.map((secret) => secret.key),
  };
}

export function registryEntryToDraft(entry: McpRegistryEntry): MarketplaceDraft {
  const secretKeys =
    entry.transport.type === "http"
      ? entry.transport.headers.map((header) => header.key)
      : entry.transport.env.map((variable) => variable.key);
  const config: McpServerConfig = {
    name: entry.name,
    enabled: true,
    transport:
      entry.transport.type === "http"
        ? { type: "http", url: entry.transport.url, headers: {} }
        : {
            type: "stdio",
            command: entry.transport.command,
            args: [...entry.transport.args],
            env: {},
            cwd: "thread",
          },
  };
  return {
    id: entry.suggestedId,
    config,
    secretKeys,
  };
}

export function canOneClickInstall(
  draft: MarketplaceDraft,
  installed: Readonly<Record<string, McpServerConfig>>,
): boolean {
  return (
    draft.secretKeys.length === 0 && isMcpServerId(draft.id) && !Object.hasOwn(installed, draft.id)
  );
}
