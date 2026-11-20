// @effect-diagnostics nodeBuiltinImport:off - a real local endpoint that refuses without sign-in.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { McpServerId, ServerSettings as ServerSettingsSchema } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { NativeMcpConfigs } from "./import/NativeMcpConfigs.ts";
import * as McpServerChecks from "./McpServerChecks.ts";
import * as McpUserServers from "./McpUserServers.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettingsSchema);

const node = (script: string) => ({
  enabled: true,
  transport: { type: "stdio", command: process.execPath, args: ["-e", script] },
});

// Answers a log line, then pages its tools across two answers.
const FAKE_SERVER = `
const answer = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} }) + "\\n");
  if (message.method === "initialize")
    answer(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fake", version: "1" } });
  else if (message.method === "tools/list")
    answer(message.id, message.params.cursor
      ? { tools: [{ name: "write_file", inputSchema: {} }] }
      : { tools: [{ name: "read_file", inputSchema: {}, annotations: { readOnlyHint: true } }], nextCursor: "2" });
  else if (message.method === "resources/list") answer(message.id, { resources: [{ uri: "file:///a", name: "a" }] });
});
`;

const list = (settings: unknown) =>
  Effect.gen(function* () {
    const checks = yield* McpServerChecks.McpServerChecks;
    return yield* checks.list({});
  }).pipe(Effect.provide(layer(settings)));

const layer = (settings: unknown) =>
  McpServerChecks.layer.pipe(
    Layer.provideMerge(McpUserServers.layer),
    Layer.provide([
      ServerSettings.layerTest(decodeSettings(settings)),
      ManagedPolicy.layerTest(undefined),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(NativeMcpConfigs, {
        list: () => Effect.succeed({ servers: [], errors: [] }),
      }),
      NodeServices.layer,
      FetchHttpClient.layer,
    ]),
  );

it.effect("counts a working stdio server's tools across pages and its resources", () =>
  Effect.gen(function* () {
    const { servers } = yield* list({
      mcpServers: { files: node(FAKE_SERVER), off: { ...node(FAKE_SERVER), enabled: false } },
    });
    assert.deepEqual(servers, [
      {
        id: McpServerId.make("files"),
        status: "connected",
        tools: [{ name: "read_file", readOnly: true }, { name: "write_file" }],
        resourceCount: 1,
      },
      { id: McpServerId.make("off"), status: "disabled" },
    ]);
  }),
);

it.effect("reports a server that cannot start with its stderr or the spawn error", () =>
  Effect.gen(function* () {
    const { servers } = yield* list({
      mcpServers: {
        crashes: node(
          'console.error("Error: SPLINE_TOKEN is not set\\n    at main (server.js:1)"); process.exit(1)',
        ),
        missing: {
          enabled: true,
          transport: { type: "stdio", command: "gustaf-test-no-such-mcp-server" },
        },
      },
    });
    assert.deepEqual(servers[0], {
      id: McpServerId.make("crashes"),
      status: "failed",
      error: "Error: SPLINE_TOKEN is not set\nat main (server.js:1)",
    });
    assert.deepEqual(servers[1], {
      id: McpServerId.make("missing"),
      status: "failed",
      error: "Command not found: gustaf-test-no-such-mcp-server",
    });
  }),
);

it.effect("asks for sign-in on HTTP 401, and checks again only on refresh", () =>
  Effect.gen(function* () {
    let requests = 0;
    const url = yield* Effect.acquireRelease(
      Effect.callback<NodeHttp.Server>((resume) => {
        const server = NodeHttp.createServer((_request, response) => {
          requests += 1;
          response.writeHead(401, { "www-authenticate": 'Bearer realm="mcp"' }).end();
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) => Effect.callback<void>((resume) => server.close(() => resume(Effect.void))),
    ).pipe(
      Effect.map((server) => {
        const address = server.address();
        return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
      }),
    );
    const id = McpServerId.make("jam");
    yield* Effect.gen(function* () {
      const checks = yield* McpServerChecks.McpServerChecks;
      assert.deepEqual((yield* checks.list({})).servers, [
        { id, status: "needs-auth", error: "HTTP 401" },
      ]);
      yield* checks.list({});
      assert.strictEqual(requests, 1);
      yield* checks.list({ refresh: [id] });
      assert.strictEqual(requests, 2);
    }).pipe(
      Effect.provide(
        layer({ mcpServers: { jam: { enabled: true, transport: { type: "http", url } } } }),
      ),
    );
  }).pipe(Effect.scoped),
);
