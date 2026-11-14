import { type ComputerUseErrorCode, WS_METHODS } from "@t3tools/contracts";
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
