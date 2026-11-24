import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as McpRegistry from "./McpRegistry.ts";

function makeClientLayer(
  handler: (url: string) => { readonly status: number; readonly body: unknown },
) {
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const { status, body } = handler(request.url);
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  return McpRegistry.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)));
}

it.effect("parses remote HTTP and npm/pypi stdio servers and filters stale entries", () =>
  Effect.gen(function* () {
    const registry = yield* McpRegistry.McpRegistry;
    const result = yield* registry.search({ query: "playwright", limit: 10 });
    expect(result.entries).toEqual([
      {
        registryName: "com.example/playwright-mcp",
        suggestedId: "playwright",
        name: "Playwright Cloud",
        description: "Remote browser automation",
        version: "1.2.0",
        homepageUrl: "https://playwright.dev",
        repositoryUrl: "https://github.com/example/playwright-mcp",
        tags: ["browser", "testing"],
        transport: {
          type: "http",
          url: "https://mcp.playwright.dev/mcp",
          headers: [{ key: "Authorization", description: "Bearer token" }],
        },
      },
      {
        registryName: "io.github.org/fetch-tool",
        suggestedId: "fetch-tool",
        name: "fetch-tool",
        description: "Fetch web pages",
        tags: [],
        transport: {
          type: "stdio",
          command: "uvx",
          args: ["mcp-server-fetch"],
          env: [{ key: "FETCH_TOKEN" }],
        },
      },
    ]);
  }).pipe(
    Effect.provide(
      makeClientLayer((url) => {
        expect(url).toContain("search=playwright");
        expect(url).toContain("limit=10");
        return {
          status: 200,
          body: {
            servers: [
              {
                server: {
                  name: "com.example/playwright-mcp",
                  title: "Playwright Cloud",
                  description: "Remote browser automation",
                  version: "1.2.0",
                  websiteUrl: "https://playwright.dev",
                  repository: { url: "https://github.com/example/playwright-mcp" },
                  remotes: [
                    {
                      type: "streamable-http",
                      url: "https://mcp.playwright.dev/mcp",
                      headers: [{ name: "Authorization", description: "Bearer token" }],
                    },
                  ],
                  _meta: {
                    "io.modelcontextprotocol.registry/publisher-provided": {
                      tags: ["browser", "testing"],
                    },
                  },
                },
                _meta: {
                  "io.modelcontextprotocol.registry/official": {
                    status: "active",
                    isLatest: true,
                  },
                },
              },
              {
                server: {
                  name: "com.example/playwright-mcp",
                  description: "Older version should be filtered",
                  remotes: [{ type: "streamable-http", url: "https://old.example.com/mcp" }],
                },
                _meta: {
                  "io.modelcontextprotocol.registry/official": {
                    status: "active",
                    isLatest: false,
                  },
                },
              },
              {
                server: {
                  name: "io.github.org/fetch-tool",
                  description: "Fetch web pages",
                  packages: [
                    {
                      registryType: "pypi",
                      identifier: "mcp-server-fetch",
                      transport: { type: "stdio" },
                      environmentVariables: [{ name: "FETCH_TOKEN" }],
                    },
                  ],
                },
              },
              {
                server: {
                  name: "com.example/templated-only",
                  description: "Templated URL skipped",
                  remotes: [{ type: "streamable-http", url: "https://{region}.example.com/mcp" }],
                },
              },
            ],
          },
        };
      }),
    ),
  ),
);

it.effect("maps non-2xx responses into McpRegistryError", () =>
  Effect.gen(function* () {
    const registry = yield* McpRegistry.McpRegistry;
    const error = yield* registry.search({ query: "test" }).pipe(Effect.flip);
    expect(error._tag).toBe("McpRegistryError");
    expect(error.reason).toBe("http-error");
    expect(error.status).toBe(503);
  }).pipe(Effect.provide(makeClientLayer(() => ({ status: 503, body: { error: "down" } })))),
);
