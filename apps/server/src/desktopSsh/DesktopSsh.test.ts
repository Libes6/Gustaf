import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type {
  DesktopSshEnvironmentBootstrap,
  DesktopSshPasswordPromptRequest,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopSsh from "./DesktopSsh.ts";

const target = { alias: "devbox", hostname: "box.example", username: "dev", port: 2222 } as const;

function processOutput(stdout: string, stderr = "", code = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.make(new TextEncoder().encode(stdout)),
    stderr: Stream.make(new TextEncoder().encode(stderr)),
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function fixture(
  options: {
    present?: (request: DesktopSshPasswordPromptRequest) => void;
    requirePassword?: boolean;
    tokenFailure?: boolean;
  } = {},
) {
  let tunnels = 0;
  let killed = 0;
  let nextPort = 41_773;
  const commands: Array<ReadonlyArray<string>> = [];
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const args = command._tag === "StandardCommand" ? command.args.map(String) : [];
      commands.push(args);
      if (args.includes("-G")) return processOutput("hostname box.example\nuser dev\nport 2222\n");
      if (
        options.requirePassword === true &&
        !(
          command._tag === "StandardCommand" &&
          command.options.env?.T3_SSH_AUTH_SECRET === "test-password"
        )
      )
        return processOutput("", "Permission denied (publickey,password)", 255);
      if (args.includes("-N")) {
        tunnels++;
        return {
          ...processOutput(""),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () =>
            Effect.sync(() => {
              killed++;
            }),
        };
      }
      return processOutput('{"remotePort":3773,"serverKind":"managed","credential":"pairing"}\n');
    }),
  );
  const http = HttpClient.make((request) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    let body: unknown = {};
    if (request.url.endsWith("/oauth/token")) {
      body = {
        access_token: "access",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "orchestration:read",
      };
    } else if (request.url.endsWith("/.well-known/t3/environment")) {
      body = {
        environmentId: "remote-env",
        label: "Remote Gustaf",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.9.0",
        capabilities: {},
      };
    } else if (request.url.endsWith("/api/auth/session")) {
      body = {
        authenticated: true,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["bearer-access-token"],
          sessionCookieName: "gustaf_session",
        },
        permissions: ["orchestration:read"],
      };
    }
    const tokenFailure = options.tokenFailure && request.url.endsWith("/oauth/token");
    if (tokenFailure)
      body = {
        _tag: "EnvironmentInternalError",
        code: "internal_error",
        reason: "internal_error",
        traceId: "trace-test",
      };
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status: tokenFailure ? 500 : 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
  const runtime = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(
      NetService.NetService,
      NetService.NetService.of({
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        hasListenerOnHost: () => Effect.succeed(false),
        reserveLoopbackPort: () => Effect.sync(() => nextPort++),
        findAvailablePort: (preferred) => Effect.succeed(preferred),
      }),
    ),
  );
  const layer = DesktopSsh.layer(options.present ?? (() => {})).pipe(
    Layer.provide(
      SshTunnel.SshEnvironmentManager.layer({
        resolveCliRunner: Effect.succeed({
          archiveVersion: "1.2.3",
          releaseBaseUrl: "https://example.invalid/releases/download",
        }),
      }),
    ),
    Layer.provide(runtime),
  );
  return { layer, commands, requests, tunnels: () => tunnels, killed: () => killed };
}

