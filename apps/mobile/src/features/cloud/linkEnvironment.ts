import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/http";
import type { ManagedRelay } from "@t3tools/client-runtime/relay";

import type { SavedRemoteConnection } from "../../lib/connection";
import type * as MobileStorage from "../../persistence/mobile-storage";

export class CloudEnvironmentLinkError extends Schema.TaggedError<CloudEnvironmentLinkError>()(
  "CloudEnvironmentLinkError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    traceId: Schema.optional(Schema.String),
  },
) {}

interface LinkEnvironmentToCloudInput {
  readonly connection: SavedRemoteConnection;
  readonly clerkToken: string;
}

type LinkEnvironmentToCloudRequirements =
  | HttpClient.HttpClient
  | ManagedRelay.ManagedRelayClient
  | MobileStorage.MobileStorage;

/**
 * Gustaf has no managed relay: the server dropped the `connect` API group that linking
 * called, so every link fails with a message instead of reaching a missing endpoint. The
 * signature is T3's, so the screens that call it (notification settings, Live Activity
 * preferences) compile unchanged. A Gustaf backend replaces this later.
 */
export const linkEnvironmentToCloudWithPreference = Effect.fn(
  "linkEnvironment.linkEnvironmentToCloudWithPreference",
)(function* (
  _input: LinkEnvironmentToCloudInput & { readonly liveActivitiesEnabled: boolean },
): Effect.fn.Return<void, CloudEnvironmentLinkError, LinkEnvironmentToCloudRequirements> {
  return yield* new CloudEnvironmentLinkError({
    message: "Cloud linking is not available in Gustaf.",
  });
});
