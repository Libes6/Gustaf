// @effect-diagnostics nodeBuiltinImport:off - Runs the generated runner in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { DesktopSshEnsureProgress } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { captureLauncher, captureLauncherFor, runLauncher } from "./launcherTestHarness.ts";
import { SSH_PROGRESS_MARKER } from "./progress.ts";
import * as SshTunnel from "./tunnel.ts";

const encode = (text: string) => new TextEncoder().encode(text);

const makeProcess = (input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly running?: boolean;
}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.make(encode(input.stdout ?? "")),
    stderr: Stream.make(encode(input.stderr ?? "")),
    all: Stream.empty,
    exitCode: input.running
      ? Effect.never
      : Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(input.running ?? false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

const args = (command: ChildProcess.Command) =>
  command._tag === "StandardCommand" ? command.args.map(String) : [];

const marker = (name: string) => `${SSH_PROGRESS_MARKER} ${name}\n`;

const ARCHIVE = { archiveVersion: "0.23.0", releaseBaseUrl: "https://mirror.example.com/t3" };

const makeLayer = (launch: { stdout?: string; stderr?: string; exitCode?: number }) => {
  const spawner = ChildProcessSpawner.make((command) => {
    const commandArgs = args(command);
    if (commandArgs.includes("-G"))
      return Effect.succeed(makeProcess({ stdout: "hostname devbox\n" }));
    if (commandArgs.includes("-N")) return Effect.succeed(makeProcess({ running: true }));
    if (commandArgs.some((arg) => arg.includes("auth pairing"))) {
      return Effect.succeed(makeProcess({}));
    }
    return Effect.succeed(makeProcess(launch));
  });
  return Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
      ),
    ),
    Layer.succeed(
      NetService.NetService,
      NetService.NetService.of({
        canListenOnHost: () => Effect.succeed(true),
        isPortAvailableOnLoopback: () => Effect.succeed(true),
        hasListenerOnHost: () => Effect.succeed(true),
        reserveLoopbackPort: () => Effect.succeed(41_773),
        findAvailablePort: (preferred) => Effect.succeed(preferred),
      }),
    ),
    SshAuth.SshPasswordPrompt.disabledLayer,
    SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
  );
};

const target = { alias: "devbox", hostname: "devbox", username: null, port: null };

const summarize = (events: ReadonlyArray<DesktopSshEnsureProgress>) =>
  events.map((event) => `${event.step}:${event.status}${event.detail ? `:${event.detail}` : ""}`);

describe("ssh ensure progress", () => {
  it.effect("reports the steps of an install in order and carries no stage markers", () =>
    Effect.gen(function* () {
      const events: Array<DesktopSshEnsureProgress> = [];
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(target, { onProgress: (event) => events.push(event) });
      }).pipe(
        Effect.provide(
          makeLayer({
            stdout: '{"remotePort":3773,"serverKind":"managed"}\n',
            stderr: [
              "connected",
              "runtime.check",
              "runtime.download",
              "runtime.verify",
              "runtime.install",
              "runtime.ready",
              "server.check",
              "server.start",
              "server.ready",
            ]
              .map(marker)
              .join(""),
          }),
        ),
        Effect.scoped,
      );
      assert.deepStrictEqual(summarize(events), [
        "resolve-host:running:devbox",
        "resolve-host:done",
        "connect:running:devbox",
        "connect:done:connected",
        "runtime-check:running:v0.23.0",
        "runtime-check:done:v0.23.0 · not installed",
        "runtime-download:running:v0.23.0 · mirror.example.com",
        "runtime-download:done",
        "runtime-verify:running:SHA-256",
        "runtime-verify:done",
        "runtime-install:running:v0.23.0",
        "runtime-install:done",
        "server-check:running",
        "server-check:done",
        "server-start:running",
        "server-start:done",
        "tunnel:running:localhost:41773",
        "tunnel:done",
      ]);
      assert.notInclude(JSON.stringify(events), SSH_PROGRESS_MARKER);
    }),
  );

  it.effect("fails the step that was running with the scrubbed cause", () =>
    Effect.gen(function* () {
      const events: Array<DesktopSshEnsureProgress> = [];
      const cause =
        "Could not download t3 0.23.0 from https://mirror.example.com/t3/v0.23.0/SHA256SUMS. token=abc123";
      const result = yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        return yield* Effect.result(
          manager.ensureEnvironment(target, { onProgress: (event) => events.push(event) }),
        );
      }).pipe(
        Effect.provide(
          makeLayer({
            exitCode: 1,
            stderr: `${["connected", "runtime.check", "runtime.download"].map(marker).join("")}${cause}\n`,
          }),
        ),
        Effect.scoped,
      );
      assert.isTrue(Result.isFailure(result));
      const failed = events.at(-1);
      assert.equal(failed?.step, "runtime-download");
      assert.equal(failed?.status, "failed");
      assert.include(failed?.detail ?? "", "Could not download t3 0.23.0 from https://mirror");
      assert.notInclude(failed?.detail ?? "", "abc123");
      assert.notInclude(failed?.detail ?? "", SSH_PROGRESS_MARKER);
    }),
  );

  it.effect("reports the same result without a progress listener", () =>
    Effect.gen(function* () {
      const bootstrap = yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        return yield* manager.ensureEnvironment(target);
      }).pipe(Effect.provide(makeLayer({ stdout: '{"remotePort":3773}\n' })), Effect.scoped);
      assert.equal(bootstrap.httpBaseUrl, "http://127.0.0.1:41773/");
    }),
  );
});

