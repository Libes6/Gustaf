// MCP servers speak foreign JSON-RPC: messages are written as plain JSON and decoded loosely.
// @effect-diagnostics globalJsonInEffect:off
import {
  type McpServerConfig,
  type McpServerId,
  type McpServerStatus,
  McpServerStatusError,
  type McpServerStatusListInput,
  type McpServerStatusListResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { McpServerAuth } from "./McpServerAuth.ts";
import * as McpUserServers from "./McpUserServers.ts";

const CHECK_TIMEOUT = Duration.seconds(15);
const CHECK_CONCURRENCY = 4;
const PROTOCOL_VERSION = "2025-06-18";
const MAX_LIST_PAGES = 20;
const MAX_STDERR_CHARS = 4_096;

/**
 * Starts or reaches each of the user's MCP servers to tell whether it works. Checks run only when
 * a client asks: `npx …@latest` servers download packages, so a check is never free.
 */
export class McpServerChecks extends Context.Service<
  McpServerChecks,
  {
    /** Every configured server, answered from this environment's cache unless it changed. */
    readonly list: (
      input: McpServerStatusListInput,
    ) => Effect.Effect<McpServerStatusListResult, McpServerStatusError>;
    /**
     * Servers whose last finished check, of their current config, failed or needs sign-in.
     * Checks of stdio servers that run in the thread's folder count only when a session failed.
     * Reads the cache only; it never starts a check.
     */
    readonly knownUnusable: Effect.Effect<ReadonlyMap<McpServerId, string>>;
    /**
     * Records a server an agent could not start as failed, or as needing sign-in when an http
     * server refused it, without checking it, so the next session leaves it out and the section
     * shows why until the next check. A check of its current config already running decides.
     */
    readonly markFailed: (input: {
      readonly id: McpServerId;
      readonly error: string;
      readonly needsAuth: boolean;
    }) => Effect.Effect<void>;
  }
>()("t3/mcpServers/McpServerChecks") {}

class ProbeFailure extends Schema.TaggedError<ProbeFailure>()("ProbeFailure", {
  status: Schema.Literals(["needs-auth", "failed"]),
  detail: Schema.String,
}) {}

const failed = (detail: string) => new ProbeFailure({ status: "failed", detail });

interface JsonRpc {
  readonly request: (method: string, params: object) => Effect.Effect<unknown, ProbeFailure>;
  readonly notify: (method: string) => Effect.Effect<void, ProbeFailure>;
}

const JsonRpcResponse = Schema.Struct({
  id: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcResponse));

const Initialized = Schema.Struct({
  capabilities: Schema.optional(
    Schema.Struct({
      tools: Schema.optional(Schema.Unknown),
      resources: Schema.optional(Schema.Unknown),
    }),
  ),
});
const ListPage = Schema.Struct({
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  resources: Schema.optional(Schema.Array(Schema.Unknown)),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const Tools = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    annotations: Schema.optional(
      Schema.NullOr(Schema.Struct({ readOnlyHint: Schema.optional(Schema.Boolean) })),
    ),
  }),
);

const decodeOrFail =
  <S extends Schema.Decoder<unknown>>(schema: S, what: string) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => failed(`The server sent an invalid ${what} answer.`)),
    );

const firstLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .join("\n")
    .slice(0, 500);

const resultOf = (method: string, response: typeof JsonRpcResponse.Type) =>
  response.error !== undefined
    ? Effect.fail(failed(`${method}: ${response.error.message}`))
    : Effect.succeed(response.result);

