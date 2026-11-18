import { assert, it } from "@effect/vitest";
import {
  type ManagedPolicyDocument,
  McpServerId,
  ProjectId,
  SecretProviderId,
  ServerSettings as ServerSettingsSchema,
} from "@t3tools/contracts";
import type { NativeMcpSources } from "@t3tools/provider-core/server/mcpSession";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { NativeMcpConfigs } from "./import/NativeMcpConfigs.ts";
import type { NativeMcpServer } from "./import/nativeMcp.ts";
import * as McpUserServers from "./McpUserServers.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");
const threadCwd = "/work/worktrees/thread-1";
const vault = (reference: string) => ({ provider: SecretProviderId.make("vault"), reference });

const stdio = (enabled: boolean, transport: Record<string, unknown> = {}) => ({
  enabled,
  transport: { type: "stdio", command: "npx", args: ["-y", "server"], env: {}, ...transport },
});
const http = (enabled: boolean, headers: Record<string, unknown> = {}) => ({
  enabled,
  transport: { type: "http", url: "https://mcp.example.test/mcp", headers },
});

const decodeSettings = Schema.decodeUnknownSync(ServerSettingsSchema);

const resolve = (
  settings: unknown,
  options: {
    readonly projectId?: ProjectId;
    readonly secrets?: Readonly<Record<string, string>>;
    readonly policy?: ManagedPolicyDocument;
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
    readonly native?: {
      readonly sources: NativeMcpSources;
      readonly servers: ReadonlyArray<NativeMcpServer>;
    };
  } = {},
) =>
  Effect.gen(function* () {
    const service = yield* McpUserServers.McpUserServers;
    return yield* service.resolveForThread({
      projectId: options.projectId ?? projectId,
      cwd: threadCwd,
      ...(options.native === undefined ? {} : { native: options.native.sources }),
    });
  }).pipe(
    Effect.provide(
      McpUserServers.layer.pipe(
        Layer.provide([
          ServerSettings.layerTest(decodeSettings(settings)),
          ManagedPolicy.layerTest(options.policy),
          Layer.succeed(SecretResolver.SecretResolver, {
            label: (provider) => Effect.succeed(provider),
            read: (references) =>
              Effect.succeed(references.map(({ reference }) => options.secrets?.[reference])),
            invalidate: () => Effect.void,
          }),
          Layer.succeed(NativeMcpConfigs, {
            list: () => Effect.succeed({ servers: options.native?.servers ?? [], errors: [] }),
          }),
        ]),
      ),
    ),
    Effect.provideService(HostProcess.Platform, options.platform ?? "darwin"),
    Effect.provideService(
      HostProcess.Environment,
      options.environment ?? { PATH: "/opt/homebrew/bin:/usr/bin" },
    ),
  );

it.effect("applies a project's switches over each server's own, and nothing else", () =>
  Effect.gen(function* () {
    const settings = {
      mcpServers: {
        on: http(true),
        off: http(false),
        flipped: http(true),
        "turned-on": http(false),
      },
      projectSettingsOverrides: {
        [projectId]: {
          mcpServers: { flipped: { enabled: false }, "turned-on": { enabled: true } },
        },
      },
    };
    const ids = (servers: ReadonlyArray<McpUserServers.ResolvedMcpServer>) =>
      servers.map((server) => server.id);
    assert.deepEqual(ids(yield* resolve(settings)), ["on", "turned-on"]);
    assert.deepEqual(ids(yield* resolve(settings, { projectId: otherProjectId })), [
      "on",
      "flipped",
    ]);
  }),
);

it.effect("runs stdio servers in the thread's directory unless pinned, with the host PATH", () =>
  Effect.gen(function* () {
    const servers = yield* resolve({
      mcpServers: {
        thread: stdio(true, { env: { API_URL: "https://api.test" } }),
        pinned: stdio(true, { cwd: "/opt/tools", env: { PATH: "/custom/bin" } }),
      },
    });
    assert.deepEqual(servers, [
      {
        type: "stdio",
        id: McpServerId.make("thread"),
        command: "npx",
        args: ["-y", "server"],
        env: { PATH: "/opt/homebrew/bin:/usr/bin", API_URL: "https://api.test" },
        cwd: threadCwd,
      },
      {
        type: "stdio",
        id: McpServerId.make("pinned"),
        command: "npx",
        args: ["-y", "server"],
        env: { PATH: "/custom/bin" },
        cwd: "/opt/tools",
      },
    ]);
  }),
);

