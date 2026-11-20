import { assert, it } from "@effect/vitest";
import {
  type ManagedPolicyDocument,
  McpServerId,
  ProjectId,
  ProviderDriverKind,
  SecretProviderId,
  ServerSettings as ServerSettingsSchema,
} from "@t3tools/contracts";
import type { NativeMcpSources } from "@t3tools/provider-core/server/mcpSession";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution, type SpawnExecutableResolver } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { McpServerAuth } from "./McpServerAuth.ts";
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
    readonly driver?: string;
    readonly secrets?: Readonly<Record<string, string>>;
    readonly policy?: ManagedPolicyDocument;
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
    /** Defaults to every command existing except names under `/missing`. */
    readonly executables?: SpawnExecutableResolver;
    readonly unusable?: ReadonlyMap<McpServerId, string>;
    /** Access tokens of servers signed in through Gustaf. */
    readonly tokens?: Readonly<Record<string, string>>;
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
      driver: ProviderDriverKind.make(options.driver ?? "codex"),
      cwd: threadCwd,
      ...(options.native === undefined ? {} : { native: options.native.sources }),
      ...(options.unusable === undefined ? {} : { unusable: options.unusable }),
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
          Layer.mock(McpServerAuth)({
            accessToken: (id) => Effect.succeed(options.tokens?.[id]),
          }),
        ]),
      ),
    ),
    Effect.provideService(HostProcess.Platform, options.platform ?? "darwin"),
    Effect.provideService(
      HostProcess.Environment,
      options.environment ?? { PATH: "/opt/homebrew/bin:/usr/bin" },
    ),
    Effect.provideService(
      SpawnExecutableResolution,
      options.executables ??
        ((command) =>
          command.startsWith("/missing")
            ? undefined
            : command.startsWith("/")
              ? command
              : `/usr/bin/${command}`),
    ),
  );
const ids = (resolved: { readonly servers: ReadonlyArray<McpUserServers.ResolvedMcpServer> }) =>
  resolved.servers.map((server) => server.id);

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
    assert.deepEqual(ids(yield* resolve(settings)), ["on", "turned-on"]);
    assert.deepEqual(ids(yield* resolve(settings, { projectId: otherProjectId })), [
      "on",
      "flipped",
    ]);
  }),
);

it.effect("gives a server only to the providers it is limited to", () =>
  Effect.gen(function* () {
    const settings = {
      mcpServers: {
        everyone: http(true),
        "codex-only": { ...stdio(true), providers: ["codex"] },
        "two-agents": { ...http(true), providers: ["claudeAgent", "antigravity"] },
        nobody: { ...http(true), providers: [] },
      },
    };
    assert.deepEqual(ids(yield* resolve(settings, { driver: "codex" })), [
      "everyone",
      "codex-only",
    ]);
    assert.deepEqual(ids(yield* resolve(settings, { driver: "antigravity" })), [
      "everyone",
      "two-agents",
    ]);
  }),
);

