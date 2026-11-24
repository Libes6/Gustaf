import { createComputerUseEnvironmentAtoms } from "@t3tools/client-runtime/state/computerUse";
import type { ComputerUseStatus, EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export const computerUseEnvironment = createComputerUseEnvironmentAtoms(connectionAtomRuntime);

export function useComputerUseStatus(environmentId: EnvironmentId): ComputerUseStatus | null {
  return useEnvironmentQuery(computerUseEnvironment.status({ environmentId, input: {} })).data;
}

/** macOS sends no event when a permission is switched on, so ask again while the grant step shows. */
const PERMISSION_RECHECK_MS = 2_000;

export function useComputerUsePermissionRecheck(environmentId: EnvironmentId, waiting: boolean) {
  const refresh = useAtomCommand(computerUseEnvironment.refresh, { reportFailure: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the Mac while the grant step shows, because macOS reports no permission changes
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(
      () => void refresh({ environmentId, input: {} }),
      PERMISSION_RECHECK_MS,
    );
    return () => clearInterval(timer);
  }, [waiting, environmentId, refresh]);
}