it.effect("reads secret references, and leaves out a server whose secret cannot be read", () =>
  Effect.gen(function* () {
    const servers = yield* resolve(
      {
        mcpServers: {
          linear: http(true, { Authorization: vault("op://linear"), "X-Team": "core" }),
          figma: stdio(true, { env: { FIGMA_TOKEN: vault("op://missing") } }),
        },
      },
      { secrets: { "op://linear": "Bearer linear-token" } },
    );
    assert.deepEqual(servers, [
      {
        type: "http",
        id: McpServerId.make("linear"),
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "Bearer linear-token", "X-Team": "core" },
      },
    ]);
  }),
);

it.effect("keeps local servers out of sessions when the policy forbids them", () =>
  Effect.gen(function* () {
    const servers = yield* resolve(
      { mcpServers: { local: stdio(true), remote: http(true) } },
      {
        policy: {
          schemaVersion: 1,
          organization: "Example Corp",
          limits: { localMcpServers: false },
        },
      },
    );
    assert.deepEqual(
      servers.map((server) => server.id),
      ["remote"],
    );
  }),
);

it.effect("points Windows at the npm shim a bare command names", () =>
  Effect.gen(function* () {
    const servers = yield* resolve(
      {
        mcpServers: {
          shim: stdio(true),
          native: stdio(true, { command: "uvx", args: [] }),
        },
      },
      { platform: "win32", environment: { Path: "C:\\npm" } },
    ).pipe(
      Effect.provideService(SpawnExecutableResolution, (command, _platform, env) =>
        env.Path === "C:\\npm"
          ? command === "npx"
            ? "C:\\npm\\npx.cmd"
            : `C:\\tools\\${command}.exe`
          : undefined,
      ),
    );
    assert.deepEqual(
      servers.map((server) => (server.type === "stdio" ? [server.command, server.env] : [])),
      [
        ["C:\\npm\\npx.cmd", { Path: "C:\\npm" }],
        ["uvx", { Path: "C:\\npm" }],
      ],
    );
  }),
);

it.effect("leaves out a server the provider already loads from its own config", () =>
  Effect.gen(function* () {
    const native = (
      name: string,
      args: ReadonlyArray<string>,
      env: Readonly<Record<string, string>> = {},
    ): NativeMcpServer => ({
      source: "codex",
      sourcePath: "/home/u/.codex/config.toml",
      name,
      enabled: true,
      transport: "stdio",
      command: "npx",
      args,
      env,
    });
    const servers = yield* resolve(
      {
        mcpServers: {
          playwright: stdio(true, { args: ["-y", "@playwright/mcp@latest"] }),
          other: stdio(true, { args: ["-y", "server"] }),
          rotated: http(true, { Authorization: vault("op://rotated") }),
          unchanged: http(true, { Authorization: vault("op://unchanged") }),
          "configured-env": stdio(true, { env: { PROFILE: "gustaf" } }),
        },
      },
      {
        secrets: { "op://rotated": "Bearer new", "op://unchanged": "Bearer same" },
        native: {
          sources: { provider: "codex", homeDir: "/home/u" },
          servers: [
            native("Playwright", ["-y", "@playwright/mcp@latest"]),
            native("other", ["-y", "different"]),
            native("configured-env", ["-y", "server"], { PROFILE: "native" }),
            ...(["rotated", "unchanged"] as const).map((name): NativeMcpServer => ({
              source: "codex",
              sourcePath: "/home/u/.codex/config.toml",
              name,
              enabled: true,
              transport: "http",
              url: "https://mcp.example.test/mcp",
              headers: { Authorization: name === "rotated" ? "Bearer old" : "Bearer same" },
            })),
          ],
        },
      },
    );
    assert.deepStrictEqual(
      servers.map((server) => server.id),
      ["other", "rotated", "configured-env"],
    );
  }),
);
