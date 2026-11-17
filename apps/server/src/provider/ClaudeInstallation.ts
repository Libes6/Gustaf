// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import { ProviderDriverKind, type ProviderInstallState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeCrypto from "node:crypto";
import * as ServerConfig from "../config.ts";

const DRIVER = ProviderDriverKind.make("claudeAgent");
export const CLAUDE_RELEASES_URL = "https://downloads.claude.ai/claude-code-releases";
const STAGING_STALE_AFTER_MS = 24 * 60 * 60_000;
const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/u));
const ActiveRelease = Schema.Struct({ version: Version });
const ReleaseManifest = Schema.Struct({
  platforms: Schema.Record(
    Schema.String,
    Schema.Struct({
      checksum: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
      size: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
});
const decodeVersion = Schema.decodeUnknownEffect(Version);
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseManifest));
const decodeActive = Schema.decodeUnknownEffect(Schema.fromJsonString(ActiveRelease));
const encodeActive = Schema.encodeEffect(Schema.fromJsonString(ActiveRelease));

/** The stable path a managed Claude instance runs; it links to the active executable. */
export const managedClaudeExecutablePath = (path: Path.Path, baseDir: string) =>
  path.join(baseDir, "tools", "claude", "bin", "claude");

export class ClaudeInstallationError extends Schema.TaggedError<ClaudeInstallationError>()(
  "ClaudeInstallationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}
const isInstallationError = Schema.is(ClaudeInstallationError);
const installationError = (operation: string, detail: string, cause?: unknown) =>
  new ClaudeInstallationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });
const wrapFailure = (operation: string, detail: string) => (cause: unknown) =>
  isInstallationError(cause) ? cause : installationError(operation, detail, cause);

export class ClaudeInstallation extends Context.Service<
  ClaudeInstallation,
  {
    readonly managedDirectory: string;
    readonly executablePath: string;
    readonly start: Effect.Effect<ProviderInstallState, ClaudeInstallationError>;
    readonly cancel: (
      operationId: string,
    ) => Effect.Effect<ProviderInstallState, ClaudeInstallationError>;
    readonly state: Effect.Effect<ProviderInstallState>;
    readonly changes: Stream.Stream<ProviderInstallState>;
    readonly remove: (
      protectedBinaryPaths?: ReadonlyArray<string>,
    ) => Effect.Effect<void, ClaudeInstallationError>;
  }
>()("t3/provider/ClaudeInstallation") {
  static readonly layer = Layer.effect(
    ClaudeInstallation,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return yield* makeClaudeInstallation({ baseDir: config.baseDir });
    }),
  );
}

const isRunning = (state: ProviderInstallState) =>
  ["downloading", "extracting", "verifying"].includes(state.phase);

