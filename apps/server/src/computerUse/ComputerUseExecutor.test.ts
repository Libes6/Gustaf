// @effect-diagnostics nodeBuiltinImport:off -- A real Unix socket stands in for the shell.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ComputerUseExecutor from "./ComputerUseExecutor.ts";
import { takeComputerUseEndpoint } from "./executorEndpoint.ts";

const status = { availability: "ready", emergencyShortcut: "⌃⌥⌘⎋" };

/** Answers like channel.rs: token first, one reply line per request, status events pushed. */
const fakeShell = Effect.acquireRelease(
  Effect.callback<
    {
      readonly socketPath: string;
      readonly lines: Array<Record<string, unknown>>;
      readonly connections: Array<NodeNet.Socket>;
      readonly server: NodeNet.Server;
      readonly screenshotSeen: Promise<void>;
    },
    never
  >((resume) => {
    const seen = Promise.withResolvers<void>();
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gcu-"));
    const socketPath = NodePath.join(directory, "s.sock");
    const lines: Array<Record<string, unknown>> = [];
    const connections: Array<NodeNet.Socket> = [];
    const server = NodeNet.createServer((socket) => {
      connections.push(socket);
      let buffered = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffered += chunk;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const request = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
          lines.push(request);
          if (request.op === "screenshot") seen.resolve();
          const reply =
            request.token !== "launch-secret"
              ? { id: request.id, ok: false, error: { code: "unauthorized", message: "No." } }
              : request.op === "start"
                ? { id: request.id, ok: true, result: { sessionToken: "S" } }
                : request.op === "screenshot"
                  ? null
                  : { id: request.id, ok: true, result: status };
          if (reply !== null) socket.write(`${JSON.stringify(reply)}\n`);
          if (request.op === "start") {
            socket.write(
              `${JSON.stringify({ event: "status", status: { ...status, availability: "active" } })}\n`,
            );
          }
        }
      });
    });
    server.listen(socketPath, () =>
      resume(
        Effect.succeed({ socketPath, lines, connections, server, screenshotSeen: seen.promise }),
      ),
    );
  }),
  (shell) =>
    Effect.sync(() => {
      for (const socket of shell.connections) socket.destroy();
      shell.server.close();
      NodeFS.rmSync(NodePath.dirname(shell.socketPath), { recursive: true, force: true });
    }),
);

describe("ComputerUseExecutor socket", () => {
  it.live("sends the launch token, routes replies and events, and reports a lost session", () =>
    Effect.gen(function* () {
      const shell = yield* fakeShell;
      const executor = yield* ComputerUseExecutor.makeSocket({
        socketPath: shell.socketPath,
        token: "launch-secret",
      });
      const events = yield* executor.subscribe;

      expect(yield* executor.oneShot({ op: "status" })).toEqual(status);
      expect(
        yield* executor.session({
          op: "start",
          owner: { environmentId: "e", threadId: "t", label: "T" },
        }),
      ).toEqual({ sessionToken: "S" });
      expect(yield* PubSub.take(events)).toEqual({
        _tag: "Status",
        status: { ...status, availability: "active" },
      });
      expect(shell.lines.map((line) => [line.op, line.token])).toEqual([
        ["status", "launch-secret"],
        ["start", "launch-secret"],
      ]);
      // Two connections: the one-shot status, then the session connection that stays open.
      expect(shell.connections).toHaveLength(2);

      // The shell goes away mid-step: the waiting call fails and the session is reported gone.
      const pending = yield* Effect.forkChild(
        Effect.flip(Effect.asVoid(executor.session({ op: "screenshot", sessionToken: "S" }))),
      );
      yield* Effect.promise(() => shell.screenshotSeen);
      shell.connections[1]!.destroy();
      expect(yield* PubSub.take(events)).toEqual({ _tag: "Disconnected" });
      expect((yield* Fiber.join(pending)).code).toBe("failed");
    }).pipe(Effect.scoped),
  );

  it.live("surfaces the shell's refusal as a typed error", () =>
    Effect.gen(function* () {
      const shell = yield* fakeShell;
      const executor = yield* ComputerUseExecutor.makeSocket({
        socketPath: shell.socketPath,
        token: "wrong",
      });
      const error = yield* Effect.flip(Effect.asVoid(executor.oneShot({ op: "status" })));
      expect(error.code).toBe("unauthorized");
    }).pipe(Effect.scoped),
  );
});

describe("takeComputerUseEndpoint", () => {
  it("removes the address and token from the environment agents inherit", () => {
    const env: Record<string, string | undefined> = {
      GUSTAF_COMPUTER_USE_SOCKET: "/tmp/x.sock",
      GUSTAF_COMPUTER_USE_TOKEN: "secret",
      PATH: "/bin",
    };
    expect(takeComputerUseEndpoint(env)).toEqual({ socketPath: "/tmp/x.sock", token: "secret" });
    expect(env).toEqual({ PATH: "/bin" });
    // A second read, as by the executor layer, finds the first one's value.
    expect(takeComputerUseEndpoint({})).toEqual({ socketPath: "/tmp/x.sock", token: "secret" });
  });
});
