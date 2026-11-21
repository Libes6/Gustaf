import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ClaudeInstallation from "./ClaudeInstallation.ts";

const VERSION = "2.1.0";
const binary = new TextEncoder().encode(`#!/bin/sh\necho "${VERSION} (Claude Code)"\n`);
const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const makeHarness = Effect.fn("test.makeClaudeInstallation")(function* (
  input: {
    baseDir?: string;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    checksum?: string;
    size?: number;
    body?: Stream.Stream<Uint8Array>;
    localVersion?: string;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir =
    input.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-install-test-" }));
  const localDirectory = `${baseDir}/local`;
  const localBinaryPath = `${localDirectory}/claude`;
  if (input.localVersion) {
    yield* fs.makeDirectory(localDirectory, { recursive: true });
    yield* fs.writeFileString(
      localBinaryPath,
      `#!/bin/sh\necho "${input.localVersion} (Claude Code)"\n`,
      { mode: 0o755 },
    );
  }
  const digest = yield* Digest.Digest;
  const checksum =
    input.checksum ?? Hex.encode(yield* digest.digest(Digest.sha256, binary).pipe(Effect.orDie));
  const requests: Array<string> = [];
  const installation = yield* ClaudeInstallation.makeClaudeInstallation({ baseDir }).pipe(
    Effect.provideService(HostProcess.Platform, input.platform ?? "darwin"),
    Effect.provideService(HostProcess.Architecture, input.arch ?? "arm64"),
    Effect.provideService(HostProcess.Environment, {
      PATH: input.localVersion ? localDirectory : "",
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const url = request.url.slice(ClaudeInstallation.CLAUDE_RELEASES_URL.length);
          requests.push(url);
          if (url === "/latest") return HttpClientResponse.fromWeb(request, new Response(VERSION));
          if (url.endsWith("/manifest.json"))
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  version: VERSION,
                  platforms: {
                    "darwin-arm64": { checksum, size: input.size ?? binary.length },
                  },
                }),
              ),
            );
          return Object.defineProperty(
            HttpClientResponse.fromWeb(request, new Response(null)),
            "stream",
            { value: input.body ?? Stream.succeed(binary) },
          );
        }),
      ),
    ),
  );
  return { installation, fs, baseDir, localBinaryPath, requests };
});

const terminalState = (installation: ClaudeInstallation.ClaudeInstallation["Service"]) =>
  installation.changes.pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect("installs the verified latest release behind a stable link and survives a restart", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.installation.start;
    const target = `${h.baseDir}/tools/claude/versions/${VERSION}/claude`;
    expect(yield* terminalState(h.installation)).toMatchObject({
      phase: "succeeded",
      source: "managed",
      installedVersion: VERSION,
      executablePath: target,
      canRemove: true,
    });
    expect(h.requests).toEqual([
      "/latest",
      `/${VERSION}/manifest.json`,
      `/${VERSION}/darwin-arm64/claude`,
    ]);
    expect(h.installation.executablePath).toBe(`${h.baseDir}/tools/claude/bin/claude`);
    expect(yield* h.fs.realPath(h.installation.executablePath)).toBe(yield* h.fs.realPath(target));
    const restarted = yield* makeHarness({ baseDir: h.baseDir });
    expect(yield* restarted.installation.state).toMatchObject({
      phase: "idle",
      source: "managed",
      installedVersion: VERSION,
      canRemove: true,
    });
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect.each([
  { name: "checksum mismatch", options: { checksum: "0".repeat(64) }, message: "SHA-256" },
  { name: "size overrun", options: { size: 8 }, message: "exceeded the expected release size" },
])("rejects a download with a $name without publishing it", ({ options, message }) =>
  Effect.gen(function* () {
    const h = yield* makeHarness(options);
    yield* h.installation.start;
    const state = yield* terminalState(h.installation);
    expect(state.phase).toBe("failed");
    expect(state.message).toContain(message);
    expect(yield* h.fs.exists(h.installation.executablePath)).toBe(false);
    expect(yield* h.fs.exists(`${h.installation.managedDirectory}/versions`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect.each([
  { platform: "win32", arch: "x64" },
  { platform: "linux", arch: "ia32" },
] as const)("refuses an unsupported $platform-$arch host before downloading", (host) =>
  Effect.gen(function* () {
    const h = yield* makeHarness(host);
    const error = yield* Effect.flip(h.installation.start);
    expect(error.detail).toContain(`for ${host.platform}-${host.arch}`);
    expect(h.requests).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("cancels an in-flight download and cleans the staging directory", () =>
  Effect.gen(function* () {
    const downloading = yield* Deferred.make<void>();
    const h = yield* makeHarness({
      body: Stream.fromEffect(
        Deferred.succeed(downloading, undefined).pipe(Effect.andThen(Effect.never)),
      ),
    });
    const started = yield* h.installation.start;
    yield* Deferred.await(downloading);
    expect((yield* h.installation.cancel(started.operationId!)).phase).toBe("cancelled");
    expect(yield* h.fs.readDirectory(h.installation.managedDirectory)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("refuses to remove a runtime that an instance path points into", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.installation.start;
    yield* terminalState(h.installation);
    const error = yield* Effect.flip(h.installation.remove([h.installation.executablePath]));
    expect(error.detail).toContain("custom path inside managed Claude");
    expect(yield* h.fs.exists(h.installation.executablePath)).toBe(true);
    yield* h.installation.remove(["claude"]);
    expect(yield* h.fs.exists(h.installation.managedDirectory)).toBe(false);
    expect(yield* h.installation.state).toMatchObject({
      phase: "idle",
      installedVersion: null,
      canRemove: false,
    });
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("links Claude from PATH on first setup and downloads on reinstall after restart", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ localVersion: "2.0.9" });
    expect(yield* h.installation.start).toMatchObject({
      phase: "succeeded",
      source: "local",
      installedVersion: "2.0.9",
      executablePath: h.localBinaryPath,
    });
    expect(h.requests).toEqual([]);
    expect(yield* h.fs.realPath(h.installation.executablePath)).toBe(
      yield* h.fs.realPath(h.localBinaryPath),
    );
    const restarted = yield* makeHarness({ baseDir: h.baseDir, localVersion: "2.0.9" });
    yield* restarted.installation.start;
    expect(yield* terminalState(restarted.installation)).toMatchObject({
      phase: "succeeded",
      source: "managed",
      installedVersion: VERSION,
    });
    expect(restarted.requests).toEqual([
      "/latest",
      `/${VERSION}/manifest.json`,
      `/${VERSION}/darwin-arm64/claude`,
    ]);
    yield* restarted.installation.remove();
    expect(yield* h.fs.exists(h.localBinaryPath)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(services)),
);
