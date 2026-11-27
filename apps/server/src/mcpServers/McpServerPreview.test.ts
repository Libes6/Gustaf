import { assert, it } from "@effect/vitest";
import { McpServerId, ProjectId, ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Settings from "../serverSettings.ts";
import { NativeMcpConfigs } from "./import/NativeMcpConfigs.ts";
import { McpUserServers } from "./McpUserServers.ts";
import { McpServerChecks } from "./McpServerChecks.ts";
import { McpServerPreview, layer } from "./McpServerPreview.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

it.effect(
  "distinguishes project switches, provider restrictions and skipped servers from cached connection status",
  () => {
    const projectId = ProjectId.make("project");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const filtered = McpServerId.make("filtered");
    return Effect.gen(function* () {
      const service = yield* McpServerPreview;
      const result = yield* service.preview({ projectId, providerInstanceId });
      assert.deepEqual(result.servers, [
        {
          id: "filtered",
          source: "Gustaf settings",
          disposition: "skipped",
          reason: "This provider cannot enforce disabled tools.",
          status: { id: filtered, status: "connected" },
        },
        { id: "off", source: "Project override", disposition: "skipped", reason: "Turned off." },
        {
          id: "other",
          source: "Gustaf settings",
          disposition: "skipped",
          reason: "Not enabled for this provider.",
        },
      ]);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide([
            ManagedPolicy.layerTest(),
            Settings.layerTest(
              decodeSettings({
                mcpServers: {
                  filtered: {
                    enabled: true,
                    disabledTools: ["write"],
                    transport: { type: "http", url: "https://mcp.test" },
                  },
                  off: { enabled: true, transport: { type: "http", url: "https://mcp.test" } },
                  other: {
                    enabled: true,
                    providers: ["claudeAgent"],
                    transport: { type: "http", url: "https://mcp.test" },
                  },
                },
                projectSettingsOverrides: {
                  [projectId]: { mcpServers: { off: { enabled: false } } },
                },
              }),
            ),
            Layer.mock(ProjectStoreV2)({
              get: () => Effect.succeedSome({ workspaceRoot: "/project" } as never),
            }),
            Layer.mock(ProviderAdapterRegistryV2)({
              get: () => Effect.succeed({ driver: "codex", filtersMcpTools: false } as never),
            }),
            Layer.mock(McpUserServers)({
              resolveForThread: () =>
                Effect.succeed({
                  servers: [],
                  skipped: [
                    { id: filtered, reason: "This provider cannot enforce disabled tools." },
                  ],
                }),
            }),
            Layer.mock(McpServerChecks)({
              knownUnusable: Effect.succeed(new Map()),
              cachedStatuses: Effect.succeed([{ id: filtered, status: "connected" }]),
            }),
            Layer.mock(NativeMcpConfigs)({}),
          ]),
        ),
      ),
    );
  },
);
