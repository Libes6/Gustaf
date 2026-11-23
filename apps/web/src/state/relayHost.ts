import { createRelayHostAtoms } from "@t3tools/client-runtime/state/relayHost";

import { connectionAtomRuntime } from "../connection/runtime";

export const relayHostEnvironment = createRelayHostAtoms(connectionAtomRuntime);
