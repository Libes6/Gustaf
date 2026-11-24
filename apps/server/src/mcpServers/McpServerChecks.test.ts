// @effect-diagnostics nodeBuiltinImport:off - a real local endpoint that refuses without sign-in.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { McpServerId, ServerSettings as ServerSettingsSchema } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
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

const layer = (
  settings: unknown,
  auth = signedOut,
  nodeServices: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> = NodeServices.layer,
) =>
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
      nodeServices,
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
        approxTokens: 20,
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

it.effect("allows package launchers longer to answer than other stdio servers", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<void>();
    const spawner = ChildProcessSpawner.make(() =>
      Queue.offer(started, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const nodeServices = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const servers = {
      npx: { ...node(""), transport: { type: "stdio", command: "npx" } },
      uvx: { ...node(""), transport: { type: "stdio", command: "/usr/bin/uvx" } },
      bunx: { ...node(""), transport: { type: "stdio", command: "C:/bun/BUNX.EXE" } },
      stdio: node(""),
    };
    yield* Effect.gen(function* () {
      const checks = yield* McpServerChecks.McpServerChecks;
      const pending = yield* checks.list({}).pipe(Effect.forkChild);
      yield* Queue.takeN(started, 4);
      yield* TestClock.adjust("45 seconds");
      assert.deepEqual(
        (yield* Fiber.join(pending)).servers,
        Object.keys(servers).map((name) => ({
          id: McpServerId.make(name),
          status: "failed",
          error: `No answer in ${name === "stdio" ? 15 : 45} seconds.`,
        })),
      );
    }).pipe(
      Effect.provide(layer({ mcpServers: servers }, signedOut, nodeServices)),
      Effect.provideService(SpawnExecutableResolution, (command) => command),
    );
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
      assert.deepEqual(yield* checks.knownUnusable, new Map([[id, "Needs sign-in."]]));
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
          approxTokens: 10,
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
        { id, status: "failed", error: "Antigravity could not start it.", signedIn: true },
      ]);
      // Thread notices show these reasons, so no server output reaches them.
      assert.deepEqual(yield* checks.knownUnusable, new Map([[id, "Did not start."]]));
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

it.effect("a timed-out stdio check closes its descendant's connection", () =>
  Effect.gen(function* () {
    const accepted = Promise.withResolvers<{ closed: Promise<void> }>();
    const server = yield* Effect.acquireRelease(
      Effect.callback<NodeHttp.Server>((resume) => {
        const server = NodeHttp.createServer((request) => {
          const closed = new Promise<void>((resolve) => request.socket.once("close", resolve));
          accepted.resolve({ closed });
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.closeAllConnections();
          server.close(() => resume(Effect.void));
        }),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* Effect.die("Expected a TCP address for the test server");
    }
    const descendant = `require("node:http").get("http://127.0.0.1:${address.port}", () => {}).on("error", () => {});`;
    const processTree = node(
      `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
    );
    const listed = yield* list({ mcpServers: { silent: processTree } }).pipe(Effect.forkChild);
    const { closed } = yield* Effect.promise(() => accepted.promise);
    yield* TestClock.adjust("17 seconds");
    assert.deepEqual((yield* Fiber.join(listed)).servers, [
      { id: McpServerId.make("silent"), status: "failed", error: "No answer in 15 seconds." },
    ]);
    yield* Effect.promise(() => closed);
  }).pipe(Effect.scoped),
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

it.effect("a server with the user's own Authorization header is not shown as signed in", () =>
  Effect.gen(function* () {
    const tokenRequests: Array<boolean> = [];
    const signedIn = Layer.mock(McpServerAuth)({
      accessToken: (_id, _url, options) =>
        Effect.sync(() => void tokenRequests.push(options?.force === true)).pipe(
          Effect.as("gustaf-token"),
        ),
      isSignedIn: () => Effect.succeed(true),
      revision: () => Effect.succeed(1),
    });
    const { servers } = yield* Effect.gen(function* () {
      const checks = yield* McpServerChecks.McpServerChecks;
      return yield* checks.list({});
    }).pipe(
      Effect.provide(
        layer(
          {
            mcpServers: {
              jam: {
                enabled: true,
                transport: {
                  type: "http",
                  url: "http://127.0.0.1:1/mcp",
                  headers: { authorization: "Bearer own" },
                },
              },
            },
          },
          signedIn,
        ),
      ),
    );
    assert.strictEqual(servers[0]?.status, "failed");
    assert.notProperty(servers[0], "signedIn");
    assert.deepEqual(tokenRequests, []);
  }),
);

it("weighs a tool by the JSON the model reads, counting bytes rather than characters", () => {
  // 120 bytes: the dash and the accented letters are multi-byte; ÷ 3.7 rounds to 32.
  assert.strictEqual(
    McpServerChecks.approximateToolTokens([
      {
        name: "search",
        description: "Zoek — résumé",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]),
    32,
  );
  assert.strictEqual(McpServerChecks.approximateToolTokens([]), 0);
});
