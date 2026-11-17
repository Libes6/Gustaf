import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  type ProviderInstallCancelInput,
  type ProviderInstallState,
  type ProviderInstanceId,
  ProviderSetupError,
  type ProviderSetupInput,
} from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ClaudeInstallation from "./ClaudeInstallation.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";

const ANTIGRAVITY = ProviderDriverKind.make("antigravity");
const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const hasBinaryPath = Schema.is(Schema.Struct({ binaryPath: Schema.String }));
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeAntigravitySettings = Schema.decodeUnknownEffect(AntigravitySettings);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);

type InstallationError =
  | AntigravityInstallation.AntigravityInstallationError
  | ClaudeInstallation.ClaudeInstallationError
  | CodexInstallation.CodexInstallationError;
interface InstallationTarget {
  readonly installation: {
    readonly start: Effect.Effect<ProviderInstallState, InstallationError>;
    readonly cancel: (
      operationId: string,
    ) => Effect.Effect<ProviderInstallState, InstallationError>;
    readonly state: Effect.Effect<ProviderInstallState>;
    readonly changes: Stream.Stream<ProviderInstallState>;
    readonly remove: (
      protectedBinaryPaths?: ReadonlyArray<string>,
    ) => Effect.Effect<void, InstallationError>;
  };
  readonly decode: (
    config: unknown,
  ) => Effect.Effect<
    { readonly binaryPath: string; readonly setupMode?: "managed" | "existing" },
    Schema.SchemaError
  >;
  readonly managed?: { readonly name: string; readonly defaultBinary: string };
}

export class ProviderInstallation extends Context.Service<
  ProviderInstallation,
  {
    readonly start: (
      input: ProviderSetupInput,
    ) => Effect.Effect<ProviderInstallState, ProviderSetupError>;
    readonly cancel: (
      input: ProviderInstallCancelInput,
    ) => Effect.Effect<ProviderInstallState, ProviderSetupError>;
    readonly subscribe: (
      input: ProviderSetupInput,
    ) => Stream.Stream<ProviderInstallState, ProviderSetupError>;
    readonly remove: (
      input: ProviderSetupInput,
    ) => Effect.Effect<ProviderInstallState, ProviderSetupError>;
  }
>()("t3/provider/providerInstallation") {}

