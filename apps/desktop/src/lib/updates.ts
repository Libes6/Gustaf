/** Never claim 'up to date' without a successful check. */
export type UpdateStatus =
  | { kind: "disabled"; reason: string }
  | { kind: "idle" | "checking" | "current" }
  | {
      kind: "available" | "downloading" | "downloaded" | "installing";
      version: string;
      notes?: string;
      received?: number;
      total?: number;
    }
  | { kind: "error"; error: string; category: "network" | "signature" | "other" };
/** Signed transport contract: download verifies the native signature before resolving; install applies it and relaunches. */
export type SignedUpdate = {
  version: string;
  notes?: string;
  download: (progress: (received: number, total?: number) => void) => Promise<void>;
  install: () => Promise<void>;
  close?: () => Promise<void>;
};
export type UpdateTransport = { check: () => Promise<SignedUpdate | null> };
export const UPDATES_DISABLED = "Signed update endpoint and public key are not configured for this build.";
export function updateError(error: unknown): Extract<UpdateStatus, { kind: "error" }> {
  const message = String(error);
  const category = /signature|public.?key|minisign|verification/i.test(message)
    ? "signature"
    : /network|offline|timeout|timed out|connect|dns|fetch|request|resolve host/i.test(message)
      ? "network"
      : "other";
  return { kind: "error", error: message, category };
}
export class UpdateController {
  status: UpdateStatus;
  private update: SignedUpdate | null = null;
  private busy = false;
  private transport?: UpdateTransport;
  private changed: (s: UpdateStatus) => void;
  constructor(transport?: UpdateTransport, changed: (s: UpdateStatus) => void = () => {}) {
    this.transport = transport;
    this.changed = changed;
    this.status = transport ? { kind: "idle" } : { kind: "disabled", reason: UPDATES_DISABLED };
  }
  private set(status: UpdateStatus) {
    this.status = status;
    this.changed(status);
  }
  async check() {
    if (!this.transport || this.busy) return;
    this.busy = true;
    this.set({ kind: "checking" });
    try {
      await this.update?.close?.();
      this.update = null;
      this.update = await this.transport.check();
      this.set(
        this.update
          ? { kind: "available", version: this.update.version, notes: this.update.notes }
          : { kind: "current" },
      );
    } catch (e) {
      this.set(updateError(e));
    } finally {
      this.busy = false;
    }
  }
  async download() {
    if (this.busy || !this.update || this.status.kind !== "available") return;
    this.busy = true;
    const update = this.update;
    this.set({ kind: "downloading", version: update.version, notes: update.notes });
    try {
      await update.download((received, total) =>
        this.set({ kind: "downloading", version: update.version, notes: update.notes, received, total }),
      );
      this.set({ kind: "downloaded", version: update.version, notes: update.notes });
    } catch (e) {
      this.set(updateError(e));
    } finally {
      this.busy = false;
    }
  }
  async install() {
    if (this.busy || !this.update || this.status.kind !== "downloaded") return;
    this.busy = true;
    this.set({ kind: "installing", version: this.update.version });
    try {
      await this.update.install();
    } catch (e) {
      this.set(updateError(e));
      this.busy = false;
    }
  }
}

/** Backend enables the plugin only for a build with a public key and HTTPS endpoints. No runtime URL/key overrides. */
export async function configuredUpdateTransport(): Promise<UpdateTransport | undefined> {
  const { invoke } = await import("@tauri-apps/api/core");
  if (!(await invoke<boolean>("updater_configured"))) return undefined;
  return {
    async check() {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check({ timeout: 15_000 });
      if (!update) return null;
      return {
        version: update.version,
        notes: update.body,
        close: () => update.close(),
        async download(progress) {
          let received = 0;
          let total: number | undefined;
          // The native plugin rejects the promise if signature verification fails.
          await update.download(
            (event) => {
              if (event.event === "Started") {
                total = event.data.contentLength;
                progress(0, total);
              } else if (event.event === "Progress") {
                received += event.data.chunkLength;
                progress(received, total);
              }
            },
            { timeout: 120_000 },
          );
        },
        async install() {
          await update.install();
          // Agents end gracefully before the relaunch (bounded; see lib/agentShutdown.ts).
          const { shutdownAgents } = await import("./agentShutdown");
          await shutdownAgents();
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
        },
      };
    },
  };
}
