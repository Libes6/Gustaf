import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A phone this computer allowed to connect through the Gustaf relay. */
export const RelayHostDevice = Schema.Struct({
  /** The device's Noise static key, base64url; identifies it to this computer. */
  key: TrimmedNonEmptyString,
  name: Schema.String,
  approvedAt: Schema.String,
  /** Compare with the code the phone shows to rule out a relay in the middle. */
  safetyCode: Schema.String,
});
export type RelayHostDevice = typeof RelayHostDevice.Type;

/** A device that scanned this computer's QR code and waits for the user's answer. */
export const RelayHostPendingDevice = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  requestedAt: Schema.String,
  safetyCode: Schema.String,
});
export type RelayHostPendingDevice = typeof RelayHostPendingDevice.Type;

export const RelayHostConnection = Schema.Literals([
  "disabled",
  "connecting",
  "online",
  "offline",
  "unauthorized",
]);
export type RelayHostConnection = typeof RelayHostConnection.Type;

export const RelayHostPairingOffer = Schema.Struct({
  /** `gustaf://relay-pair?...`, shown as a QR code. */
  link: TrimmedNonEmptyString,
  expiresAt: Schema.String,
});
export type RelayHostPairingOffer = typeof RelayHostPairingOffer.Type;

export const RelayHostStatus = Schema.Struct({
  connection: RelayHostConnection,
  error: Schema.optional(Schema.String),
  relayUrl: Schema.optional(Schema.String),
  deviceId: Schema.optional(Schema.String),
  devices: Schema.Array(RelayHostDevice),
  pending: Schema.Array(RelayHostPendingDevice),
  offer: Schema.optional(RelayHostPairingOffer),
});
export type RelayHostStatus = typeof RelayHostStatus.Type;

/** The desktop shell hands over this computer's cloud device credential. */
export const RelayHostCredentialInput = Schema.Struct({
  relayUrl: TrimmedNonEmptyString,
  deviceId: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
});
export type RelayHostCredentialInput = typeof RelayHostCredentialInput.Type;

export const RelayHostDecisionInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  approve: Schema.Boolean,
});
export type RelayHostDecisionInput = typeof RelayHostDecisionInput.Type;

export const RelayHostRevokeInput = Schema.Struct({ key: TrimmedNonEmptyString });
export type RelayHostRevokeInput = typeof RelayHostRevokeInput.Type;
