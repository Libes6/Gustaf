import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";

const { readChromiumLocalStorage } = vi.hoisted(() => ({ readChromiumLocalStorage: vi.fn() }));
vi.mock("./chromiumLocalStorage.ts", () => ({ readChromiumLocalStorage }));

const MARKER = "legacy-origin-local-storage-imported";

const withProfiles = <A, E>(
  use: (input: {
    readonly userData: string;
    readonly seed: (profile: string) => Effect.Effect<string>;
    readonly service: DesktopLegacyLocalStorage.DesktopLegacyLocalStorage["Service"];
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appData = yield* fs.makeTempDirectoryScoped({ prefix: "gustaf-legacy-storage-" });
    const seed = (profile: string) =>
      Effect.gen(function* () {
        const directory = path.join(appData, profile, "Local Storage", "leveldb");
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(path.join(directory, "000003.log"), "x");
        return directory;
      }).pipe(Effect.orDie);
    const environment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      appDataDirectory: appData,
      isDevelopment: false,
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
    return yield* Effect.gen(function* () {
      const service = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage;
      return yield* use({ userData: path.join(appData, "gustaf-electron"), seed, service });
    }).pipe(Effect.provide(Layer.provide(DesktopLegacyLocalStorage.layer, environment)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect(
  "reads the t3code origin from V1 and the profile's own earlier data, newest winning",
  () =>
    withProfiles(({ userData, seed, service }) =>
      Effect.gen(function* () {
        const v1 = yield* seed("T3 Code (Alpha)");
        yield* seed("gustaf-electron");
        readChromiumLocalStorage.mockImplementation((directory: string, origin: string) =>
          Effect.succeed(
            origin !== "t3code://app"
              ? new Map()
              : directory === v1
                ? new Map([
                    ["t3code:theme", "light"],
                    ["t3code:last-editor", "zed"],
                  ])
                : new Map([["t3code:theme", "dark"]]),
          ),
        );
        yield* service.load(userData);
        const items = yield* service.take;
        assert.deepEqual(Option.getOrNull(items), {
          "t3code:theme": "dark",
          "t3code:last-editor": "zed",
        });
        assert.isTrue(
          readChromiumLocalStorage.mock.calls.every(([, origin]) => origin === "t3code://app"),
        );
        yield* service.complete;
      }),
    ),
);

it.effect("records completion so later launches skip the import", () =>
  withProfiles(({ userData, seed, service }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(userData, { recursive: true });
      yield* seed("gustaf-electron");
      readChromiumLocalStorage.mockReturnValue(Effect.succeed(new Map([["a", "b"]])));
      yield* service.load(userData);
      yield* service.complete;
      assert.isTrue(yield* fs.exists(path.join(userData, MARKER)));
      readChromiumLocalStorage.mockClear();
      yield* service.load(userData);
      assert.equal(readChromiumLocalStorage.mock.calls.length, 0);
    }),
  ),
);

it.effect("imports nothing and retries next launch when a source cannot be read", () =>
  withProfiles(({ userData, seed, service }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(userData, { recursive: true });
      yield* seed("T3 Code (Alpha)");
      yield* seed("gustaf-electron");
      readChromiumLocalStorage.mockImplementation((directory: string) =>
        directory.includes("gustaf-electron")
          ? Effect.fail("database changed while reading")
          : Effect.succeed(new Map([["a", "b"]])),
      );
      yield* service.load(userData);
      assert.isTrue(Option.isNone(yield* service.take));
      assert.isFalse(yield* fs.exists(path.join(userData, MARKER)));
    }),
  ),
);