describe("Tauri SSH session", () => {
  it.effect(
    "reuses a tunnel, separates ports and aliases, reconnects after disconnect and releases owned tunnels",
    () =>
      Effect.gen(function* () {
        const test = fixture();
        yield* Effect.gen(function* () {
          const session = yield* DesktopSsh.DesktopSsh;
          const ensure = (port: number, alias = "devbox") =>
            session.execute(
              {
                method: "ensure",
                input: { target: { ...target, port, alias }, options: { issuePairingToken: true } },
              },
              "en",
            );
          const first = (yield* ensure(2222)) as DesktopSshEnvironmentBootstrap;
          assert.equal(first.pairingToken, "pairing");
          assert.deepEqual(yield* ensure(2222), first);
          yield* ensure(2223);
          yield* ensure(2222, "other-alias");
          assert.equal(test.tunnels(), 3);
          assert.isTrue(test.commands.some((args) => args.includes("2223")));
          yield* session.execute({ method: "disconnect", input: target }, "en");
          assert.equal(test.killed(), 1);
          const blocked = yield* Effect.result(
            session.execute(
              {
                method: "session",
                input: { httpBaseUrl: first.httpBaseUrl, bearerToken: "secret" },
              },
              "ru",
            ),
          );
          assert.isTrue(Result.isFailure(blocked));
          const again = (yield* ensure(2222)) as DesktopSshEnvironmentBootstrap;
          assert.notEqual(again.httpBaseUrl, first.httpBaseUrl);
          yield* session.execute(
            {
              method: "bootstrap",
              input: { httpBaseUrl: again.httpBaseUrl, credential: "pairing" },
            },
            "en",
          );
          assert.isTrue(test.requests.some((request) => request.url.endsWith("/oauth/token")));
          yield* session.execute(
            { method: "descriptor", input: { httpBaseUrl: again.httpBaseUrl } },
            "en",
          );
          yield* session.execute(
            { method: "session", input: { httpBaseUrl: again.httpBaseUrl, bearerToken: "access" } },
            "en",
          );
          assert.deepEqual(test.requests.at(-1), {
            url: `${again.httpBaseUrl}api/auth/session`,
            authorization: "Bearer access",
          });
        }).pipe(Effect.provide(test.layer), Effect.scoped);
        assert.equal(test.killed(), test.tunnels());
      }),
  );

  it.effect.each([
    { locale: "ru", action: "cancel" },
    { locale: "en", action: "cancel" },
    { locale: "ru", action: "password" },
    { locale: "en", action: "timeout" },
  ] as const)("handles password $action in $locale", ({ locale, action }) =>
    Effect.gen(function* () {
      const shown = yield* Deferred.make<DesktopSshPasswordPromptRequest>();
      const test = fixture({
        requirePassword: true,
        present: (request) => {
          Deferred.doneUnsafe(shown, Effect.succeed(request));
        },
      });
      yield* Effect.gen(function* () {
        const session = yield* DesktopSsh.DesktopSsh;
        const pending = yield* session
          .execute(
            { method: "ensure", input: { target, options: { issuePairingToken: true } } },
            locale,
          )
          .pipe(Effect.forkChild);
        const prompt = yield* Deferred.await(shown);
        assert.equal(prompt.destination, "devbox");
        assert.include(
          prompt.prompt,
          locale === "ru" ? "Введите пароль" : "Enter the SSH password",
        );
        yield* session.execute(
          { method: "resolve-password", input: { requestId: "stale-id", password: "ignored" } },
          locale,
        );
        if (action === "timeout") {
          yield* TestClock.adjust("2 minutes");
        } else {
          yield* session.execute(
            {
              method: "resolve-password",
              input: {
                requestId: prompt.requestId,
                password: action === "password" ? "test-password" : null,
              },
            },
            locale,
          );
        }
        const result = yield* Fiber.join(pending);
        if (action === "password") {
          assert.equal((result as DesktopSshEnvironmentBootstrap).pairingToken, "pairing");
          return;
        }
        assert.deepEqual(result, {
          type: "ssh-password-prompt-cancelled",
          message:
            locale === "ru"
              ? "SSH authentication cancelled / Подключение SSH отменено."
              : "SSH authentication cancelled.",
        });
        assert.equal(test.tunnels(), 0);
        assert.equal(test.killed(), 0);
      }).pipe(Effect.provide(test.layer), Effect.scoped);
    }),
  );

  it.effect(
    "preserves declared remote HTTP status for version-skew and authentication errors",
    () =>
      Effect.gen(function* () {
        const test = fixture({ tokenFailure: true });
        yield* Effect.gen(function* () {
          const session = yield* DesktopSsh.DesktopSsh;
          const bootstrap = (yield* session.execute(
            { method: "ensure", input: { target } },
            "en",
          )) as DesktopSshEnvironmentBootstrap;
          const result = yield* Effect.result(
            session.execute(
              {
                method: "bootstrap",
                input: { httpBaseUrl: bootstrap.httpBaseUrl, credential: "pairing" },
              },
              "en",
            ),
          );
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) assert.equal(result.failure.status, 500);
        }).pipe(Effect.provide(test.layer), Effect.scoped);
      }),
  );

  it.effect("rejects non-owned HTTP endpoints before sending credentials", () =>
    Effect.gen(function* () {
      const test = fixture();
      yield* Effect.gen(function* () {
        const session = yield* DesktopSsh.DesktopSsh;
        for (const httpBaseUrl of [
          "http://127.0.0.1:9999/",
          "https://remote.example/",
          "file:///tmp/private",
        ]) {
          const result = yield* Effect.result(
            session.execute(
              { method: "bootstrap", input: { httpBaseUrl, credential: "secret" } },
              "en",
            ),
          );
          assert.isTrue(Result.isFailure(result));
        }
        assert.equal(test.requests.length, 0);
      }).pipe(Effect.provide(test.layer), Effect.scoped);
    }),
  );

  it("downloads remote runtimes from upstream t3 releases at the runtime version", () => {
    assert.deepStrictEqual(DesktopSsh.cliRunner("0.1.7", { GUSTAF_APP_VERSION: "0.12.0" }), {
      installedCommand: "gustaf",
      archiveVersion: "0.1.7",
      releaseBaseUrl: null,
    });
    assert.strictEqual(
      DesktopSsh.cliRunner("0.1.7", { T3CODE_RELEASE_BASE_URL: " https://mirror.example/dl " })
        .releaseBaseUrl,
      "https://mirror.example/dl",
    );
  });
});
