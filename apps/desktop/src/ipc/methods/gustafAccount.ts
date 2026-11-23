import {
  GustafAccountDeviceSchema,
  GustafAccountStateSchema,
  GustafRelayClientCredentialSchema,
  GustafRelayClientStorageSetInputSchema,
  GustafReportProblemInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as GustafAccount from "../../gustaf/GustafAccount.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export const getGustafAccountState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GUSTAF_ACCOUNT_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: GustafAccountStateSchema,
  handler: Effect.fn("desktop.ipc.gustafAccount.getState")(function* () {
    return yield* (yield* GustafAccount.GustafAccount).getState;
  }),
});

export const signInGustafAccount = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GUSTAF_ACCOUNT_SIGN_IN_CHANNEL,
  payload: Schema.Void,
  result: GustafAccountStateSchema,
  handler: Effect.fn("desktop.ipc.gustafAccount.signIn")(function* () {
    return yield* (yield* GustafAccount.GustafAccount).signIn;
  }),
});

export const cancelGustafAccountSignIn = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GUSTAF_ACCOUNT_CANCEL_SIGN_IN_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.gustafAccount.cancelSignIn")(function* () {
    return yield* (yield* GustafAccount.GustafAccount).cancelSignIn;
  }),
});

export const signOutGustafAccount = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GUSTAF_ACCOUNT_SIGN_OUT_CHANNEL,
  payload: Schema.Void,
  result: GustafAccountStateSchema,
  handler: Effect.fn("desktop.ipc.gustafAccount.signOut")(function* () {
    return yield* (yield* GustafAccount.GustafAccount).signOut;
  }),
});

export const listGustafAccountDevices = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GUSTAF_ACCOUNT_LIST_DEVICES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(GustafAccountDeviceSchema),
  handler: Effect.fn("desktop.ipc.gustafAccount.listDevices")(function* () {
    return yield* (yield* GustafAccount.GustafAccount).listDevices;
  }),
});

export const registerGustafComputer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GUSTAF_ACCOUNT_REGISTER_DEVICE_CHANNEL,
  payload: Schema.Void,
  result: GustafAccountStateSchema,
  handler: Effect.fn("desktop.ipc.gustafAccount.registerThisComputer")(function* () {
    return yield* (yield* GustafAccount.GustafAccount).registerThisComputer;
  }),
});

export const revokeGustafAccountDevice = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GUSTAF_ACCOUNT_REVOKE_DEVICE_CHANNEL,
  payload: Schema.String,
  result: GustafAccountStateSchema,
  handler: Effect.fn("desktop.ipc.gustafAccount.revokeDevice")(function* (deviceId) {
    return yield* (yield* GustafAccount.GustafAccount).revokeDevice(deviceId);
  }),
});

export const reportGustafProblem = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GUSTAF_ACCOUNT_REPORT_PROBLEM_CHANNEL,
  payload: GustafReportProblemInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.gustafAccount.reportProblem")(function* (input) {
    return yield* (yield* GustafAccount.GustafAccount).reportProblem(input);
  }),
});

export const getGustafRelayClientCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GUSTAF_RELAY_CLIENT_CREDENTIAL_CHANNEL,
  payload: Schema.Void,
  result: GustafRelayClientCredentialSchema,
  handler: Effect.fn("desktop.ipc.gustafAccount.getRelayClientCredential")(function* () {
    return yield* (yield* GustafAccount.GustafAccount).getRelayClientCredential;
  }),
});

export const getGustafRelayClientStorageItem = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GUSTAF_RELAY_CLIENT_STORAGE_GET_CHANNEL,
  payload: Schema.String,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.gustafAccount.getRelayClientStorageItem")(function* (key) {
    return yield* (yield* GustafAccount.GustafAccount).getRelayClientStorageItem(key);
  }),
});

export const setGustafRelayClientStorageItem = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GUSTAF_RELAY_CLIENT_STORAGE_SET_CHANNEL,
  payload: GustafRelayClientStorageSetInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.gustafAccount.setRelayClientStorageItem")(function* ({
    key,
    value,
  }) {
    return yield* (yield* GustafAccount.GustafAccount).setRelayClientStorageItem(key, value);
  }),
});

export const getGustafClientConfig = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GUSTAF_CLIENT_CONFIG_CHANNEL,
  payload: Schema.Void,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.gustafAccount.getClientConfig")(function* () {
    return yield* (yield* GustafAccount.GustafAccount).getClientConfig;
  }),
});
