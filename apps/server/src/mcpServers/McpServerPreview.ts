import {
  McpServerImportError,
  type McpPreviewInput,
  type McpPreviewResult,
  type McpServerId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { NativeMcpConfigs } from "./import/NativeMcpConfigs.ts";
import { nativeServersForProvider, toMcpServerName } from "./import/matcher.ts";
import { McpUserServers } from "./McpUserServers.ts";
import { McpServerChecks } from "./McpServerChecks.ts";

export class McpServerPreview extends Context.Service<
  McpServerPreview,
  {
    readonly preview: (
      input: McpPreviewInput,
    ) => Effect.Effect<McpPreviewResult, McpServerImportError>;
  }
>()("t3/mcpServers/McpServerPreview") {}

const isImportError = Schema.is(McpServerImportError);

export const layer = Layer.effect(
  McpServerPreview,
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistryV2;
    const projects = yield* ProjectStoreV2;
    const settings = yield* ServerSettingsService;
    const users = yield* McpUserServers;
    const checks = yield* McpServerChecks;
    const nativeConfigs = yield* NativeMcpConfigs;
    const policy = yield* ManagedPolicy.ManagedPolicy;
    const preview = Effect.fn("McpServerPreview.preview")(
      function* (input: McpPreviewInput) {
        const project = yield* projects.get(input.projectId);
        if (Option.isNone(project))
          return yield* new McpServerImportError({ reason: "entry-not-found" });
        const adapter = yield* registry.get(input.providerInstanceId);
        const current = yield* settings.getSettings;
        const known = yield* checks.knownUnusable;
        const resolved = yield* users.resolveForThread({
          projectId: input.projectId,
          driver: adapter.driver,
          cwd: project.value.workspaceRoot,
          ...(adapter.nativeMcpSources === undefined ? {} : { native: adapter.nativeMcpSources }),
          filtersTools: adapter.filtersMcpTools === true,
          ...(adapter.abortsOnFailedMcpServer === true ? { unusable: known } : {}),
        });
        const statuses = yield* checks.cachedStatuses;
        const passed = new Set(resolved.servers.map((server) => server.id));
        const skipped = new Map(resolved.skipped.map((server) => [server.id, server.reason]));
        const overrides = current.projectSettingsOverrides[input.projectId]?.mcpServers;
        const servers: Array<McpPreviewResult["servers"][number]> = Object.entries(
          current.mcpServers,
        ).map(([key, server]) => {
          const id = key as McpServerId;
          const reason = !(overrides?.[id]?.enabled ?? server.enabled)
            ? "Turned off."
            : server.providers !== undefined && !server.providers.includes(adapter.driver)
              ? "Not enabled for this provider."
              : server.transport.type === "stdio" &&
                  ManagedPolicy.deniedBy(policy, "localMcpServers") !== undefined
                ? "Local MCP servers are disallowed by policy."
                : skipped.get(id);
          const status = statuses.find((entry) => entry.id === id);
          return {
            id,
            source: overrides?.[id]?.enabled === undefined ? "Gustaf settings" : "Project override",
            disposition: passed.has(id) ? "passed" : reason === undefined ? "native" : "skipped",
            ...(reason === undefined ? {} : { reason }),
            ...(status === undefined ? {} : { status }),
          };
        });
        const native = adapter.nativeMcpSources;
        if (native !== undefined) {
          const listed = yield* nativeConfigs.list({
            ...native,
            projectDir: project.value.workspaceRoot,
          });
          for (const server of nativeServersForProvider(
            native.provider,
            listed.servers,
            project.value.workspaceRoot,
            { includeProjectMcpJson: native.includeProjectMcpJson ?? false },
          )) {
            const id = toMcpServerName(server.name);
            servers.push({
              id: server.name,
              source: server.sourcePath,
              disposition: passed.has(id as McpServerId) ? "skipped" : "native",
              ...(passed.has(id as McpServerId)
                ? { reason: "Replaced by Gustaf configuration." }
                : {}),
            });
          }
        }
        return { servers };
      },
      Effect.mapError((cause) =>
        isImportError(cause) ? cause : new McpServerImportError({ reason: "settings", cause }),
      ),
    );
    return McpServerPreview.of({ preview });
  }),
);
