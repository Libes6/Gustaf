import * as Schema from "effect/Schema";

export const GustafCloudUserSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
});
export type GustafCloudUser = typeof GustafCloudUserSchema.Type;

export const GustafAccountStateSchema = Schema.Struct({
  signedIn: Schema.Boolean,
  user: Schema.NullOr(GustafCloudUserSchema),
  expiresAt: Schema.NullOr(Schema.String),
  deviceId: Schema.NullOr(Schema.String),
});
export type GustafAccountState = typeof GustafAccountStateSchema.Type;

export const GustafAccountDeviceSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  createdAt: Schema.String,
  lastSeenAt: Schema.NullOr(Schema.String),
  current: Schema.Boolean,
});
export type GustafAccountDevice = typeof GustafAccountDeviceSchema.Type;

export const GustafRelayClientCredentialSchema = Schema.Struct({
  deviceId: Schema.String,
  deviceToken: Schema.String,
  deviceName: Schema.String,
});
export type GustafRelayClientCredential = typeof GustafRelayClientCredentialSchema.Type;

export const GustafReportProblemInputSchema = Schema.Struct({
  message: Schema.String,
  attachLogs: Schema.Boolean,
});
export type GustafReportProblemInput = typeof GustafReportProblemInputSchema.Type;

export const GustafRelayClientStorageSetInputSchema = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
});
export type GustafRelayClientStorageSetInput = typeof GustafRelayClientStorageSetInputSchema.Type;

export interface DesktopGustafRelayClientBridge {
  readonly credential: () => Promise<GustafRelayClientCredential>;
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
}

export interface DesktopGustafAccountBridge {
  readonly getState: () => Promise<GustafAccountState>;
  readonly signIn: () => Promise<GustafAccountState>;
  readonly cancelSignIn: () => Promise<void>;
  readonly signOut: () => Promise<GustafAccountState>;
  readonly listDevices: () => Promise<readonly GustafAccountDevice[]>;
  readonly registerThisComputer: () => Promise<GustafAccountState>;
  readonly revokeDevice: (deviceId: string) => Promise<GustafAccountState>;
  readonly reportProblem: (report: GustafReportProblemInput) => Promise<void>;
  readonly relayClient: DesktopGustafRelayClientBridge;
  readonly clientConfig: () => Promise<unknown>;
}