const make = Effect.fn("makeProviderInstallation")(function* () {
  const antigravityInstallation = yield* AntigravityInstallation.AntigravityInstallation;
  const codexInstallation = yield* CodexInstallation.CodexInstallation;
  const claudeInstallation = yield* ClaudeInstallation.ClaudeInstallation;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const accountCheckOperations = new Map<ProviderInstanceId, string>();

  const readEntries = Effect.fn("ProviderInstallation.readEntries")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
  ) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation,
            detail: "Could not read provider installation settings.",
          }),
      ),
    );
    return deriveProviderInstanceConfigMap(current);
  });

  const requireInstance = Effect.fn("ProviderInstallation.requireInstance")(function* (
    instanceId: ProviderInstanceId,
    operation: string,
    managedOnly = false,
  ) {
    const instance = yield* instances.getInstance(instanceId);
    const target: InstallationTarget | undefined =
      instance?.driverKind === ANTIGRAVITY
        ? { installation: antigravityInstallation, decode: decodeAntigravitySettings }
        : instance?.driverKind === CODEX
          ? {
              installation: codexInstallation,
              decode: decodeCodexSettings,
              managed: { name: "Codex", defaultBinary: "codex" },
            }
          : instance?.driverKind === CLAUDE
            ? {
                installation: claudeInstallation,
                decode: decodeClaudeSettings,
                managed: { name: "Claude", defaultBinary: "claude" },
              }
            : undefined;
    if (instance === undefined || target === undefined) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: "Managed installation is not available for this provider instance.",
      });
    }
    const entries = yield* readEntries(instanceId, operation);
    const config = yield* target.decode(entries[instanceId]?.config ?? {}).pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation,
            detail: "The provider instance configuration is invalid.",
          }),
      ),
    );
    const managed = target.managed;
    if (managed && config.setupMode !== "managed") {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: `Choose managed setup to install ${managed.name} in Gustaf.`,
      });
    }
    if (managedOnly && config.binaryPath && config.binaryPath !== managed?.defaultBinary) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail:
          "This instance uses a custom executable. Clear its binary path to manage installation in Gustaf.",
      });
    }
    return { installation: target.installation, driver: instance.driverKind };
  });

  const failure = (instanceId: ProviderInstanceId) => (error: InstallationError) =>
    new ProviderSetupError({ instanceId, operation: error.operation, detail: error.detail });

  const start = Effect.fn("ProviderInstallation.start")(function* (input: ProviderSetupInput) {
    const { installation, driver } = yield* requireInstance(input.instanceId, "install", true);
    const started = yield* installation.start.pipe(Effect.mapError(failure(input.instanceId)));
    if (
      driver === ANTIGRAVITY &&
      started.operationId !== null &&
      accountCheckOperations.get(input.instanceId) !== started.operationId
    ) {
      accountCheckOperations.set(input.instanceId, started.operationId);
      // Installation outlives the request and may finish while every client is disconnected.
      yield* installation.changes.pipe(
        Stream.filter(
          (state) =>
            state.operationId !== started.operationId ||
            state.phase === "succeeded" ||
            state.phase === "failed" ||
            state.phase === "cancelled",
        ),
        Stream.runHead,
        Effect.flatMap(
          Effect.fnUntraced(function* (result) {
            if (
              Option.isNone(result) ||
              result.value.operationId !== started.operationId ||
              result.value.phase !== "succeeded"
            )
              return;
            const instance = yield* instances.getInstance(input.instanceId);
            if (
              instance?.driverKind !== ANTIGRAVITY ||
              !instance.enabled ||
              !instance.refreshModels
            )
              return;
            yield* instance.refreshModels().pipe(Effect.ignore({ log: true }));
            yield* providers.refreshInstance(input.instanceId);
          }),
        ),
        Effect.forkIn(scope),
      );
    }
    return started;
  });

  const cancel = Effect.fn("ProviderInstallation.cancel")(function* (
    input: ProviderInstallCancelInput,
  ) {
    const { installation } = yield* requireInstance(input.instanceId, "cancel-install");
    return yield* installation
      .cancel(input.operationId)
      .pipe(Effect.mapError(failure(input.instanceId)));
  });

  const subscribe = (input: ProviderSetupInput) =>
    Stream.unwrap(
      requireInstance(input.instanceId, "observe-install").pipe(
        Effect.map(({ installation }) => installation.changes),
      ),
    );

  const remove = Effect.fn("ProviderInstallation.remove")(function* (input: ProviderSetupInput) {
    const { installation, driver } = yield* requireInstance(
      input.instanceId,
      "remove-install",
      true,
    );
    const entries = yield* readEntries(input.instanceId, "remove-install");
    const protectedPaths = yield* Effect.forEach(
      Object.values(entries),
      Effect.fnUntraced(function* (entry) {
        if (!hasBinaryPath(entry.config) || !entry.config.binaryPath.trim()) {
          return [];
        }
        const binaryPath = entry.config.binaryPath.trim();
        const resolved = yield* resolveCommandPath(binaryPath, {
          env: yield* mergeProviderInstanceEnvironment(entry.environment),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        return resolved === null ? [binaryPath] : [binaryPath, resolved];
      }),
    );
    yield* installation
      .remove(protectedPaths.flat())
      .pipe(Effect.mapError(failure(input.instanceId)));
    const allInstances = yield* instances.listInstances;
    yield* Effect.forEach(
      allInstances.filter((instance) => instance.driverKind === driver),
      (instance) => providers.refreshInstance(instance.instanceId),
      { discard: true },
    );
    return yield* installation.state;
  });

  return { start, cancel, subscribe, remove };
});

export const layer = Layer.effect(ProviderInstallation, make());
