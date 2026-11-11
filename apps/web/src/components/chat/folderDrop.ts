import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isLoopbackHostname } from "~/environments/primary/target";

export function folderDropTarget(input: {
  localEnvironmentDisabled: boolean;
  environmentId: EnvironmentId;
  primaryEnvironmentId: EnvironmentId | null;
  connection: Pick<PreparedConnection, "target" | "httpBaseUrl"> | null;
  isDesktopRenderer: boolean;
}): "local" | "remote" {
  if (
    !input.localEnvironmentDisabled &&
    input.primaryEnvironmentId !== null &&
    input.environmentId === input.primaryEnvironmentId
  ) {
    return "local";
  }
  return input.isDesktopRenderer &&
    input.connection !== null &&
    isSavedLoopbackConnection(input.connection)
    ? "local"
    : "remote";
}

// A direct saved connection to loopback shares the desktop's filesystem; WSL backends and SSH forwards do not.
function isSavedLoopbackConnection({
  target,
  httpBaseUrl,
}: Pick<PreparedConnection, "target" | "httpBaseUrl">): boolean {
  if (target._tag !== "BearerConnectionTarget" || isDesktopLocalConnectionTarget(target)) {
    return false;
  }
  try {
    return isLoopbackHostname(new URL(httpBaseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The Gustaf shell cannot read a path off a `File`, so it reports what the drag carried.
 * A folder is matched by name; two dragged folders with one name stay unresolved.
 */
export function matchDroppedFolderPath(
  folder: Pick<File, "name">,
  droppedPaths: readonly string[],
): string | null {
  const matches = droppedPaths.filter(
    (path) =>
      path
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .at(-1) === folder.name,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function resolveDroppedFolderPath(
  folder: File,
  getPathForFile: ((file: File) => string) | undefined,
): string | null {
  const path = getPathForFile?.(folder);
  return typeof path === "string" && path.length > 0 ? path : null;
}
