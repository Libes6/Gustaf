import {
  type ComputerUseEndReason,
  type ComputerUseErrorCode,
  type ComputerUsePermission,
  type ComputerUseStatus,
  WS_METHODS,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { formatConjunctionList } from "../listFormat.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Control of the Mac an environment runs on. Web and mobile share these. The executor lives with
 * the environment's host, so every command and status here is about that machine, whichever
 * device the client runs on.
 */
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

/** What a person can read off a refusal; anything unlisted is a plain "try again". */
export function computerUseErrorMessage(
  error: unknown,
  resolve: MFunctionType = mFallback,
): string {
  switch (computerUseErrorCode(error)) {
    case "busy":
      return resolve(msg("The Mac is already controlled by another thread. Stop it first."));
    case "declined":
      return resolve(msg("The person at the Mac did not allow it."));
    case "permission-required":
      return resolve(msg("Gustaf lacks a macOS permission on the Mac."));
    case "disabled":
      return resolve(msg("Control is turned off on the Mac. Try again."));
    case "emergency-stop-unavailable":
      return resolve(
        msg("The emergency stop shortcut could not be set up, so control did not start."),
      );
    case "unsupported":
      return resolve(msg("Not available in this environment."));
    default:
      return resolve(msg("Something went wrong. Try again."));
  }
}

export function computerUseEndReasonLabel(
  reason: ComputerUseEndReason,
  resolve: MFunctionType = mFallback,
): string {
  switch (reason) {
    case "stopped-by-user":
      return resolve(msg("Last stopped: by the user."));
    case "emergency-shortcut":
      return resolve(msg("Last stopped: with the emergency shortcut."));
    case "stopped-by-owner":
      return resolve(msg("Last stopped: by the agent."));
    case "connection-lost":
      return resolve(msg("Last stopped: the connection was lost."));
    case "permission-revoked":
      return resolve(msg("Last stopped: a macOS permission was turned off."));
    case "disabled":
      return resolve(msg("Last stopped: control was turned off."));
    case "app-quit":
      return resolve(msg("Last stopped: Gustaf quit."));
  }
}

export function computerUsePermissionLabel(
  permission: ComputerUsePermission,
  resolve: MFunctionType = mFallback,
): string {
  return permission === "screen-recording"
    ? resolve(msg("Screen Recording"))
    : resolve(msg("Accessibility"));
}

/** Which permissions macOS has not granted; null when the executor could not ask. */
export function computerUseMissingPermissions(
  status: ComputerUseStatus,
): ReadonlyArray<ComputerUsePermission> | null {
  if (status.permissions === undefined) return null;
  const missing: ComputerUsePermission[] = [];
  if (!status.permissions.screenRecording) missing.push("screen-recording");
  if (!status.permissions.accessibility) missing.push("accessibility");
  return missing;
}

/** The providers whose runtime shows tool screenshots to the model, which control needs. */
export function computerUseProviderList(
  locale: string,
  resolve: MFunctionType = mFallback,
): string {
  return formatConjunctionList(["Claude", "Codex", "OpenCode", "Pi"], locale, resolve);
}

/** The feature is on at the Mac: an executor exists and the person there has not turned it off. */
export function computerUseIsOn(status: ComputerUseStatus): boolean {
  return status.availability !== "unsupported" && status.availability !== "disabled";
}

export type ComputerUseHolder = "none" | "this-thread" | "other";

/** Who controls the Mac, from the point of view of one thread. */
export function computerUseHolder(
  status: ComputerUseStatus,
  environmentId: string,
  threadId: string,
): ComputerUseHolder {
  const owner = status.owner;
  if (owner === undefined) return "none";
  return owner.environmentId === environmentId && owner.threadId === threadId
    ? "this-thread"
    : "other";
}

/** The shortcut only exists where there is an executor; an empty one is not worth a sentence. */
export function computerUseHasStopShortcut(status: ComputerUseStatus): boolean {
  return status.emergencyShortcut !== "";
}

/** What the thread's Control Mac panel asks of the person next. */
export type ComputerUseStep =
  | { readonly kind: "unsupported" }
  /** `confirmOnMac`: the feature is off, so allowing turns it on, which the person at the Mac confirms. */
  | { readonly kind: "allow"; readonly confirmOnMac: boolean }
  | { readonly kind: "grant"; readonly missing: ReadonlyArray<ComputerUsePermission> }
  /** The executor could not ask macOS; that says nothing about whether permissions are granted. */
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
      const missing = computerUseMissingPermissions(status);
      return missing === null || missing.length === 0
        ? { kind: "check-failed" }
        : { kind: "grant", missing };
    }
    case "active":
      return {
        kind: "active",
        here: computerUseHolder(status, environmentId, threadId) === "this-thread",
        label: status.owner?.label ?? "",
      };
  }
}
