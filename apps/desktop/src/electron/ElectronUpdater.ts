// @effect-diagnostics nodeBuiltinImport:off -- Starts the detached install helper, which must outlive this process.
import * as NodeChildProcess from "node:child_process";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Electron from "electron";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { GustafUpdater, type UpdateFeed } from "../updates/GustafUpdater.ts";

export type ElectronUpdaterFeed = UpdateFeed;

export class ElectronUpdaterFeedError extends Schema.TaggedError<ElectronUpdaterFeedError>()(
  "ElectronUpdaterFeedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The update feed or its signing key is not usable.";
  }
}

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const detail = this.cause instanceof Error ? ` ${this.cause.message}` : "";
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).${detail}`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (
      feed: ElectronUpdaterFeed,
    ) => Effect.Effect<void, ElectronUpdaterFeedError>;
    // The setters below are the contract DesktopUpdates was written against; Gustaf's feed has one
    // stable track and downloads whole files, so they accept and ignore their values.
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronUpdater") {}

const runToCompletion = (command: string, args: ReadonlyArray<string>) =>
  new Promise<void>((resolve, reject) => {
    NodeChildProcess.execFile(command, [...args], (error) => (error ? reject(error) : resolve()));
  });

const spawnDetached = (command: string, args: ReadonlyArray<string>) => {
  const child = NodeChildProcess.spawn(command, [...args], { detached: true, stdio: "ignore" });
  // A start failure arrives as an event; unhandled, it would crash the quitting app.
  child.once("error", () => undefined);
  child.unref();
};

const makeUpdater = (platform: NodeJS.Platform, arch: string) =>
  new GustafUpdater({
    platform,
    arch,
    pid: process.pid,
    execPath: process.execPath,
    // net.fetch follows the system proxy settings, which Node's fetch ignores.
    fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      Electron.net.fetch(input as string, init as RequestInit)) as typeof fetch,
    spawnDetached,
    run: runToCompletion,
    quit: () => Electron.app.quit(),
  });

/** @public */
export const makeWith = (updater: GustafUpdater) =>
  ElectronUpdater.of({
    setFeedURL: Effect.fn("ElectronUpdater.setFeedURL")(function (feed) {
      return Effect.try({
        try: () => updater.configure(feed),
        catch: (cause) => new ElectronUpdaterFeedError({ cause }),
      });
    }),
    setAutoDownload: Effect.fn("ElectronUpdater.setAutoDownload")(function () {
      return Effect.void;
    }),
    setAutoInstallOnAppQuit: Effect.fn("ElectronUpdater.setAutoInstallOnAppQuit")(function () {
      return Effect.void;
    }),
    setChannel: Effect.fn("ElectronUpdater.setChannel")(function () {
      return Effect.void;
    }),
    setAllowPrerelease: Effect.fn("ElectronUpdater.setAllowPrerelease")(function () {
      return Effect.void;
    }),
    allowDowngrade: Effect.sync(() => updater.allowDowngrade),
    setAllowDowngrade: Effect.fn("ElectronUpdater.setAllowDowngrade")(function (value) {
      return Effect.sync(() => {
        updater.allowDowngrade = value;
      });
    }),
    setFullChangelog: Effect.fn("ElectronUpdater.setFullChangelog")(function () {
      return Effect.void;
    }),
    setDisableDifferentialDownload: Effect.fn("ElectronUpdater.setDisableDifferentialDownload")(
      function () {
        return Effect.void;
      },
    ),
    checkForUpdates: Effect.tryPromise({
      try: () => updater.checkForUpdates(),
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel: null, cause }),
    }).pipe(Effect.asVoid),
    downloadUpdate: Effect.tryPromise({
      try: () => updater.downloadUpdate(),
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel: null, cause }),
    }),
    quitAndInstall: Effect.fn("ElectronUpdater.quitAndInstall")(function ({
      isSilent,
      isForceRunAfter,
    }) {
      return Effect.try({
        try: () => updater.quitAndInstall(isSilent, isForceRunAfter),
        catch: (cause) =>
          new ElectronUpdaterQuitAndInstallError({
            channel: null,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      });
    }),
    on: Effect.fn("ElectronUpdater.on")(function (eventName, listener) {
      const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          updater.on(eventName, untypedListener);
        }),
        () =>
          Effect.sync(() => {
            updater.removeListener(eventName, untypedListener);
          }),
      ).pipe(Effect.asVoid);
    }),
  });

export const layer = Layer.effect(
  ElectronUpdater,
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    return makeWith(makeUpdater(platform, arch));
  }),
);
