import { assert, describe, it } from "@effect/vitest";
import { SshHttpBridgeError } from "@t3tools/ssh/errors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import {
  DesktopSshEnvironmentRequestError,
  ensureSshEnvironment,
  fetchSshEnvironmentDescriptor,
} from "./sshEnvironment.ts";

function jsonResponse(request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function layerHttpClient(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, never>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

describe("SSH environment IPC", () => {
  it.effect("rejects non-loopback HTTP endpoints before issuing a request", () => {
    let requestCount = 0;
    const layer = layerHttpClient((request) =>
      Effect.sync(() => {
        requestCount += 1;
        return jsonResponse(request, {});
      }),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        fetchSshEnvironmentDescriptor.handler({
          httpBaseUrl: "http://remote.example.com:41773/",
        }),
      );
      assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      const error = failure.value;

      assert.instanceOf(error, DesktopSshEnvironmentRequestError);
      assert.instanceOf(error.cause, SshHttpBridgeError);
      assert.equal(requestCount, 0);
    }).pipe(Effect.provide(layer));
  });

  describe("ensureSshEnvironment progress", () => {
    const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
    const bootstrap = {
      target,
      httpBaseUrl: "http://127.0.0.1:41773/",
      wsBaseUrl: "ws://127.0.0.1:41773/",
      pairingToken: null,
    };

    const run = (options: { readonly progressRequestId?: string }) => {
      const sent: Array<{ readonly channel: string; readonly args: ReadonlyArray<unknown> }> = [];
      let receivedOptions: unknown;
      return Effect.gen(function* () {
        yield* ensureSshEnvironment.handler({ target, options });
        return { sent, receivedOptions };
      }).pipe(
        Effect.provideService(ElectronWindow.ElectronWindow, {
          sendAll: (channel: string, ...args: ReadonlyArray<unknown>) =>
            Effect.sync(() => {
              sent.push({ channel, args });
            }),
        } as unknown as ElectronWindow.ElectronWindow["Service"]),
        Effect.provideService(DesktopSshEnvironment.DesktopSshEnvironment, {
          ensureEnvironment: (_target: unknown, ensureOptions?: Record<string, unknown>) =>
            Effect.sync(() => {
              receivedOptions = ensureOptions;
              const onProgress = ensureOptions?.onProgress as
                | ((event: { step: string; status: string; at: number }) => void)
                | undefined;
              onProgress?.({ step: "connect", status: "running", at: 1 });
              onProgress?.({ step: "connect", status: "done", at: 2 });
              return bootstrap;
            }),
        } as unknown as DesktopSshEnvironment.DesktopSshEnvironment["Service"]),
      );
    };

    it.effect("tags each event with the caller's request id", () =>
      Effect.gen(function* () {
        const { sent } = yield* run({ progressRequestId: "add-7" });
        assert.deepStrictEqual(
          sent.map((message) => [message.channel, message.args]),
          [
            [
              IpcChannels.SSH_ENSURE_PROGRESS_CHANNEL,
              [{ requestId: "add-7", step: "connect", status: "running", at: 1 }],
            ],
            [
              IpcChannels.SSH_ENSURE_PROGRESS_CHANNEL,
              [{ requestId: "add-7", step: "connect", status: "done", at: 2 }],
            ],
          ],
        );
      }),
    );

    it.effect("sends nothing without a request id", () =>
      Effect.gen(function* () {
        const { sent, receivedOptions } = yield* run({});
        assert.deepStrictEqual(sent, []);
        assert.notProperty(receivedOptions as object, "onProgress");
      }),
    );
  });
});
