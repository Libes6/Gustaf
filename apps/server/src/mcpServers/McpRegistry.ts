import {
  McpRegistryError,
  McpServerId,
  type McpRegistryEntry,
  type McpRegistryRequiredSecret,
  type McpRegistrySearchInput,
  type McpRegistrySearchResult,
  type McpRegistryTransport,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

const MCP_REGISTRY_API_BASE = "https://registry.modelcontextprotocol.io/v0.1/servers";
const DEFAULT_LIMIT = 24;
const REQUEST_TIMEOUT = Duration.seconds(10);
const CACHE_TTL = Duration.seconds(60);

const isMcpServerId = Schema.is(McpServerId);
const isMcpRegistryError = Schema.is(McpRegistryError);

const RawHeaderOrEnv = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
});

const RawRemote = Schema.Struct({
  type: Schema.String,
  url: Schema.String,
  headers: Schema.optional(Schema.Array(RawHeaderOrEnv)),
});

const RawPackage = Schema.Struct({
  registryType: Schema.optional(Schema.String),
  identifier: Schema.String,
  transport: Schema.optional(Schema.Struct({ type: Schema.String })),
  environmentVariables: Schema.optional(Schema.Array(RawHeaderOrEnv)),
});

const RawServerRecord = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  websiteUrl: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.Struct({ url: Schema.optional(Schema.String) })),
  remotes: Schema.optional(Schema.Array(RawRemote)),
  packages: Schema.optional(Schema.Array(RawPackage)),
  _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const RawSearchResponse = Schema.Struct({
  servers: Schema.Array(
    Schema.Struct({
      server: RawServerRecord,
      _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});

const decodeRawSearchResponse = Schema.decodeUnknownEffect(RawSearchResponse);

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !value.includes("{") &&
      !value.includes("}")
    );
  } catch {
    return false;
  }
}

