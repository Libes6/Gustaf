import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

const GUSTAF_DATA_DIR_ID = "io.github.libes6.gustaf";

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
  readonly platform?: NodeJS.Platform;
  readonly localAppDataDirectory?: Option.Option<string>;
  readonly xdgDataHome?: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () => {
    if (input.platform === "darwin") {
      return input.joinPath(
        input.homeDirectory,
        "Library",
        "Application Support",
        GUSTAF_DATA_DIR_ID,
      );
    }
    if (input.platform === "win32") {
      const localAppData = Option.getOrElse(input.localAppDataDirectory ?? Option.none(), () =>
        input.joinPath(input.homeDirectory, "AppData", "Local"),
      );
      return input.joinPath(localAppData, GUSTAF_DATA_DIR_ID);
    }
    const xdgDataHome = Option.getOrElse(input.xdgDataHome ?? Option.none(), () =>
      input.joinPath(input.homeDirectory, ".local", "share"),
    );
    return input.joinPath(xdgDataHome, GUSTAF_DATA_DIR_ID);
  });
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
