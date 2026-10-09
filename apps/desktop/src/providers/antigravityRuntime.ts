import { Channel, invoke } from "@tauri-apps/api/core";

// The managed Antigravity runtime: Google's ACP agent downloaded by the Rust side (src-tauri/src/antigravity_runtime.rs)
// into `<app data>/antigravity-runtime/<version>/`, only after the user clicked Install and confirmed the dialog. This
// file is the typed seam to those commands; the UI and the provider never touch the network or the folder themselves.
// Docs: docs/features/antigravity.md.

/** The one version this build can install (pinned in Rust; a newer pin shows up as "update available"). */
export const RUNTIME_VERSION = "1.3.0";
/** Google's terms for the Antigravity software; the confirmation dialog links here. */
export const ANTIGRAVITY_TERMS_URL = "https://antigravity.google/terms";

export type InstallProgress = { phase: "download" | "extract" | "verify"; received: number; total: number };

export type InstalledRuntime = {
  version: string;
  executable: string;
  dir: string;
  /** Why the files no longer match the install manifest; absent when they do. */
  modified?: string | null;
};

export type RuntimeStatus = {
  /** False on platforms without a managed archive (Intel Mac, FreeBSD...). `reason` says why. */
  supported: boolean;
  reason?: "intel-mac" | "platform" | null;
  version: string;
  archiveBytes: number;
  unpackedBytes: number;
  /** Download address without a query string. */
  source: string;
  /** Where the runtime would be installed. */
  folder: string;
  installed?: InstalledRuntime | null;
  updateAvailable: boolean;
  busy: boolean;
};

export type RuntimeErrorCode =
  | "unsupported"
  | "intel-mac"
  | "platform"
  | "busy"
  | "no-space"
  | "offline"
  | "network"
  | "http"
  | "redirect"
  | "size"
  | "hash"
  | "bad-archive"
  | "verify"
  | "cancelled"
  | "in-use"
  | "io"
  | "internal";

/** Typed failure of an install or removal; `message` is the English detail from Rust (URLs without query only). */
export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

function asRuntimeError(e: unknown): RuntimeError {
  if (e instanceof RuntimeError) return e;
  const o = e as { code?: unknown; message?: unknown } | string | null;
  if (o && typeof o === "object" && typeof o.code === "string")
    return new RuntimeError(o.code as RuntimeErrorCode, String(o.message ?? o.code));
  return new RuntimeError("internal", typeof o === "string" ? o : String((o as Error)?.message ?? e));
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw asRuntimeError(e);
  }
}

/** Platform support, what is installed and whether an update is pinned. `deep` re-hashes the files (a second or two). */
export function runtimeStatus(deep = false): Promise<RuntimeStatus> {
  return call<RuntimeStatus>("antigravity_runtime_status", { deep });
}

/**
 * Downloads, verifies, unpacks and probes the pinned runtime and returns the path of its executable. The caller must
 * have shown the confirmation dialog; nothing else may call this. Rejects with a `RuntimeError` (`cancelled` after
 * `cancelRuntimeInstall`).
 */
export async function installRuntime(onProgress?: (p: InstallProgress) => void): Promise<string> {
  const events = new Channel<InstallProgress>();
  events.onmessage = (p) => onProgress?.(p);
  const done = await call<InstalledRuntime>("antigravity_runtime_install", { events });
  return done.executable;
}

/** Stops a running install; the partial download is removed. A no-op when nothing runs. */
export function cancelRuntimeInstall(): Promise<void> {
  return call<void>("antigravity_runtime_cancel");
}

/** Deletes the managed runtime. Rejects with `in-use` while a session uses it or a Binary path points inside it. */
export function removeRuntime(o: { inUse: boolean; protectedPaths: string[] }): Promise<void> {
  return call<void>("antigravity_runtime_remove", { inUse: o.inUse, protectedPaths: o.protectedPaths });
}

/** The managed executable (installed and unmodified in size), or undefined. Never throws. */
export async function managedExecutable(): Promise<string | undefined> {
  try {
    return (await call<string | null>("antigravity_runtime_resolve")) ?? undefined;
  } catch {
    return undefined;
  }
}
