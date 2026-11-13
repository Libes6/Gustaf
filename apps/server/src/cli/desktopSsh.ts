// @effect-diagnostics nodeBuiltinImport:off -- Private stdio entry point owned by the Tauri shell.
import * as NodeReadline from "node:readline";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NetService from "@t3tools/shared/Net";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as DesktopSsh from "../desktopSsh/DesktopSsh.ts";
import packageJson from "../../package.json" with { type: "json" };

const Envelope = Schema.Struct({
  id: Schema.Number,
  locale: Schema.String,
  request: DesktopSsh.Request,
});

class DesktopSshInputError extends Schema.TaggedError<
  DesktopSshInputError,
  { readonly brand: unique symbol }
>()("DesktopSshInputError", { cause: Schema.Defect() }) {}

const decodeEnvelope = Schema.decodeEffect(Schema.fromJsonString(Envelope));

export async function runDesktopSsh() {
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const lines = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const runtime = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    NetService.layer,
    NodeHttpClient.layerNodeHttp,
    // stdout carries protocol frames, including while SSH services are constructed.
    Logger.layer([], { mergeWithExisting: false }),
  );
  const session = DesktopSsh.layer((prompt) => send({ prompt })).pipe(
    Layer.provide(
      SshTunnel.SshEnvironmentManager.layer({
        resolveCliRunner: Effect.succeed({
          installedCommand: "gustaf",
          archiveVersion: process.argv[3] || packageJson.version,
          releaseBaseUrl: "https://github.com/Libes6/Gustaf/releases/download",
        }),
      }),
    ),
    Layer.provide(runtime),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ssh = yield* DesktopSsh.DesktopSsh;
        yield* Stream.fromAsyncIterable(lines, (cause) => new DesktopSshInputError({ cause })).pipe(
          Stream.runForEach((line) =>
            Effect.gen(function* () {
              const envelope = yield* decodeEnvelope(line);
              yield* ssh.execute(envelope.request, envelope.locale).pipe(
                Effect.matchCauseEffect({
                  onSuccess: (result) =>
                    Effect.sync(() => send({ id: envelope.id, result: result ?? null })),
                  onFailure: (cause) =>
                    Effect.sync(() => {
                      const error = Cause.squash(cause);
                      const message = error instanceof Error ? error.message : String(error);
                      const prefix = envelope.locale.startsWith("ru") ? "Ошибка SSH" : "SSH failed";
                      const status =
                        typeof error === "object" &&
                        error !== null &&
                        "status" in error &&
                        typeof error.status === "number"
                          ? `[ssh_http:${error.status}] `
                          : "";
                      send({ id: envelope.id, error: `${status}${prefix}: ${message}` });
                    }),
                }),
                Effect.forkScoped,
              );
            }),
          ),
        );
      }),
    ).pipe(Effect.provide(session)),
  );
}
