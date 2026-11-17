import { assert, it } from "@effect/vitest";
import {
  type ManagedPolicyDocument,
  McpServerId,
  ServerSettings as ServerSettingsSchema,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { NativeMcpConfigs, type NativeMcpConfigLocations } from "./import/NativeMcpConfigs.ts";
import type { NativeMcpServer } from "./import/nativeMcp.ts";
import * as McpServerImport from "./McpServerImport.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettingsSchema);

const figma: NativeMcpServer = {
  source: "codex",
  sourcePath: "/home/me/.codex/config.toml",
  name: "Figma Desktop",
  enabled: true,
  transport: "stdio",
  command: "npx",
  args: ["-y", "figma-mcp"],
  env: { FIGMA_TOKEN: "figma-secret-value" },
};
const linear: NativeMcpServer = {
  source: "claude",
  sourcePath: "/home/me/.claude.json",
  projectDir: "/work/app",
  name: "linear",
  enabled: false,
  transport: "http",
  url: "https://mcp.linear.test/mcp",
  headers: { Authorization: "Bearer linear-secret-value" },
};

const run = <A, E>(
  program: (service: McpServerImport.McpServerImport["Service"]) => Effect.Effect<A, E>,
  options: {
    readonly settings?: unknown;
    readonly policy?: ManagedPolicyDocument;
    readonly locations?: Array<NativeMcpConfigLocations>;
  } = {},
) =>
  Effect.gen(function* () {
    const service = yield* McpServerImport.McpServerImport;
    const result = yield* program(service);
    const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
    return { result, settings };
  }).pipe(
    Effect.provide(
      McpServerImport.layer.pipe(
        Layer.provideMerge(ServerSettings.layerTest(decodeSettings(options.settings ?? {}))),
        Layer.provide([
          ManagedPolicy.layerTest(options.policy),
          Layer.succeed(NativeMcpConfigs, {
            list: (locations) =>
              Effect.sync(() => {
                options.locations?.push(locations);
                return { servers: [figma, linear], errors: [] };
              }),
          }),
        ]),
      ),
    ),
    Effect.provideService(HostProcess.HomeDirectory, "/home/me"),
    Effect.provideService(HostProcess.Environment, { CODEX_HOME: "/home/me/codex-alt" }),
  );

it.effect("lists importable servers with key names only, never env or header values", () =>
  Effect.gen(function* () {
    const locations: Array<NativeMcpConfigLocations> = [];
    const { result } = yield* run((service) => service.list({ projectDir: "/work/app" }), {
      locations,
      settings: {
        mcpServers: {
          design: { transport: { type: "stdio", command: "npx", args: ["-y", "figma-mcp"] } },
        },
      },
    });
    assert.deepStrictEqual(locations, [
      { homeDir: "/home/me", codexHome: "/home/me/codex-alt", projectDir: "/work/app" },
    ]);
    const json = JSON.stringify(result);
    assert.notInclude(json, "figma-secret-value");
    assert.notInclude(json, "linear-secret-value");
    assert.deepStrictEqual(result.servers, [
      {
        source: "codex",
        name: "Figma Desktop",
        sourcePath: "/home/me/.codex/config.toml",
        suggestedId: "figma-desktop",
        enabledInSource: true,
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "figma-mcp"],
          envKeys: ["FIGMA_TOKEN"],
        },
        alreadyInGustaf: true,
      },
      {
        source: "claude",
        name: "linear",
        projectDir: "/work/app",
        sourcePath: "/home/me/.claude.json",
        suggestedId: "linear",
        enabledInSource: false,
        transport: {
          type: "http",
          url: "https://mcp.linear.test/mcp",
          headerKeys: ["Authorization"],
        },
        alreadyInGustaf: false,
      },
    ]);
  }),
);

it.effect("imports chosen entries turned off, with their values as literal secrets", () =>
  Effect.gen(function* () {
    const { result, settings } = yield* run((service) =>
      service.importServers({
        entries: [
          {
            source: "codex",
            name: "Figma Desktop",
            id: McpServerId.make("figma"),
            transport: "stdio",
          },
          {
            source: "claude",
            name: "linear",
            projectDir: "/work/app",
            id: McpServerId.make("linear"),
            transport: "http",
          },
        ],
      }),
    );
    assert.deepStrictEqual(result.imported, [
      McpServerId.make("figma"),
      McpServerId.make("linear"),
    ]);
    assert.deepStrictEqual(settings.mcpServers, {
      [McpServerId.make("figma")]: {
        name: "Figma Desktop",
        enabled: false,
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "figma-mcp"],
          env: { FIGMA_TOKEN: "figma-secret-value" },
          cwd: "thread",
        },
      },
      [McpServerId.make("linear")]: {
        name: "linear",
        enabled: false,
        transport: {
          type: "http",
          url: "https://mcp.linear.test/mcp",
          headers: { Authorization: "Bearer linear-secret-value" },
        },
      },
    });
  }),
);

it.effect("refuses imports that would overwrite, miss, or change an entry", () =>
  Effect.gen(function* () {
    const attempt = (
      entry: Parameters<
        McpServerImport.McpServerImport["Service"]["importServers"]
      >[0]["entries"][0],
      options: { readonly settings?: unknown; readonly policy?: ManagedPolicyDocument } = {},
    ) =>
      run((service) => service.importServers({ entries: [entry] }), options).pipe(
        Effect.flip,
        Effect.map((error) => ("reason" in error ? error.reason : error._tag)),
      );
    const id = McpServerId.make("figma");
    assert.strictEqual(
      yield* attempt(
        { source: "codex", name: "Figma Desktop", id, transport: "stdio" },
        {
          settings: {
            mcpServers: { figma: { transport: { type: "http", url: "https://x.test" } } },
          },
        },
      ),
      "id-taken",
    );
    assert.strictEqual(
      yield* attempt({ source: "cursor", name: "Figma Desktop", id, transport: "stdio" }),
      "entry-not-found",
    );
    // Claude's per-project entry is a different entry from a global one of the same name.
    assert.strictEqual(
      yield* attempt({ source: "claude", name: "linear", id, transport: "http" }),
      "entry-not-found",
    );
    assert.strictEqual(
      yield* attempt({ source: "codex", name: "Figma Desktop", id, transport: "http" }),
      "transport-mismatch",
    );
    assert.strictEqual(
      yield* attempt(
        { source: "codex", name: "Figma Desktop", id, transport: "stdio" },
        { policy: { schemaVersion: 1, organization: "Acme", limits: { localMcpServers: false } } },
      ),
      "local-servers-disallowed",
    );
  }),
);