function suggestRegistryServerId(rawName: string): string {
  const leaf = rawName.split("/").pop() ?? rawName;
  const cleaned = leaf
    .toLowerCase()
    .replace(/(?:^mcp[-_]|[-_]mcp$)/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (cleaned && isMcpServerId(cleaned)) return cleaned;
  const fallback = rawName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return fallback && isMcpServerId(fallback) ? fallback : "mcp-server";
}

function toRequiredSecrets(
  items: ReadonlyArray<typeof RawHeaderOrEnv.Type> | undefined,
): ReadonlyArray<McpRegistryRequiredSecret> {
  if (!items || items.length === 0) return [];
  const seen = new Set<string>();
  const result: McpRegistryRequiredSecret[] = [];
  for (const item of items) {
    const key = item.name.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({
      key,
      ...(item.description?.trim() ? { description: item.description.trim() } : {}),
    });
  }
  return result;
}

function extractTransport(server: typeof RawServerRecord.Type): McpRegistryTransport | null {
  for (const remote of server.remotes ?? []) {
    const kind = remote.type.toLowerCase();
    if (
      (kind === "streamable-http" || kind === "http" || kind === "sse") &&
      isHttpUrl(remote.url)
    ) {
      return {
        type: "http",
        url: remote.url.trim(),
        headers: toRequiredSecrets(remote.headers),
      };
    }
  }
  for (const pkg of server.packages ?? []) {
    const transportType = pkg.transport?.type?.toLowerCase();
    if (transportType && transportType !== "stdio") continue;
    const registry = pkg.registryType?.toLowerCase();
    const id = pkg.identifier.trim();
    if (!id) continue;
    if (registry === "npm") {
      return {
        type: "stdio",
        command: "npx",
        args: ["-y", id],
        env: toRequiredSecrets(pkg.environmentVariables),
      };
    }
    if (registry === "pypi") {
      return {
        type: "stdio",
        command: "uvx",
        args: [id],
        env: toRequiredSecrets(pkg.environmentVariables),
      };
    }
  }
  return null;
}

function extractPublisherMeta(server: typeof RawServerRecord.Type): {
  readonly title?: string;
  readonly tags: ReadonlyArray<string>;
} {
  const publisher = server._meta?.["io.modelcontextprotocol.registry/publisher-provided"];
  if (typeof publisher !== "object" || publisher === null) return { tags: [] };
  const record = publisher as Record<string, unknown>;
  const title =
    typeof record.title === "string" && record.title.trim() ? record.title.trim() : undefined;
  const tags = Array.isArray(record.tags)
    ? record.tags
        .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
        .slice(0, 6)
    : [];
  return { ...(title ? { title } : {}), tags };
}

function normalizeServerEntry(
  item: (typeof RawSearchResponse.Type)["servers"][number],
): McpRegistryEntry | null {
  const official = item._meta?.["io.modelcontextprotocol.registry/official"];
  if (typeof official === "object" && official !== null) {
    const record = official as Record<string, unknown>;
    if (record.isLatest === false) return null;
    if (typeof record.status === "string" && record.status !== "active") return null;
  }
  const { server } = item;
  const transport = extractTransport(server);
  if (transport === null) return null;
  const publisher = extractPublisherMeta(server);
  const name = (
    server.title?.trim() ||
    publisher.title ||
    server.name.split("/").pop() ||
    server.name
  ).trim();
  const homepageUrl = isHttpUrl(server.websiteUrl) ? server.websiteUrl.trim() : undefined;
  const repositoryUrl = isHttpUrl(server.repository?.url)
    ? server.repository.url.trim()
    : undefined;
  return {
    registryName: server.name.trim(),
    suggestedId: suggestRegistryServerId(server.name),
    name,
    description: server.description?.trim() ?? "",
    ...(server.version?.trim() ? { version: server.version.trim() } : {}),
    ...(homepageUrl ? { homepageUrl } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    tags: publisher.tags,
    transport,
  };
}

export interface McpRegistryShape {
  readonly search: (
    input: McpRegistrySearchInput,
  ) => Effect.Effect<McpRegistrySearchResult, McpRegistryError>;
}

export class McpRegistry extends Context.Service<McpRegistry, McpRegistryShape>()(
  "t3/mcpServers/McpRegistry",
) {}

const makeMcpRegistry = Effect.fn("McpRegistry.make")(function* (options?: {
  readonly baseUrl?: string;
}) {
  const httpClient = yield* HttpClient.HttpClient;
  const baseUrl = options?.baseUrl ?? MCP_REGISTRY_API_BASE;

  const fetchSearch = Effect.fn("McpRegistry.fetchSearch")(function* (cacheKey: string) {
    const [rawLimit, ...queryParts] = cacheKey.split(":");
    const limit = Number(rawLimit) || DEFAULT_LIMIT;
    const query = queryParts.join(":");
    const url = new URL(baseUrl);
    url.searchParams.set("limit", String(limit));
    if (query.length > 0) url.searchParams.set("search", query);

    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(url.toString()).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
        ),
      )
      .pipe(
        Effect.timeoutOrElse({
          duration: REQUEST_TIMEOUT,
          orElse: () => Effect.fail(new McpRegistryError({ reason: "unreachable" })),
        }),
        Effect.mapError((cause) =>
          isMcpRegistryError(cause)
            ? cause
            : new McpRegistryError({ reason: "unreachable", cause }),
        ),
      );

    if (response.status < 200 || response.status >= 300) {
      return yield* new McpRegistryError({ reason: "http-error", status: response.status });
    }

    const json = yield* response.json.pipe(
      Effect.mapError((cause) => new McpRegistryError({ reason: "invalid-response", cause })),
    );
    const decoded = yield* decodeRawSearchResponse(json).pipe(
      Effect.mapError((cause) => new McpRegistryError({ reason: "invalid-response", cause })),
    );

    const seen = new Set<string>();
    const entries: McpRegistryEntry[] = [];
    for (const item of decoded.servers) {
      const normalized = normalizeServerEntry(item);
      if (!normalized || seen.has(normalized.registryName)) continue;
      seen.add(normalized.registryName);
      entries.push(normalized);
    }
    return { entries } satisfies McpRegistrySearchResult;
  });

  const cache = yield* Cache.make({
    capacity: 32,
    timeToLive: CACHE_TTL,
    lookup: fetchSearch,
  });

  const search = Effect.fn("McpRegistry.search")(function* (input: McpRegistrySearchInput) {
    const query = input.query.trim();
    const limit = input.limit ?? DEFAULT_LIMIT;
    return yield* Cache.get(cache, `${limit}:${query}`);
  });

  return McpRegistry.of({ search });
});

export const layer = Layer.effect(McpRegistry, makeMcpRegistry());