it.effect("runs stdio servers in the thread's directory unless pinned, with the host PATH", () =>
  Effect.gen(function* () {
    const { servers } = yield* resolve({
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

it.effect(
  "reads secret references and sign-ins, and leaves out a server whose secret cannot be read",
  () =>
    Effect.gen(function* () {
      const { servers, skipped } = yield* resolve(
        {
          mcpServers: {
            linear: http(true, { Authorization: vault("op://linear"), "X-Team": "core" }),
            jam: http(true, { "X-Team": "core" }),
            figma: stdio(true, { env: { FIGMA_TOKEN: vault("op://missing") } }),
          },
        },
        {
          secrets: { "op://linear": "Bearer linear-token" },
          // The user's own Authorization header wins over a Gustaf sign-in.
          tokens: { linear: "signed-in-linear", jam: "jam-token" },
        },
      );
      assert.deepEqual(servers, [
        {
          type: "http",
          id: McpServerId.make("linear"),
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: "Bearer linear-token", "X-Team": "core" },
        },
        {
          type: "http",
          id: McpServerId.make("jam"),
          url: "https://mcp.example.test/mcp",
          headers: { "X-Team": "core", Authorization: "Bearer jam-token" },
        },
      ]);
      assert.deepEqual(skipped, [
        { id: McpServerId.make("figma"), reason: "The secret for FIGMA_TOKEN cannot be read." },
      ]);
    }),
);

it.effect("keeps local servers out of sessions when the policy forbids them", () =>
  Effect.gen(function* () {
    const resolved = yield* resolve(
      { mcpServers: { local: stdio(true), remote: http(true) } },
      {
        policy: {
          schemaVersion: 1,
          organization: "Example Corp",
          limits: { localMcpServers: false },
        },
      },
    );
    assert.deepEqual(ids(resolved), ["remote"]);
  }),
);

it.effect("points Windows at the npm shim a bare command names", () =>
  Effect.gen(function* () {
    const { servers } = yield* resolve(
      {
        mcpServers: {
          shim: stdio(true),
          native: stdio(true, { command: "uvx", args: [] }),
        },
      },
      {
        platform: "win32",
        environment: { Path: "C:\\npm" },
        executables: (command, _platform, env) =>
          env.Path === "C:\\npm"
            ? command === "npx"
              ? "C:\\npm\\npx.cmd"
              : `C:\\tools\\${command}.exe`
            : undefined,
      },
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
    const native = (name: string, args: ReadonlyArray<string>): NativeMcpServer => ({
      source: "codex",
      sourcePath: "/home/u/.codex/config.toml",
      name,
      enabled: true,
      transport: "stdio",
      command: "npx",
      args,
      env: {},
    });
    const resolved = yield* resolve(
      {
        mcpServers: {
          playwright: stdio(true, { args: ["-y", "@playwright/mcp@latest"] }),
          other: stdio(true, { args: ["-y", "server"] }),
        },
      },
      {
        native: {
          sources: { provider: "codex", homeDir: "/home/u" },
          servers: [
            native("Playwright", ["-y", "@playwright/mcp@latest"]),
            native("other", ["-y", "different"]),
          ],
        },
      },
    );
    assert.deepStrictEqual(ids(resolved), ["other"]);
  }),
);

it.effect("leaves out, for every provider, a stdio server whose command does not exist", () =>
  Effect.gen(function* () {
    const resolved = yield* resolve(
      {
        mcpServers: {
          spline: stdio(true, { command: "/missing/Spline.app/Contents/MacOS/Spline", args: [] }),
          "not-on-path": stdio(true, { command: "missing-tool", args: [] }),
          "computer-use": stdio(true, {
            command: "./Codex Computer Use.app/Client",
            args: ["mcp"],
          }),
          local: stdio(true, { command: "./bin/server", cwd: "/opt/tools", args: [] }),
          remote: http(true),
        },
      },
      {
        executables: (command) =>
          command === "/opt/tools/bin/server" || command === "/usr/bin/npx" ? command : undefined,
      },
    );
    assert.deepEqual(
      resolved.servers.map((server) => (server.type === "stdio" ? server.command : server.url)),
      ["/opt/tools/bin/server", "https://mcp.example.test/mcp"],
    );
    assert.deepEqual(resolved.skipped, [
      {
        id: McpServerId.make("spline"),
        reason: "Command not found: /missing/Spline.app/Contents/MacOS/Spline",
      },
      { id: McpServerId.make("not-on-path"), reason: "Command not found: missing-tool" },
      {
        id: McpServerId.make("computer-use"),
        reason: "Command not found: ./Codex Computer Use.app/Client",
      },
    ]);
  }),
);

it.effect("leaves out the servers the caller knows will not start", () =>
  Effect.gen(function* () {
    const resolved = yield* resolve(
      { mcpServers: { jam: http(true), linear: http(true) } },
      { unusable: new Map([[McpServerId.make("jam"), "Needs sign-in."]]) },
    );
    assert.deepEqual(ids(resolved), ["linear"]);
    assert.deepEqual(resolved.skipped, [{ id: McpServerId.make("jam"), reason: "Needs sign-in." }]);
  }),
);
