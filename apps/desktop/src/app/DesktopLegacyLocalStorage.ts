import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import { readChromiumLocalStorage } from "./chromiumLocalStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/**
 * Brings Local Storage written under the `t3code://app` origin into `gustaf://app`: the V1 profile,
 * and this profile's own data from before the scheme changed. Reads without opening either in Chromium.
 */
export class DesktopLegacyLocalStorage extends Context.Service<
  DesktopLegacyLocalStorage,
  {
    readonly load: (userDataPath: string) => Effect.Effect<void>;
    readonly take: Effect.Effect<Option.Option<Readonly<Record<string, string>>>>;
    readonly complete: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopLegacyLocalStorage") {}

const MARKER_FILE_NAME = "legacy-origin-local-storage-imported";
const V1_PROFILE_NAMES = ["T3 Code (Alpha)", "t3code"];

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const items = yield* Ref.make(Option.none<Readonly<Record<string, string>>>());
  const markerPath = yield* Ref.make(Option.none<string>());

  /** Newest file mtime in a directory; appending to a log leaves the directory's own mtime alone. */
  const newestFileMtime = Effect.fn("DesktopLegacyLocalStorage.newestFileMtime")(
    function* (directory: string) {
      let newest = 0;
      for (const name of yield* fs.readDirectory(directory)) {
        const info = yield* fs.stat(path.join(directory, name)).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        const mtime = Option.match(info.value.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        });
        newest = Math.max(newest, mtime);
      }
      return newest;
    },
    (effect, _directory) => effect.pipe(Effect.option),
  );

  const findV1LocalStorage = Effect.gen(function* () {
    let newest: { readonly directory: string; readonly mtime: number } | null = null;
    for (const name of V1_PROFILE_NAMES) {
      const directory = path.join(environment.appDataDirectory, name, "Local Storage", "leveldb");
      const mtime = yield* newestFileMtime(directory);
      if (Option.isNone(mtime)) continue;
      if (newest === null || mtime.value > newest.mtime) newest = { directory, mtime: mtime.value };
    }
    return newest?.directory ?? null;
  });

  /** Oldest first, so the profile's own data wins over V1 for any key both hold. */
  const findLegacySources = Effect.fn("DesktopLegacyLocalStorage.findLegacySources")(function* (
    userDataPath: string,
  ) {
    const own = path.join(userDataPath, "Local Storage", "leveldb");
    const v1 = yield* findV1LocalStorage;
    return [
      ...(v1 === null ? [] : [v1]),
      ...(Option.isSome(yield* newestFileMtime(own)) ? [own] : []),
    ];
  });

  const writeMarker = Effect.gen(function* () {
    const marker = yield* Ref.get(markerPath);
    if (Option.isNone(marker)) return;
    yield* fs
      .writeFileString(marker.value, "")
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not record the V1 Local Storage import", error),
        ),
      );
  });

  const load = Effect.fn("desktop.legacyLocalStorage.load")(function* (userDataPath: string) {
    if (environment.isDevelopment) return;
    const marker = path.join(userDataPath, MARKER_FILE_NAME);
    if (yield* fs.exists(marker).pipe(Effect.orElseSucceed(() => true))) return;
    yield* Ref.set(markerPath, Option.some(marker));
    const directories = yield* findLegacySources(userDataPath);
    if (directories.length === 0) return yield* writeMarker;
    const origin = ElectronProtocol.LEGACY_RENDERER_ORIGIN;
    const merged: Record<string, string> = {};
    for (const directory of directories) {
      const read = yield* readChromiumLocalStorage(directory, origin).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.tapError((error) =>
          Effect.logWarning("Could not read legacy Local Storage; will retry next launch", error),
        ),
        Effect.option,
      );
      // A partial import would be marked complete, so any unreadable source waits for the next launch.
      if (Option.isNone(read)) return;
      Object.assign(merged, Object.fromEntries(read.value));
    }
    yield* Effect.logInfo("Legacy Local Storage ready to import", {
      directories,
      keys: Object.keys(merged).length,
    });
    yield* Ref.set(items, Option.some(merged));
  });

  return DesktopLegacyLocalStorage.of({
    load,
    take: Ref.getAndSet(items, Option.none()),
    complete: writeMarker,
  });
});

export const layer = Layer.effect(DesktopLegacyLocalStorage, make);
