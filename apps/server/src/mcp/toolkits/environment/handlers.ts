import { OrchestratorMcpFailure, type ServerSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ServerConfig from "../../../config.ts";
import * as TraceDiagnostics from "../../../diagnostics/TraceDiagnostics.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const ERROR_LIMIT = 10;
const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}… (truncated)` : text;

const ownEnvironment = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor };
});
const access = Effect.gen(function* () {
  const context = yield* ownEnvironment;
  return { ...context, settings: yield* Settings.ServerSettingsService };
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  t3_environment_errors_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* ownEnvironment;
      const config = yield* ServerConfig.ServerConfig;
      const diagnostics = yield* TraceDiagnostics.TraceDiagnostics;
      const files = { traceFilePath: config.serverTracePath, maxFiles: config.traceMaxFiles };
      const crashes = yield* diagnostics.readClientCrashes({
        traceFilePath: config.clientCrashLogPath,
        maxFiles: 1,
        limit: ERROR_LIMIT,
      });
      const traces = yield* diagnostics.read(files);
      return {
        clientCrashes: crashes.map((crash) => ({
          at: DateTime.formatIso(crash.endedAt),
          kind: crash.kind,
          route: crash.route,
          message: truncate(crash.message, 1_000),
          stack: crash.stack === null ? null : truncate(crash.stack, 6_000),
          surface: crash.surface,
          appVersion: crash.appVersion,
        })),
        serverFailures: traces.commonFailures
          .filter((failure) => failure.name !== TraceDiagnostics.CLIENT_CRASH_SPAN_NAME)
          .slice(0, ERROR_LIMIT)
          .map((failure) => ({
            name: failure.name,
            cause: truncate(failure.cause, 2_000),
            count: failure.count,
            lastSeenAt: DateTime.formatIso(failure.lastSeenAt),
          })),
      };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      });
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
});
