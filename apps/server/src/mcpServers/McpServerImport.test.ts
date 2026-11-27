import { assert, it } from "@effect/vitest";
import {
  type ManagedPolicyDocument,
  McpServerId,
  ProviderDriverKind,
  ServerSettings as ServerSettingsSchema,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
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
  cwd: "/opt/figma",
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
const projectDocs: NativeMcpServer = {
  source: "project-mcp-json",
  sourcePath: "/work/app/.mcp.json",
  projectDir: "/work/app",
  name: "docs",
  enabled: true,
  transport: "http",
  url: "https://mcp.docs.test/mcp",
  headers: {},
};

const run = <A, E>(
  program: (service: McpServerImport.McpServerImport["Service"]) => Effect.Effect<A, E>,
  options: {
    readonly settings?: unknown;
    readonly policy?: ManagedPolicyDocument;
    readonly locations?: Array<NativeMcpConfigLocations>;
    readonly natives?: ReadonlyArray<NativeMcpServer>;
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
          Layer.mock(SecretResolver.SecretResolver)({
            read: (refs) => Effect.succeed(refs.map(() => undefined)),
          }),
          Layer.succeed(NativeMcpConfigs, {
            list: (locations) =>
              Effect.sync(() => {
                options.locations?.push(locations);
                return { servers: options.natives ?? [figma, linear], errors: [] };
              }),
          }),
        ]),
      ),
    ),
    Effect.provideService(HostProcess.HomeDirectory, "/home/me"),
    Effect.provideService(HostProcess.Environment, {
      CODEX_HOME: "/home/me/codex-alt",
      MCP_TOKEN: "private-bearer",
    }),
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
        alreadyInGustaf: false,
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
        authStatus: "credentials-available",
        alreadyInGustaf: false,
      },
    ]);
  }),
);

it.effect("imports chosen entries turned off, for their source's provider only", () =>
  Effect.gen(function* () {
    const { result, settings } = yield* run(
      (service) =>
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
            {
              source: "project-mcp-json",
              name: "docs",
              projectDir: "/work/app",
              id: McpServerId.make("docs"),
              transport: "http",
            },
          ],
        }),
      { natives: [figma, linear, projectDocs] },
    );
    assert.deepStrictEqual(result.imported, [
      McpServerId.make("figma"),
      McpServerId.make("linear"),
      McpServerId.make("docs"),
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
          cwd: "/opt/figma",
        },
        providers: [ProviderDriverKind.make("codex")],
      },
      [McpServerId.make("linear")]: {
        name: "linear",
        enabled: false,
        transport: {
          type: "http",
          url: "https://mcp.linear.test/mcp",
          headers: { Authorization: "Bearer linear-secret-value" },
        },
        providers: [ProviderDriverKind.make("claudeAgent")],
      },
      [McpServerId.make("docs")]: {
        name: "docs",
        enabled: false,
        transport: { type: "http", url: "https://mcp.docs.test/mcp", headers: {} },
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

it.effect(
  "preserves bearer environment references and reports credentials on the target environment",
  () =>
    Effect.gen(function* () {
      const natives: ReadonlyArray<NativeMcpServer> = [
        { ...projectDocs, name: "missing", transport: "http", bearerTokenEnvVar: "MISSING_TOKEN" },
        { ...projectDocs, name: "available", transport: "http", bearerTokenEnvVar: "MCP_TOKEN" },
        { ...projectDocs, name: "oauth", transport: "http", requiresSignIn: true },
      ];
      const { result, settings } = yield* run(
        (service) =>
          Effect.gen(function* () {
            const listed = yield* service.list({});
            yield* service.importServers({
              entries: natives.map((server) => ({
                source: server.source,
                name: server.name,
                projectDir: "/work/app",
                id: McpServerId.make(server.name),
                transport: "http" as const,
              })) as [
                Parameters<typeof service.importServers>[0]["entries"][number],
                ...Parameters<typeof service.importServers>[0]["entries"][number][],
              ],
            });
            return listed;
          }),
        { natives },
      );
      assert.deepEqual(
        result.servers.map((server) => server.authStatus),
        ["missing-environment-variable", "credentials-available", "sign-in-required"],
      );
      assert.notInclude(JSON.stringify(result), "private-bearer");
      assert.deepEqual(settings.mcpServers[McpServerId.make("missing")]?.transport, {
        type: "http",
        url: projectDocs.url,
        headers: {},
        bearerTokenEnvVar: "MISSING_TOKEN",
      });
      assert.propertyVal(
        settings.mcpServers[McpServerId.make("oauth")]?.transport,
        "requiresSignIn",
        true,
      );
    }),
);