describe("remote launch script markers", () => {
  const names = (stderr: string) =>
    stderr
      .split("\n")
      .filter((line) => line.startsWith(SSH_PROGRESS_MARKER))
      .map((line) => line.slice(SSH_PROGRESS_MARKER.length + 1));

  it.effect("starts a server after checking for one", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {});
      assert.deepStrictEqual(names(result.stderr), [
        "connected",
        "server.check",
        "server.start",
        "server.ready",
      ]);
    }),
  );

  it.effect("reuses a running server", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, { recordedKind: "managed" });
      assert.deepStrictEqual(names(result.stderr), ["connected", "server.check", "server.reuse"]);
    }),
  );

  it.effect("checks the installed runtime before the server in archive mode", () =>
    Effect.gen(function* () {
      const script = yield* captureLauncherFor({ archiveVersion: "1.2.3" });
      const result = runLauncher(script, { archive: true });
      assert.deepStrictEqual(names(result.stderr), [
        "connected",
        "runtime.check",
        "runtime.ready",
        "server.check",
        "server.start",
        "server.ready",
      ]);
    }),
  );
});

describe("remote runner script markers", () => {
  const checksum =
    NodeChildProcess.spawnSync("sh", ["-c", "command -v sha256sum"]).status === 0
      ? "sha256sum"
      : "shasum";
  const tool = (name: string) =>
    NodeChildProcess.execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();

  it("announces download, verify and install in order while unpacking a release", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-runner-"));
    try {
      const bin = NodePath.join(root, "bin");
      const release = NodePath.join(root, "release");
      const home = NodePath.join(root, "home");
      const version = "0.23.0";
      const archive = `t3-${version}-linux-x64.tar.gz`;
      NodeFS.mkdirSync(bin);
      NodeFS.mkdirSync(home);
      NodeFS.mkdirSync(NodePath.join(release, "t3"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(release, "t3", "t3"), "#!/bin/sh\necho ok\n", {
        mode: 0o755,
      });
      NodeChildProcess.execFileSync("tar", ["-czf", archive, "t3"], { cwd: release });
      NodeChildProcess.execFileSync(
        "sh",
        ["-c", `${checksum}${checksum === "shasum" ? " -a 256" : ""} ${archive} > SHA256SUMS`],
        { cwd: release },
      );
      for (const name of [
        "sh",
        "mkdir",
        "mktemp",
        "cat",
        "rm",
        "grep",
        "cut",
        checksum,
        "tar",
        "gzip",
        "mv",
      ]) {
        NodeFS.symlinkSync(tool(name), NodePath.join(bin, name));
      }
      NodeFS.writeFileSync(
        NodePath.join(bin, "uname"),
        '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(
        NodePath.join(bin, "curl"),
        `#!/bin/sh\nfor last; do :; done\nfor a; do case "$a" in http*) src="${release}/\${a##*/}" ;; esac; done\nexec cat "$src" > "$last"\n`,
        { mode: 0o755 },
      );
      const runner = NodePath.join(root, "run-t3.sh");
      NodeFS.writeFileSync(
        runner,
        SshTunnel.buildRemoteT3RunnerScript({ archiveVersion: version }),
      );
      const result = NodeChildProcess.spawnSync(NodePath.join(bin, "sh"), [runner, "--version"], {
        encoding: "utf8",
        env: { HOME: home, PATH: bin },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepStrictEqual(
        result.stderr
          .split("\n")
          .filter((line) => line.startsWith(SSH_PROGRESS_MARKER))
          .map((line) => line.slice(SSH_PROGRESS_MARKER.length + 1)),
        ["runtime.download", "runtime.verify", "runtime.install"],
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
