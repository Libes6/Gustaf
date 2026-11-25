// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import { readCloudCredential } from "../relay/RelayHost.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { resolveCliAuthConfig } from "./config.ts";
import { storeRelayCredential } from "./relay.ts";

const layerCliRuntime = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  NetService.layer,
  FetchHttpClient.layer,
);
const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);
const CREDENTIAL = { relayUrl: "https://cloud.test", deviceId: "dev-1", token: "gdt_x" };

const storedCredential = (baseDir: string) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none());
    return yield* Effect.gen(function* () {
      return yield* readCloudCredential(yield* ServerSecretStore.ServerSecretStore);
    }).pipe(
      Effect.provide(ServerSecretStore.layer.pipe(Layer.provide(ServerConfig.layer(config)))),
    );
  });

describe("gustaf relay", () => {
  it.effect("stores the credential for the next start; logout forgets it", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-relay-cli-"));
      assert.isFalse(yield* storeRelayCredential(Option.some(baseDir), CREDENTIAL));
      assert.deepEqual(Option.getOrNull(yield* storedCredential(baseDir)), CREDENTIAL);

      yield* runCli(["relay", "logout", "--base-dir", baseDir]);
      assert.isTrue(Option.isNone(yield* storedCredential(baseDir)));
    }).pipe(Effect.provide(layerCliRuntime)),
  );

  it.effect("hands the credential to a running server with a short-lived relay session", () =>
    Effect.acquireUseRelease(
      Effect.callback<{
        server: NodeHttp.Server;
        received: Array<{ method: string; authorization: string; body: string }>;
      }>((resume) => {
        const received: Array<{ method: string; authorization: string; body: string }> = [];
        const server = NodeHttp.createServer((request, response) => {
          if (request.url === "/.well-known/t3/environment") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                environmentId: "relay-test",
                label: "relay-test",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.1",
                orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                capabilities: { repositoryIdentity: true },
              }),
            );
            return;
          }
          let body = "";
          request.on("data", (chunk) => (body += chunk));
          request.on("end", () => {
            received.push({
              method: request.method ?? "",
              authorization: request.headers.authorization ?? "",
              body,
            });
            response.writeHead(request.url === "/api/relay-host/credential" ? 200 : 404, {
              "content-type": "application/json",
            });
            response.end("{}");
          });
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, received })));
      }),
      ({ server, received }) =>
        Effect.gen(function* () {
          const address = server.address();
          if (address === null || typeof address === "string") return yield* Effect.die("no port");
          const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-relay-cli-run-"));
          yield* persistServerRuntimeState({
            path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
            state: yield* makePersistedServerRuntimeState({
              config: { host: "127.0.0.1", devUrl: undefined },
              port: address.port,
            }),
          });

          assert.isTrue(yield* storeRelayCredential(Option.some(baseDir), CREDENTIAL));
          yield* runCli(["relay", "logout", "--base-dir", baseDir]);

          assert.deepEqual(
            received.map((request) => request.method),
            ["PUT", "DELETE"],
          );
          assert.deepEqual(JSON.parse(received[0]!.body), CREDENTIAL);
          assert.match(received[0]!.authorization, /^Bearer \S+$/);
          // A running server keeps the credential itself; the CLI leaves no session behind.
          assert.isTrue(Option.isNone(yield* storedCredential(baseDir)));
          yield* runCli(["auth", "session", "list", "--base-dir", baseDir, "--json"]);
          const listed = (yield* TestConsole.logLines).findLast(
            (line): line is string => typeof line === "string",
          );
          assert.notInclude(listed ?? "", "gustaf relay");
        }),
      ({ server }) => Effect.sync(() => server.close()),
    ).pipe(Effect.provide(Layer.mergeAll(layerCliRuntime, TestConsole.layer))),
  );

  it.effect("lists what waits for an answer and answers it by the start of its id", () =>
    Effect.acquireUseRelease(
      Effect.callback<{
        server: NodeHttp.Server;
        received: Array<{ method: string; url: string; authorization: string; body: string }>;
      }>((resume) => {
        const received: Array<{
          method: string;
          url: string;
          authorization: string;
          body: string;
        }> = [];
        const status = {
          connection: "online",
          devices: [],
          pending: [
            {
              id: "5f0c1d2e-aaaa-4bbb-8ccc-0123456789ab",
              name: "Mac",
              requestedAt: "2026-11-25T12:00:00.000Z",
              safetyCode: "ABCD-EFGH",
              peerLink: { access: "auto" },
            },
          ],
        };
        const server = NodeHttp.createServer((request, response) => {
          if (request.url === "/.well-known/t3/environment") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                environmentId: "relay-test",
                label: "relay-test",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.1",
                orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                capabilities: { repositoryIdentity: true },
              }),
            );
            return;
          }
          let body = "";
          request.on("data", (chunk) => (body += chunk));
          request.on("end", () => {
            received.push({
              method: request.method ?? "",
              url: request.url ?? "",
              authorization: request.headers.authorization ?? "",
              body,
            });
            const known =
              request.url === "/api/relay-host" || request.url === "/api/relay-host/decision";
            response.writeHead(known ? 200 : 404, { "content-type": "application/json" });
            response.end(JSON.stringify(known ? status : {}));
          });
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, received })));
      }),
      ({ server, received }) =>
        Effect.gen(function* () {
          const address = server.address();
          if (address === null || typeof address === "string") return yield* Effect.die("no port");
          const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-relay-cli-ask-"));
          yield* persistServerRuntimeState({
            path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
            state: yield* makePersistedServerRuntimeState({
              config: { host: "127.0.0.1", devUrl: undefined },
              port: address.port,
            }),
          });

          yield* runCli(["relay", "requests", "--base-dir", baseDir]);
          const listed = (yield* TestConsole.logLines).findLast(
            (line): line is string => typeof line === "string",
          );
          assert.include(listed ?? "", "5f0c1d2e-aaaa-4bbb-8ccc-0123456789ab");
          assert.include(listed ?? "", "wants to link its agents here (auto)");
          assert.include(listed ?? "", "safety code ABCD-EFGH");

          // The first characters of the id are enough, and a stranger's id answers nothing.
          yield* runCli(["relay", "allow", "5f0c", "--base-dir", baseDir]);
          yield* runCli([
            "relay",
            "deny",
            "5f0c1d2e-aaaa-4bbb-8ccc-0123456789ab",
            "--base-dir",
            baseDir,
          ]);
          const refused = yield* runCli(["relay", "allow", "9999", "--base-dir", baseDir]).pipe(
            Effect.flip,
          );
          assert.include(String(refused), "No single request has that id");
          const decisions = received.filter((request) => request.method === "POST");
          assert.deepEqual(
            decisions.map((request) => JSON.parse(request.body)),
            [
              { id: "5f0c1d2e-aaaa-4bbb-8ccc-0123456789ab", approve: true },
              { id: "5f0c1d2e-aaaa-4bbb-8ccc-0123456789ab", approve: false },
            ],
          );
          assert.match(decisions[0]!.authorization, /^Bearer \S+$/);
        }),
      ({ server }) => Effect.sync(() => server.close()),
    ).pipe(Effect.provide(Layer.mergeAll(layerCliRuntime, TestConsole.layer))),
  );
});
