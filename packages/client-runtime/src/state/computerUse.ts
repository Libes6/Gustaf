import {
  type ComputerUseErrorCode,
  type ComputerUsePermission,
  type ComputerUseStatus,
  WS_METHODS,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Control of the Mac an environment runs on. Web and mobile share these. */
export function createComputerUseEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    status: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:computer-use:status",
      tag: WS_METHODS.subscribeComputerUseStatus,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer-use:refresh",
      tag: WS_METHODS.computerUseStatus,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer-use:set-enabled",
      tag: WS_METHODS.computerUseSetEnabled,
      scheduler,
      concurrency,
    }),
    openPermissionSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer-use:open-permission-settings",
      tag: WS_METHODS.computerUseOpenPermissionSettings,
    }),
    allowThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer-use:allow-thread",
      tag: WS_METHODS.computerUseAllowThread,
      scheduler,
      concurrency,
    }),
    // Not serialized behind other commands: Stop must never wait.
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer-use:stop",
      tag: WS_METHODS.computerUseStop,
    }),
  };
}

/** Refusals a person can act on, by the code both clients translate. */
export function computerUseErrorCode(error: unknown): ComputerUseErrorCode | null {
  return typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ComputerUseError" &&
    "code" in error &&
    typeof error.code === "string"
    ? (error.code as ComputerUseErrorCode)
    : null;
}

/** What the thread's Control Mac panel asks of the person next. */
export type ComputerUseStep =
  | { readonly kind: "unsupported" }
  /** `confirmOnMac`: the feature is off, so allowing turns it on, which the person at the Mac confirms. */
  | { readonly kind: "allow"; readonly confirmOnMac: boolean }
  | { readonly kind: "grant"; readonly missing: ReadonlyArray<ComputerUsePermission> }
  /** The shell could not ask macOS; that says nothing about whether permissions are granted. */
  | { readonly kind: "check-failed" }
  | { readonly kind: "active"; readonly here: boolean; readonly label: string };

export function computerUseStep(
  status: ComputerUseStatus,
  environmentId: string,
  threadId: string,
): ComputerUseStep {
  switch (status.availability) {
    case "unsupported":
      return { kind: "unsupported" };
    case "disabled":
      return { kind: "allow", confirmOnMac: true };
    case "ready":
      return { kind: "allow", confirmOnMac: false };
    case "permissions-required": {
      const missing: ComputerUsePermission[] = [];
      if (status.permissions?.screenRecording === false) missing.push("screen-recording");
      if (status.permissions?.accessibility === false) missing.push("accessibility");
      return missing.length === 0 ? { kind: "check-failed" } : { kind: "grant", missing };
    }
    case "active": {
      const owner = status.owner;
      return {
        kind: "active",
        here: owner?.environmentId === environmentId && owner.threadId === threadId,
        label: owner?.label ?? "",
      };
    }
  }
}
