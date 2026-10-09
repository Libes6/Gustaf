import { AntigravityError } from "./antigravitySession";

// The seam of the managed Antigravity runtime install. The download itself is NOT implemented yet: it needs the owner's
// explicit, user-confirmed download from the ACP registry URLs (github.com/agentclientprotocol/registry, antigravity-acp).
// Until then the settings page shows the facts below and the user installs the agent by hand (docs/features/antigravity.md).

/** Version and size of the registry entry (darwin-aarch64 archive). */
export const RUNTIME_VERSION = "1.3.0";
export const RUNTIME_SIZE_MB = 317;
export const RUNTIME_PLATFORM = "darwin-aarch64";
/** False until `installRuntime` really installs; the UI disables the button on it. */
export const RUNTIME_INSTALL_AVAILABLE = false;

export type InstallProgress = { phase: "download" | "extract" | "verify"; received: number; total: number };

/** Installs the managed runtime and returns the path of the executable. Not implemented: always throws. */
export async function installRuntime(_onProgress?: (p: InstallProgress) => void): Promise<string> {
  throw new AntigravityError("unavailable", "Managed install is not available yet. Install the agent manually.");
}
