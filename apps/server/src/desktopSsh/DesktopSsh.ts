// @effect-diagnostics globalDateInEffect:off -- Prompt expiry is sent to the native client as a wall-clock deadline.
import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
} from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  DesktopSshEnvironmentEnsureInputSchema,
  DesktopSshEnvironmentTargetSchema,
  DesktopSshBearerBootstrapInputSchema,
  DesktopSshBearerRequestInputSchema,
  DesktopSshHttpBaseUrlInputSchema,
  DesktopSshPasswordPromptResolutionInputSchema,
  type DesktopSshPasswordPromptRequest,
} from "@t3tools/contracts";
import * as SshAuth from "@t3tools/ssh/auth";
import { resolveSshTarget, targetConnectionKey } from "@t3tools/ssh/command";
import { discoverSshHosts } from "@t3tools/ssh/config";
import { SshHttpBridgeError, SshPasswordPromptError } from "@t3tools/ssh/errors";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";
import * as NetService from "@t3tools/shared/Net";
import type * as Digest from "effect/crypto/Digest";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as HttpClient from "effect/http/HttpClient";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const Request = Schema.Union([
  Schema.Struct({ method: Schema.Literal("discover") }),
  Schema.Struct({ method: Schema.Literal("resolve"), input: Schema.String }),
  Schema.Struct({
    method: Schema.Literal("ensure"),
    input: DesktopSshEnvironmentEnsureInputSchema,
  }),
  Schema.Struct({ method: Schema.Literal("disconnect"), input: DesktopSshEnvironmentTargetSchema }),
  Schema.Struct({ method: Schema.Literal("descriptor"), input: DesktopSshHttpBaseUrlInputSchema }),
  Schema.Struct({
    method: Schema.Literal("bootstrap"),
    input: DesktopSshBearerBootstrapInputSchema,
  }),
  Schema.Struct({ method: Schema.Literal("session"), input: DesktopSshBearerRequestInputSchema }),
  Schema.Struct({
    method: Schema.Literal("resolve-password"),
    input: DesktopSshPasswordPromptResolutionInputSchema,
  }),
]);

/** Remote hosts run upstream t3 archives, so they follow the runtime's version, not the Gustaf app's. */
export const cliRunner = (
  runtimeVersion: string,
  env: Readonly<Record<string, string | undefined>>,
): SshTunnel.RemoteT3RunnerOptions => ({
  installedCommand: "gustaf",
  archiveVersion: runtimeVersion,
  releaseBaseUrl: env[CLI_RELEASE_BASE_URL_ENV]?.trim() || null,
});

export class DesktopSsh extends Context.Service<
  DesktopSsh,
  {
    readonly execute: (
      request: typeof Request.Type,
      locale: string,
    ) => Effect.Effect<unknown, SshHttpBridgeError>;
  }
>()("t3/desktopSsh/DesktopSsh") {}

const cancelled = (locale: string) => ({
  type: "ssh-password-prompt-cancelled" as const,
  message: locale.startsWith("ru")
    ? "SSH authentication cancelled / Подключение SSH отменено."
    : "SSH authentication cancelled.",
});

