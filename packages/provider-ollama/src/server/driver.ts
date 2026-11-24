import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";

import {
  listOllamaModels,
  makeOllamaTextGeneration,
  OllamaAdapterV2Driver,
  OLLAMA_DRIVER_KIND,
  providerModels,
} from "./adapter.ts";
import { ollamaBaseUrl } from "../http.ts";
import { OllamaSettings } from "../settings.ts";

const decodeSettings = Schema.decodeSync(OllamaSettings);
const PRESENTATION = {
  displayName: "Ollama",
  showInteractionModeToggle: false,
  supportsConversationRollback: false,
  supportedRuntimeModes: ["full-access"],
} as const;

// Models come and go with `ollama pull` and `ollama rm`, and the probe is a call to a local
// server, so it runs far more often than the 5-minute default of CLI providers.
const OLLAMA_REFRESH_INTERVAL = "30 seconds";

const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
  provider: OLLAMA_DRIVER_KIND,
  packageName: null,
  manualCommand: "https://ollama.com/download",
});

export type OllamaDriverEnv = ProviderHost.ProviderHost | HttpClient.HttpClient;

const stamp =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: OLLAMA_DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

const snapshotFor = Effect.fn("OllamaDriver.snapshot")(function* (input: {
  readonly http: HttpClient.HttpClient;
  readonly settings: OllamaSettings;
  readonly checking: boolean;
}) {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const baseUrl = ollamaBaseUrl(input.settings.baseUrl);
  if (!input.settings.enabled) {
    return buildServerProvider({
      driver: OLLAMA_DRIVER_KIND,
      presentation: PRESENTATION,
      enabled: false,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Ollama is turned off.",
      },
    });
  }
  if (input.checking) {
    return buildServerProvider({
      driver: OLLAMA_DRIVER_KIND,
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: `Checking ${baseUrl}…`,
      },
    });
  }
  const listed = yield* listOllamaModels(input.http, baseUrl).pipe(Effect.result);
  if (listed._tag === "Failure") {
    return buildServerProvider({
      driver: OLLAMA_DRIVER_KIND,
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unauthenticated" },
        message: listed.failure.detail,
      },
    });
  }
  return buildServerProvider({
    driver: OLLAMA_DRIVER_KIND,
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models: providerModels(listed.success),
    probe: {
      installed: true,
      version: null,
      status: listed.success.length > 0 ? "ready" : "warning",
      auth: { status: "authenticated", type: "local" },
      ...(listed.success.length > 0
        ? {}
        : { message: `Connected to ${baseUrl}, but no models are installed.` }),
    },
  });
});

export const OllamaDriver: ProviderDriver<OllamaSettings, OllamaDriverEnv> = {
  driverKind: ProviderDriverKind.make("ollama"),
  metadata: { displayName: "Ollama", supportsMultipleInstances: true },
  configSchema: OllamaSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("OllamaDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const http = yield* HttpClient.HttpClient;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: OLLAMA_DRIVER_KIND,
      instanceId,
    });
    const identity = stamp({
      instanceId,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effective = { ...config, enabled } satisfies OllamaSettings;
    const baseUrl = ollamaBaseUrl(effective.baseUrl);
    const orchestrationAdapter = yield* OllamaAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: OLLAMA_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Ollama adapter.",
            cause,
          }),
      ),
    );
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effective);
    const snapshot = yield* makeManagedServerProvider({
      resolveMaintenance: () => Effect.succeed(maintenance),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      refreshInterval: OLLAMA_REFRESH_INTERVAL,
      initialSnapshot: (settings) =>
        snapshotFor({ http, settings: settings.provider, checking: true }).pipe(
          Effect.map(identity),
        ),
      checkProvider: snapshotSettings.getSettings.pipe(
        Effect.flatMap((settings) =>
          snapshotFor({ http, settings: settings.provider, checking: false }),
        ),
        Effect.map(identity),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: OLLAMA_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Ollama snapshot.",
            cause,
          }),
      ),
    );
    return {
      instanceId,
      driverKind: OLLAMA_DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration: makeOllamaTextGeneration(http, baseUrl),
    } satisfies ProviderInstance;
  }),
};
