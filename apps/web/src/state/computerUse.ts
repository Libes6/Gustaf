import { createComputerUseEnvironmentAtoms } from "@t3tools/client-runtime/state/computerUse";
import type { ComputerUseStatus, EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const computerUseEnvironment = createComputerUseEnvironmentAtoms(connectionAtomRuntime);

export function useComputerUseStatus(environmentId: EnvironmentId): ComputerUseStatus | null {
  return useEnvironmentQuery(computerUseEnvironment.status({ environmentId, input: {} })).data;
}
