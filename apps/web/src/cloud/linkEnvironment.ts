import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/http";
import type { EnvironmentCloudLinkStateResult, EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import type { ManagedRelay } from "@t3tools/client-runtime/relay";

export class CloudEnvironmentLinkError extends Schema.TaggedError<CloudEnvironmentLinkError>()(
  "CloudEnvironmentLinkError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    traceId: Schema.optional(Schema.String),
  },
) {}

export const isCloudEnvironmentLinkError = Schema.is(CloudEnvironmentLinkError);

export interface CloudLinkTarget {
  readonly environmentId: EnvironmentId;
}

export type CloudLinkState = EnvironmentCloudLinkStateResult;

export type CloudLinkMode = "managed" | "publish_only";

type CloudLinkServices = EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient;

/**
 * Gustaf has no managed relay: the server dropped the `connect` API group these calls
 * reached, so reads report no link and changes fail with a message. The signatures are
 * T3's, so the settings UI compiles unchanged. A Gustaf backend replaces this later.
 */
const unavailable = () =>
  new CloudEnvironmentLinkError({ message: "Cloud linking is not available in Gustaf." });

export const readCloudLinkState: (input: {
  readonly target: CloudLinkTarget;
}) => Effect.Effect<CloudLinkState | null, CloudEnvironmentLinkError, CloudLinkServices> = () =>
  Effect.succeed(null);

export const updateCloudPreferences: (input: {
  readonly target: CloudLinkTarget;
  readonly publishAgentActivity: boolean;
  readonly holdWebhooksWhileOffline?: boolean;
}) => Effect.Effect<CloudLinkState, CloudEnvironmentLinkError, CloudLinkServices> = () =>
  Effect.fail(unavailable());

export const unlinkEnvironmentFromCloud: (input: {
  readonly target: CloudLinkTarget;
  readonly clerkToken: string | null;
}) => Effect.Effect<
  void,
  CloudEnvironmentLinkError,
  CloudLinkServices | ManagedRelay.ManagedRelayClient
> = () => Effect.fail(unavailable());

export const linkEnvironmentToCloud: (input: {
  readonly target: CloudLinkTarget;
  readonly clerkToken: string;
  readonly mode?: CloudLinkMode;
}) => Effect.Effect<
  void,
  CloudEnvironmentLinkError,
  CloudLinkServices | ManagedRelay.ManagedRelayClient
> = () => Effect.fail(unavailable());