export const layer = (present: (request: DesktopSshPasswordPromptRequest) => void) =>
  Layer.effect(
    DesktopSsh,
    Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const services = yield* Effect.context<
        | ChildProcessSpawner.ChildProcessSpawner
        | Digest.Digest
        | FileSystem.FileSystem
        | Path.Path
        | HttpClient.HttpClient
        | NetService.NetService
      >();
      const prompts = new Map<string, Deferred.Deferred<string | null>>();
      const origins = new Map<string, string>();
      const random = yield* SecureRandom.SecureRandom;

      const execute = Effect.fn("DesktopSsh.execute")(
        function* (request: typeof Request.Type, locale: string) {
          const russian = locale.startsWith("ru");
          const passwordPrompt = SshAuth.SshPasswordPrompt.of({
            isAvailable: true,
            request: Effect.fn("DesktopSsh.password")(function* (input) {
              const response = yield* Deferred.make<string | null>();
              const requestId = yield* random.uuidV4().pipe(
                Effect.mapError(
                  (cause) =>
                    new SshPasswordPromptError({
                      message: "Cannot create SSH prompt / Не удалось создать запрос пароля SSH.",
                      cause,
                    }),
                ),
              );
              prompts.set(requestId, response);
              yield* Effect.sync(() =>
                present({
                  requestId,
                  destination: input.destination,
                  username: input.username,
                  prompt: russian
                    ? `Введите пароль SSH или код подтверждения для ${input.destination}.`
                    : input.prompt,
                  expiresAt: new Date(Date.now() + 120_000).toISOString(),
                }),
              );
              return yield* Deferred.await(response).pipe(
                Effect.timeoutOrElse({ duration: "2 minutes", orElse: () => Effect.succeed(null) }),
                Effect.ensuring(Effect.sync(() => prompts.delete(requestId))),
              );
            }),
          });

          switch (request.method) {
            case "discover":
              return yield* discoverSshHosts({});
            case "resolve":
              return yield* resolveSshTarget(request.input.trim());
            case "resolve-password": {
              const response = prompts.get(request.input.requestId);
              if (response) yield* Deferred.succeed(response, request.input.password);
              return null;
            }
            case "ensure": {
              const resolved = yield* resolveSshTarget(
                request.input.target.alias || request.input.target.hostname,
              );
              const target = {
                ...resolved,
                username: request.input.target.username ?? resolved.username,
                port: request.input.target.port ?? resolved.port,
              };
              origins.delete(targetConnectionKey(target));
              return yield* manager.ensureEnvironment(target, request.input.options).pipe(
                Effect.tap((result) =>
                  Effect.sync(() =>
                    origins.set(targetConnectionKey(result.target), result.httpBaseUrl),
                  ),
                ),
                Effect.catchIf(Schema.is(SshPasswordPromptError), (error) =>
                  /cancelled/.test(error.message)
                    ? Effect.succeed(cancelled(locale))
                    : Effect.fail(error),
                ),
                Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
              );
            }
            case "disconnect": {
              const resolved = yield* resolveSshTarget(
                request.input.alias || request.input.hostname,
              );
              const target = {
                ...resolved,
                username: request.input.username ?? resolved.username,
                port: request.input.port ?? resolved.port,
              };
              yield* manager
                .disconnectEnvironment(target)
                .pipe(
                  Effect.ensuring(Effect.sync(() => origins.delete(targetConnectionKey(target)))),
                  Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
                );
              return null;
            }
            case "descriptor":
            case "bootstrap":
            case "session": {
              const httpBaseUrl = yield* SshTunnel.resolveLoopbackSshHttpBaseUrl(
                request.input.httpBaseUrl,
              );
              if (![...origins.values()].includes(httpBaseUrl)) {
                return yield* new SshHttpBridgeError({
                  message: "SSH tunnel is not connected / Туннель SSH не подключён.",
                });
              }
              switch (request.method) {
                case "descriptor":
                  return yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl });
                case "bootstrap":
                  return yield* bootstrapRemoteBearerSession({
                    httpBaseUrl,
                    credential: request.input.credential,
                  });
                case "session":
                  return yield* fetchRemoteSessionState({
                    httpBaseUrl,
                    bearerToken: request.input.bearerToken,
                  });
              }
            }
          }
        },
        Effect.provide(services),
        Effect.mapError((cause) => {
          let status =
            "status" in cause && typeof cause.status === "number" ? cause.status : undefined;
          switch (cause._tag) {
            case "EnvironmentRequestInvalidError":
              status = 400;
              break;
            case "EnvironmentAuthInvalidError":
              status = 401;
              break;
            case "EnvironmentScopeRequiredError":
            case "EnvironmentOperationForbiddenError":
              status = 403;
              break;
            case "EnvironmentInternalError":
              status = 500;
              break;
          }
          return new SshHttpBridgeError({
            message: cause instanceof Error ? cause.message : String(cause),
            ...(status === undefined ? {} : { status }),
          });
        }),
      );
      return DesktopSsh.of({ execute });
    }),
  );
