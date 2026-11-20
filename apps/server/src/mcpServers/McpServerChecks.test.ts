// @effect-diagnostics nodeBuiltinImport:off - a real local endpoint that refuses without sign-in.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { McpServerId, ServerSettings as ServerSettingsSchema } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { McpServerAuth } from "./McpServerAuth.ts";
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

const signedOut = Layer.mock(McpServerAuth)({
  accessToken: () => Effect.undefined,
  isSignedIn: () => Effect.succeed(false),
  revision: () => Effect.succeed(0),
});

const layer = (settings: unknown, auth = signedOut) =>
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
      auth,
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

it.effect("asks for sign-in on HTTP 401, checks again on refresh, and after signing in", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    // Answers MCP only with the token a sign-in gives; anything else is HTTP 401.
    const url = yield* Effect.acquireRelease(
      Effect.callback<NodeHttp.Server>((resume) => {
        const server = NodeHttp.createServer((request, response) => {
          requests.push(request.headers.authorization ?? "none");
          if (request.headers.authorization !== "Bearer fresh-token") {
            response.writeHead(401, { "www-authenticate": 'Bearer realm="mcp"' }).end();
            return;
          }
          let body = "";
          request.on("data", (chunk: Buffer) => (body += chunk.toString()));
          request.on("end", () => {
            if (request.method !== "POST") return void response.writeHead(200).end();
            const message = JSON.parse(body) as { id?: number; method: string };
            if (message.id === undefined) return void response.writeHead(202).end();
            const result =
              message.method === "initialize"
                ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
                : { tools: [{ name: "get_issue", inputSchema: {} }] };
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
          });
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
        }),
    ).pipe(
      Effect.map((server) => {
        const address = server.address();
        return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
      }),
    );
    const id = McpServerId.make("jam");
    let signedIn = false;
    // The stored token has expired early; only a forced refresh yields one the server takes.
    const auth = Layer.mock(McpServerAuth)({
      accessToken: (_id, _url, options) =>
        Effect.succeed(signedIn ? (options?.force ? "fresh-token" : "stale-token") : undefined),
      isSignedIn: () => Effect.succeed(signedIn),
      revision: () => Effect.succeed(signedIn ? 1 : 0),
    });
    yield* Effect.gen(function* () {
      const checks = yield* McpServerChecks.McpServerChecks;
      assert.strictEqual((yield* checks.knownUnusable).size, 0);
      assert.deepEqual((yield* checks.list({})).servers, [
        { id, status: "needs-auth", error: "HTTP 401" },
      ]);
      // Sessions of agents that refuse a failing server read this without checking again.
      assert.deepEqual(
        yield* checks.knownUnusable,
        new Map([[id, "Needs sign-in (last check in Settings → MCP)."]]),
      );
      yield* checks.list({});
      assert.strictEqual(requests.length, 1);
      yield* checks.list({ refresh: [id] });
      assert.strictEqual(requests.length, 2);

      signedIn = true;
      assert.strictEqual((yield* checks.knownUnusable).size, 0);
      assert.deepEqual((yield* checks.list({})).servers, [
        {
          id,
          status: "connected",
          tools: [{ name: "get_issue" }],
          resourceCount: 0,
          signedIn: true,
        },
      ]);
      assert.deepEqual(requests.slice(2, 4), ["Bearer stale-token", "Bearer fresh-token"]);

      // An agent that could not start it marks it failed; nothing is checked until a refresh.
      const requestsBefore = requests.length;
      yield* checks.markFailed({
        id: McpServerId.make("not-configured"),
        error: "ignored",
        needsAuth: false,
      });
      yield* checks.markFailed({ id, error: "Antigravity could not start it.", needsAuth: false });
      assert.deepEqual((yield* checks.list({})).servers, [
        { id, status: "failed", error: "Antigravity could not start it." },
      ]);
      assert.deepEqual(
        yield* checks.knownUnusable,
        new Map([[id, "Failed its last check in Settings → MCP: Antigravity could not start it."]]),
      );
      assert.strictEqual(requests.length, requestsBefore);
      assert.strictEqual((yield* checks.list({ refresh: [id] })).servers[0]?.status, "connected");
    }).pipe(
      Effect.provide(
        layer({ mcpServers: { jam: { enabled: true, transport: { type: "http", url } } } }, auth),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("a token refresh that hangs counts against the check's timeout", () =>
  Effect.gen(function* () {
    const hung = Layer.mock(McpServerAuth)({
      accessToken: () => Effect.never,
      isSignedIn: () => Effect.succeed(true),
      revision: () => Effect.succeed(1),
    });
    yield* Effect.gen(function* () {
      const checks = yield* McpServerChecks.McpServerChecks;
      const listed = yield* checks.list({}).pipe(Effect.forkChild);
      yield* TestClock.adjust("15 seconds");
      assert.deepEqual((yield* Fiber.join(listed)).servers, [
        {
          id: McpServerId.make("jam"),
          status: "failed",
          error: "No answer in 15 seconds.",
          signedIn: true,
        },
      ]);
    }).pipe(
      Effect.provide(
        layer(
          {
            mcpServers: {
              jam: { enabled: true, transport: { type: "http", url: "https://mcp.jam.test/mcp" } },
            },
          },
          hung,
        ),
      ),
    );
  }),
);

it.effect("a check in the home folder never keeps a thread-folder server out of sessions", () =>
  Effect.gen(function* () {
    const crashes = node('console.error("No package.json here"); process.exit(1)');
    yield* Effect.gen(function* () {
      const checks = yield* McpServerChecks.McpServerChecks;
      const { servers } = yield* checks.list({});
      assert.deepEqual(
        servers.map((server) => server.status),
        ["failed", "failed"],
      );
      const pinned = McpServerId.make("pinned");
      const project = McpServerId.make("project");
      assert.deepEqual([...(yield* checks.knownUnusable).keys()], [pinned]);

      // A session that could not start it in the thread's folder is another matter.
      yield* checks.markFailed({
        id: project,
        error: "Antigravity could not start it.",
        needsAuth: false,
      });
      assert.deepEqual([...(yield* checks.knownUnusable).keys()], [pinned, project]);
    }).pipe(
      Effect.provide(
        layer({
          mcpServers: {
            pinned: { ...crashes, transport: { ...crashes.transport, cwd: process.cwd() } },
            project: crashes,
          },
        }),
      ),
    );
  }),
);

it.effect(
  "a session refused for sign-in keeps the sign-in button, and never overrides a running check",
  () =>
    Effect.gen(function* () {
      const id = McpServerId.make("jam");
      const silent = McpServerId.make("silent");
      yield* Effect.gen(function* () {
        const checks = yield* McpServerChecks.McpServerChecks;
        yield* checks.markFailed({ id, error: "Antigravity: HTTP 401.", needsAuth: true });
        // A stdio server cannot be signed in to, so it stays failed.
        yield* checks.markFailed({ id: silent, error: "Unauthorized.", needsAuth: true });
        const listed = yield* checks.list({ refresh: [silent] }).pipe(Effect.forkChild);
        yield* checks.markFailed({ id: silent, error: "Antigravity failed.", needsAuth: false });
        yield* TestClock.adjust("15 seconds");
        assert.deepEqual((yield* Fiber.join(listed)).servers, [
          { id, status: "needs-auth", error: "Antigravity: HTTP 401." },
          { id: silent, status: "failed", error: "No answer in 15 seconds." },
        ]);
        assert.deepEqual((yield* checks.list({})).servers[1], {
          id: silent,
          status: "failed",
          error: "No answer in 15 seconds.",
        });
      }).pipe(
        Effect.provide(
          layer({
            mcpServers: {
              jam: { enabled: true, transport: { type: "http", url: "https://mcp.jam.test/mcp" } },
              silent: node("setInterval(() => {}, 1000)"),
            },
          }),
        ),
      );
    }),
);