export const makeClaudeInstallation = Effect.fn("makeClaudeInstallation")(function* (options: {
  readonly baseDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const managedDirectory = path.join(options.baseDir, "tools", "claude");
  const versionsDirectory = path.join(managedDirectory, "versions");
  const activePath = path.join(managedDirectory, "active.json");
  const executablePath = managedClaudeExecutablePath(path, options.baseDir);
  const gate = yield* Semaphore.make(1);
  let running: { readonly operationId: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: DRIVER,
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: null,
    version: null,
    installedVersion: null,
    executablePath: null,
    source: null,
    canRemove: false,
    message: null,
  });

  const releasePlatform = Effect.fn("ClaudeInstallation.releasePlatform")(function* () {
    const cpu = arch === "x64" || arch === "arm64" ? arch : null;
    if ((platform !== "darwin" && platform !== "linux") || cpu === null)
      return yield* installationError(
        "start",
        `Anthropic does not publish a Claude Code runtime for ${platform}-${arch}. Install Claude yourself and set its binary path.`,
      );
    if (platform === "darwin") return `darwin-${cpu}`;
    const musl = yield* fs
      .exists(`/lib/libc.musl-${cpu === "x64" ? "x86_64" : "aarch64"}.so.1`)
      .pipe(Effect.orElseSucceed(() => false));
    return `linux-${cpu}${musl ? "-musl" : ""}`;
  });

  const fetchText = (url: string) =>
    http.execute(HttpClientRequest.get(url)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.timeout("30 seconds"),
    );

  const runVersion = Effect.fn("ClaudeInstallation.runVersion")(
    function* (executable: string) {
      const resolved = yield* resolveSpawnCommand(executable, ["--version"]).pipe(
        Effect.provideService(HostProcess.Platform, platform),
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, { shell: resolved.shell }),
      );
      const [output, , exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      const version = /^(\d+\.\d+\.\d+)\b/u.exec(output.trim())?.[1];
      if (exitCode !== 0 || version === undefined)
        return yield* installationError("verify", "The Claude executable could not start.");
      return version;
    },
    Effect.scoped,
    Effect.timeout("90 seconds"),
    Effect.mapError(wrapFailure("verify", "The Claude executable could not start.")),
  );

  const activate = Effect.fn("ClaudeInstallation.activate")(
    function* (target: string, version: string, source: "managed" | "local") {
      yield* fs.makeDirectory(path.dirname(executablePath), { recursive: true });
      const temporary = yield* fs.makeTempDirectoryScoped({
        directory: managedDirectory,
        prefix: ".active-",
      });
      const pointer = path.join(temporary, "active.json");
      yield* fs.writeFileString(pointer, yield* encodeActive({ version }), {
        mode: 0o600,
        flag: "wx",
      });
      yield* fs.rename(pointer, activePath);
      // Instances run the stable link, so swapping it switches them without a rebuild.
      const link = path.join(temporary, "claude");
      yield* fs.symlink(target, link);
      yield* fs.rename(link, executablePath);
      yield* SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "succeeded",
            source,
            installedVersion: version,
            executablePath: target,
            canRemove: true,
            message: null,
          }) satisfies ProviderInstallState,
      );
    },
    Effect.scoped,
    Effect.uninterruptible,
  );

  const reuseLocal = Effect.fn("ClaudeInstallation.reuseLocal")(
    function* () {
      const local = yield* resolveCommandPath("claude", { env: environment }).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      if (local === null) return false;
      const realLocal = yield* fs.realPath(local);
      const realManaged = yield* fs.realPath(managedDirectory).pipe(Effect.option);
      if (
        realLocal.startsWith(`${Option.getOrElse(realManaged, () => managedDirectory)}${path.sep}`)
      )
        return false;
      const version = yield* runVersion(local);
      yield* fs.makeDirectory(managedDirectory, { recursive: true });
      yield* activate(local, version, "local");
      return true;
    },
    Effect.orElseSucceed(() => false),
  );

  const install = Effect.fn("ClaudeInstallation.install")(
    function* (releasePlatformName: string) {
      const version = yield* fetchText(`${CLAUDE_RELEASES_URL}/latest`).pipe(
        Effect.map((text) => text.trim()),
        Effect.flatMap(decodeVersion),
      );
      const manifest = yield* fetchText(`${CLAUDE_RELEASES_URL}/${version}/manifest.json`).pipe(
        Effect.flatMap(decodeManifest),
      );
      const release = manifest.platforms[releasePlatformName];
      if (release === undefined)
        return yield* installationError(
          "download",
          `Claude Code ${version} has no build for ${releasePlatformName}.`,
        );
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        version,
        totalBytes: release.size,
      }));
      yield* fs.makeDirectory(managedDirectory, { recursive: true });
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: managedDirectory,
        prefix: ".install-",
      });
      const download = path.join(staging, "claude");
      const hash = NodeCrypto.createHash("sha256");
      let downloadedBytes = 0;
      let lastProgressAt = yield* Clock.currentTimeMillis;
      const response = yield* http
        .execute(
          HttpClientRequest.get(`${CLAUDE_RELEASES_URL}/${version}/${releasePlatformName}/claude`),
        )
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            downloadedBytes += chunk.byteLength;
            if (downloadedBytes > release.size)
              return yield* installationError(
                "download",
                "The Claude download exceeded the expected release size.",
              );
            hash.update(chunk);
            const now = yield* Clock.currentTimeMillis;
            if (now - lastProgressAt >= 250 || downloadedBytes === release.size) {
              lastProgressAt = now;
              yield* SubscriptionRef.update(state, (current) => ({ ...current, downloadedBytes }));
            }
          }),
        ),
        Stream.run(fs.sink(download, { flag: "wx", mode: 0o600 })),
        Effect.timeout("45 minutes"),
        Effect.catchTags({
          TimeoutError: (cause) =>
            installationError(
              "download",
              "The Claude download timed out. Retry installation.",
              cause,
            ),
        }),
      );
      if (downloadedBytes !== release.size || hash.digest("hex") !== release.checksum)
        return yield* installationError(
          "download",
          "The Claude download failed its size or SHA-256 check. Nothing was installed.",
        );
      yield* SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "verifying",
            message: "Checking Claude.",
          }) satisfies ProviderInstallState,
      );
      yield* fs.chmod(download, 0o755);
      if ((yield* runVersion(download)) !== version)
        return yield* installationError(
          "verify",
          "The downloaded Claude executable has the wrong version.",
        );
      const destination = path.join(versionsDirectory, version);
      yield* fs.makeDirectory(destination, { recursive: true });
      const target = path.join(destination, "claude");
      yield* fs.rename(download, target);
      yield* activate(target, version, "managed");
      const versions = yield* fs.readDirectory(versionsDirectory);
      yield* Effect.forEach(
        versions.filter((entry) => entry !== version),
        (entry) => fs.remove(path.join(versionsDirectory, entry), { recursive: true, force: true }),
        { discard: true },
      ).pipe(Effect.ignore);
    },
    Effect.scoped,
    Effect.catchTags({
      HttpClientError: (cause) => {
        const httpStatus =
          cause.reason._tag === "StatusCodeError" ? cause.reason.response.status : undefined;
        return installationError(
          "download",
          httpStatus === undefined
            ? "The Claude download was interrupted. Check your internet connection, then retry installation."
            : `The Claude download server returned HTTP ${httpStatus}. Try again later.`,
          cause,
        );
      },
      TimeoutError: (cause) =>
        installationError(
          "download",
          "The Claude release server did not answer. Check your internet connection, then retry installation.",
          cause,
        ),
      SchemaError: (cause) =>
        installationError(
          "download",
          "The Claude release server returned an unexpected answer. Try again later.",
          cause,
        ),
    }),
    Effect.mapError(
      wrapFailure(
        "install",
        "Could not install Claude. Check disk space and directory access, then try again.",
      ),
    ),
  );

  const start = gate
    .withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (isRunning(current)) return current;
        const releasePlatformName = yield* releasePlatform();
        if (current.source !== "managed" && (yield* reuseLocal()))
          return yield* SubscriptionRef.get(state);
        const operationId = yield* random.uuidV4();
        const next: ProviderInstallState = {
          ...current,
          operationId,
          phase: "downloading",
          downloadedBytes: 0,
          totalBytes: null,
          message: "Downloading Claude.",
        };
        yield* SubscriptionRef.set(state, next);
        const work = install(releasePlatformName).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? SubscriptionRef.update(state, (value) => {
                  if (value.operationId !== operationId || value.phase === "succeeded")
                    return value;
                  const error = Cause.findErrorOption(exit.cause);
                  const cancelled = Cause.hasInterruptsOnly(exit.cause);
                  return {
                    ...value,
                    phase: cancelled ? "cancelled" : "failed",
                    message: cancelled
                      ? "Installation cancelled. The previous runtime is unchanged."
                      : Option.isSome(error)
                        ? error.value.detail
                        : "Could not finish the Claude installation. Check disk space and directory access.",
                  } satisfies ProviderInstallState;
                })
              : Effect.void,
          ),
          Effect.ignoreCause,
          Effect.ensuring(
            Effect.sync(() => {
              if (running?.operationId === operationId) running = undefined;
            }),
          ),
        );
        const fiber = yield* Effect.forkIn(Effect.interruptible(work), serviceScope);
        running = { operationId, fiber };
        return next;
      }).pipe(Effect.uninterruptible),
    )
    .pipe(Effect.mapError(wrapFailure("start", "Could not start the Claude installation.")));

  const cancel = Effect.fn("ClaudeInstallation.cancel")(function* (operationId: string) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (current.operationId !== operationId)
          return yield* installationError(
            "cancel",
            "This installation is no longer current. Refresh its status before cancelling.",
          );
        if (running?.operationId === operationId && isRunning(current))
          yield* Fiber.interrupt(running.fiber);
        return yield* SubscriptionRef.get(state);
      }),
    );
  });

  const remove = Effect.fn("ClaudeInstallation.remove")(
    function* (protectedBinaryPaths: ReadonlyArray<string> = []) {
      yield* gate.withPermit(
        Effect.gen(function* () {
          if (isRunning(yield* SubscriptionRef.get(state)))
            return yield* installationError(
              "remove",
              "Wait for the Claude installation to finish before removing it.",
            );
          const realManaged = yield* fs.realPath(managedDirectory).pipe(Effect.option);
          if (Option.isSome(realManaged)) {
            for (const binary of protectedBinaryPaths) {
              const resolved = yield* fs.realPath(binary).pipe(Effect.option);
              const candidate = Option.getOrElse(resolved, () => path.resolve(binary));
              if (candidate.startsWith(`${realManaged.value}${path.sep}`))
                return yield* installationError(
                  "remove",
                  "A provider instance uses a custom path inside managed Claude. Clear that path before removing it.",
                );
            }
          }
          yield* fs.remove(managedDirectory, { recursive: true, force: true });
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                operationId: null,
                phase: "idle",
                downloadedBytes: 0,
                installedVersion: null,
                executablePath: null,
                source: null,
                canRemove: false,
                message: null,
              }) satisfies ProviderInstallState,
          );
        }).pipe(Effect.uninterruptible),
      );
    },
    Effect.mapError(
      wrapFailure(
        "remove",
        "Could not remove the managed Claude runtime. Check directory access and try again.",
      ),
    ),
  );

  yield* Effect.gen(function* () {
    if (!(yield* fs.exists(managedDirectory))) return;
    const now = yield* Clock.currentTimeMillis;
    for (const entry of yield* fs.readDirectory(managedDirectory)) {
      if (!entry.startsWith(".install-") && !entry.startsWith(".active-")) continue;
      const target = path.join(managedDirectory, entry);
      const info = yield* fs.stat(target).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      const modifiedAt = Option.match(info.value.mtime, {
        onNone: () => now,
        onSome: (date) => date.getTime(),
      });
      if (now - modifiedAt >= STAGING_STALE_AFTER_MS)
        yield* fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore);
    }
    yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove: true }));
    const target = yield* fs.realPath(executablePath);
    const active = yield* decodeActive(yield* fs.readFileString(activePath));
    const realVersions = yield* fs.realPath(versionsDirectory).pipe(Effect.option);
    yield* SubscriptionRef.update(
      state,
      (current) =>
        ({
          ...current,
          installedVersion: active.version,
          executablePath: target,
          source: target.startsWith(
            `${Option.getOrElse(realVersions, () => versionsDirectory)}${path.sep}`,
          )
            ? "managed"
            : "local",
        }) satisfies ProviderInstallState,
    );
  }).pipe(Effect.ignore);

  return ClaudeInstallation.of({
    managedDirectory,
    executablePath,
    start,
    cancel,
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    remove,
  });
});