const inspect = Effect.fn("McpServerChecks.inspect")(function* (rpc: JsonRpc) {
  const initialized = yield* rpc
    .request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "gustaf", version: "1" },
    })
    .pipe(Effect.flatMap(decodeOrFail(Initialized, "initialize")));
  yield* rpc.notify("notifications/initialized");

  const listAll = Effect.fnUntraced(function* (method: string, key: "tools" | "resources") {
    const items: Array<unknown> = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = yield* rpc
        .request(method, cursor === undefined ? {} : { cursor })
        .pipe(Effect.flatMap(decodeOrFail(ListPage, method)));
      items.push(...(result[key] ?? []));
      cursor = result.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }
    return items;
  });

  const capabilities = initialized.capabilities;
  const tools =
    capabilities?.tools === undefined
      ? []
      : yield* listAll("tools/list", "tools").pipe(
          Effect.flatMap(decodeOrFail(Tools, "tools/list")),
        );
  const resources =
    capabilities?.resources === undefined ? [] : yield* listAll("resources/list", "resources");
  return {
    tools: tools.map((tool) =>
      tool.annotations?.readOnlyHint === undefined
        ? { name: tool.name }
        : { name: tool.name, readOnly: tool.annotations.readOnlyHint },
    ),
    resourceCount: resources.length,
  };
});

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const userServers = yield* McpUserServers.McpUserServers;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const auth = yield* McpServerAuth;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;
  const permits = yield* Semaphore.make(CHECK_CONCURRENCY);
  // The latest check per server and the config it checked; a changed config is checked again.
  const checks = new Map<
    McpServerId,
    {
      readonly fingerprint: string;
      readonly result: Deferred.Deferred<McpServerStatus>;
      /** A session's own failure, as opposed to a check run here. */
      readonly fromSession?: boolean;
    }
  >();

  const startStdio = Effect.fn("McpServerChecks.startStdio")(function* (
    server: Extract<McpUserServers.ResolvedMcpServer, { type: "stdio" }>,
    stderr: { text: string },
  ) {
    const command = yield* resolveSpawnCommand(server.command, server.args, {
      env: server.env,
      extendEnv: true,
    });
    // Closing the check's scope kills this process group, and nothing else.
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(command.command, command.args, {
          cwd: server.cwd,
          env: server.env,
          extendEnv: true,
          shell: command.shell,
          forceKillAfter: Duration.seconds(2),
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          failed(
            error.reason._tag === "NotFound"
              ? `Command not found: ${server.command}`
              : error.message,
          ),
        ),
        Effect.catchDefect((cause) =>
          Effect.fail(failed(cause instanceof Error ? cause.message : String(cause))),
        ),
      );
    const stderrDone = yield* handle.stderr.pipe(
      Stream.decodeText,
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          if (stderr.text.length < MAX_STDERR_CHARS) stderr.text += chunk;
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const lines = yield* Queue.unbounded<string, PlatformError.PlatformError | Cause.Done>();
    yield* handle.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runIntoQueue(lines),
      Effect.forkScoped,
    );
    const outgoing = yield* Queue.unbounded<string, Cause.Done>();
    yield* Stream.fromQueue(outgoing).pipe(
      Stream.encodeText,
      Stream.run(handle.stdin),
      Effect.ignore,
      Effect.forkScoped,
    );

    const ended = Effect.gen(function* () {
      const code = yield* handle.exitCode.pipe(Effect.option);
      yield* Fiber.join(stderrDone);
      return failed(
        firstLines(stderr.text) ||
          (Option.isSome(code)
            ? `The server exited with code ${code.value}.`
            : "The server closed its output."),
      );
    });
    let nextId = 0;
    const send = (message: object) =>
      Queue.offer(outgoing, `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

    return {
      notify: (method) => send({ method }).pipe(Effect.asVoid),
      request: Effect.fnUntraced(function* (method, params) {
        const id = ++nextId;
        yield* send({ id, method, params });
        while (true) {
          const line = yield* Queue.take(lines).pipe(
            Effect.catch((error) =>
              error._tag === "Done"
                ? Effect.flatMap(ended, Effect.fail)
                : Effect.fail(failed(error.message)),
            ),
          );
          const response = decodeLine(line);
          if (Option.isSome(response) && response.value.id === id) {
            return yield* resultOf(method, response.value);
          }
        }
      }),
    } satisfies JsonRpc;
  });

  const startHttp = Effect.fn("McpServerChecks.startHttp")(function* (
    server: Extract<McpUserServers.ResolvedMcpServer, { type: "http" }>,
  ) {
    let sessionId: string | undefined;
    let protocolVersion: string | undefined;
    let nextId = 0;
    const withHeaders = (request: HttpClientRequest.HttpClientRequest) =>
      HttpClientRequest.setHeaders(request, {
        ...server.headers,
        accept: "application/json, text/event-stream",
        ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
        ...(protocolVersion === undefined ? {} : { "mcp-protocol-version": protocolVersion }),
      });
    const toFailure = (error: { readonly message: string }) => failed(error.message);
    const post = Effect.fnUntraced(function* (message: object) {
      const response = yield* httpClient
        .execute(
          HttpClientRequest.post(server.url).pipe(
            withHeaders,
            HttpClientRequest.setBody(
              HttpBody.text(JSON.stringify({ jsonrpc: "2.0", ...message }), "application/json"),
            ),
          ),
        )
        .pipe(Effect.mapError(toFailure));
      sessionId = response.headers["mcp-session-id"] ?? sessionId;
      if (response.status >= 200 && response.status < 300) return response;
      return yield* response.status === 401
        ? new ProbeFailure({ status: "needs-auth", detail: "HTTP 401" })
        : failed(`HTTP ${response.status}`);
    });
    // Ending the session is a courtesy; servers expire abandoned ones.
    yield* Effect.addFinalizer(() =>
      sessionId === undefined
        ? Effect.void
        : httpClient
            .execute(HttpClientRequest.delete(server.url).pipe(withHeaders))
            .pipe(Effect.timeout("2 seconds"), Effect.ignore),
    );

    return {
      notify: (method) => post({ method }).pipe(Effect.asVoid),
      request: Effect.fnUntraced(function* (method, params) {
        const id = ++nextId;
        const response = yield* post({ id, method, params });
        const isEventStream = (response.headers["content-type"] ?? "").includes(
          "text/event-stream",
        );
        const bodies = isEventStream
          ? response.stream.pipe(
              Stream.decodeText,
              Stream.splitLines,
              Stream.filter((line) => line.startsWith("data:")),
              Stream.map((line) => line.slice("data:".length).trim()),
            )
          : Stream.fromEffect(response.text);
        const answer = yield* bodies.pipe(
          Stream.mapError(toFailure),
          Stream.map((body) => decodeLine(body)),
          Stream.filter((decoded) => Option.isSome(decoded) && decoded.value.id === id),
          Stream.runHead,
          Effect.map(Option.flatten),
        );
        if (Option.isNone(answer)) return yield* failed(`${method}: the server sent no answer.`);
        const result = yield* resultOf(method, answer.value);
        if (method === "initialize") {
          const version = (result as { readonly protocolVersion?: unknown } | null)
            ?.protocolVersion;
          protocolVersion = typeof version === "string" ? version : PROTOCOL_VERSION;
        }
        return result;
      }),
    } satisfies JsonRpc;
  });

  const attempt = Effect.fnUntraced(function* (
    id: McpServerId,
    server: McpServerConfig,
    cwd: string,
    refreshToken: boolean,
  ) {
    const stderr = { text: "" };
    // Resolving may refresh a sign-in's token over the network, so it shares the timeout.
    const connect = userServers
      .resolveServer({ id, server, cwd, refreshToken })
      .pipe(
        Effect.flatMap((resolved) =>
          "unusable" in resolved
            ? Effect.fail(failed(resolved.unusable))
            : resolved.type === "stdio"
              ? startStdio(resolved, stderr)
              : startHttp(resolved),
        ),
      );
    return yield* connect.pipe(
      Effect.flatMap(inspect),
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: CHECK_TIMEOUT,
        orElse: () =>
          Effect.fail(
            failed(
              [
                `No answer in ${Duration.toSeconds(CHECK_TIMEOUT)} seconds.`,
                firstLines(stderr.text),
              ]
                .filter(Boolean)
                .join("\n"),
            ),
          ),
      }),
      Effect.map(({ tools, resourceCount }): McpServerStatus => ({
        id,
        status: "connected",
        tools,
        resourceCount,
      })),
      Effect.catchTags({
        ProbeFailure: (failure) =>
          Effect.succeed<McpServerStatus>({ id, status: failure.status, error: failure.detail }),
      }),
    );
  });

  const check = Effect.fn("McpServerChecks.check")(function* (
    id: McpServerId,
    server: McpServerConfig,
  ) {
    yield* Effect.annotateCurrentSpan({
      "mcp_server.id": id,
      "mcp_server.transport": server.transport.type,
    });
    const cwd = yield* HostProcess.HomeDirectory;
    const signedIn =
      server.transport.type === "http" && (yield* auth.isSignedIn(id, server.transport.url));
    const first = yield* attempt(id, server, cwd, false);
    // A rejected token may only have expired early; one refresh decides.
    const status =
      signedIn && first.status === "needs-auth" ? yield* attempt(id, server, cwd, true) : first;
    return signedIn ? { ...status, signedIn } : status;
  });

  // Signing in or out changes what the server is sent, so it is checked again.
  const fingerprintOf = (id: McpServerId, server: McpServerConfig) =>
    auth.revision(id).pipe(Effect.map((revision) => JSON.stringify([server.transport, revision])));

  const statusOf = Effect.fnUntraced(function* (
    id: McpServerId,
    server: McpServerConfig,
    refresh: boolean,
  ) {
    const fingerprint = yield* fingerprintOf(id, server);
    const cached = checks.get(id);
    // A refresh joins a check that is still running instead of starting a second process.
    if (
      cached !== undefined &&
      cached.fingerprint === fingerprint &&
      !(refresh && Deferred.isDoneUnsafe(cached.result))
    ) {
      return yield* Deferred.await(cached.result);
    }
    const result = Deferred.makeUnsafe<McpServerStatus>();
    checks.set(id, { fingerprint, result });
    // The check outlives the request that started it, so others waiting on it still get an answer.
    yield* check(id, server).pipe(
      Semaphore.withPermit(permits),
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(result, exit)),
      Effect.forkIn(serviceScope),
    );
    return yield* Deferred.await(result);
  });

  const list = Effect.fn("McpServerChecks.list")(function* (input: McpServerStatusListInput) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new McpServerStatusError({ cause })),
    );
    const entries = Object.entries(current.mcpServers) as Array<[McpServerId, McpServerConfig]>;
    for (const id of checks.keys()) {
      if (!Object.hasOwn(current.mcpServers, id)) checks.delete(id);
    }
    const refresh = new Set(input.refresh ?? []);
    const localDenied = ManagedPolicy.deniedBy(policy, "localMcpServers") !== undefined;
    const servers = yield* Effect.forEach(
      entries,
      ([id, server]) =>
        !server.enabled || (localDenied && server.transport.type === "stdio")
          ? Effect.succeed<McpServerStatus>({ id, status: "disabled" })
          : statusOf(id, server, refresh.has(id)),
      { concurrency: "unbounded" },
    );
    return { servers };
  });

  const knownUnusable = Effect.gen(function* () {
    const unusable = new Map<McpServerId, string>();
    const current = yield* settings.getSettings.pipe(Effect.option);
    if (Option.isNone(current)) return unusable;
    for (const [id, { fingerprint, result, fromSession }] of checks) {
      const server = current.value.mcpServers[id];
      if (server === undefined || (yield* fingerprintOf(id, server)) !== fingerprint) continue;
      // Checks run such a server in the home folder; a thread's folder may well have what it needs.
      if (
        fromSession !== true &&
        server.transport.type === "stdio" &&
        server.transport.cwd === "thread"
      ) {
        continue;
      }
      const done = yield* Deferred.poll(result);
      if (Option.isNone(done)) continue;
      const status = yield* done.value.pipe(Effect.option);
      if (Option.isNone(status)) continue;
      if (status.value.status === "needs-auth") {
        unusable.set(id, "Needs sign-in (last check in Settings → MCP).");
      } else if (status.value.status === "failed") {
        unusable.set(
          id,
          `Failed its last check in Settings → MCP${status.value.error === undefined ? "." : `: ${status.value.error}`}`,
        );
      }
    }
    return unusable;
  }).pipe(Effect.withSpan("McpServerChecks.knownUnusable"));

  const markFailed = Effect.fn("McpServerChecks.markFailed")(function* ({
    id,
    error,
    needsAuth,
  }: {
    readonly id: McpServerId;
    readonly error: string;
    readonly needsAuth: boolean;
  }) {
    const current = yield* settings.getSettings.pipe(Effect.option);
    const server = Option.isSome(current) ? current.value.mcpServers[id] : undefined;
    if (server === undefined) return;
    const fingerprint = yield* fingerprintOf(id, server);
    const running = checks.get(id);
    if (
      running !== undefined &&
      running.fingerprint === fingerprint &&
      !Deferred.isDoneUnsafe(running.result)
    ) {
      return;
    }
    const status = needsAuth && server.transport.type === "http" ? "needs-auth" : "failed";
    const result = yield* Deferred.make<McpServerStatus>();
    yield* Deferred.succeed(result, { id, status, error });
    checks.set(id, { fingerprint, result, fromSession: true });
  });

  return McpServerChecks.of({ list, knownUnusable, markFailed });
});

export const layer = Layer.effect(McpServerChecks, make);
