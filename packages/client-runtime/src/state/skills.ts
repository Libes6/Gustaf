import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Shared skills of one environment, and the actions that change them. */
export function createSkillsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Bumped by every change made here, so each open list and composer rereads it.
  const revision = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`environment-data:skills:${environmentId}`)),
  );
  const onSuccess = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.update(revision(target.environmentId), (value) => value + 1));

  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:skills:list",
      tag: WS_METHODS.skillsList,
      // Skills are files that agents and editors change, so a reader mounting lists them again.
      staleTimeMs: 0,
      refreshTrigger: ({ environmentId }) => revision(environmentId),
    }),
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:skills:read",
      tag: WS_METHODS.skillsRead,
      staleTimeMs: 0,
      refreshTrigger: ({ environmentId }) => revision(environmentId),
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:set-enabled",
      tag: WS_METHODS.skillsSetEnabled,
      onSuccess,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:remove",
      tag: WS_METHODS.skillsRemove,
      onSuccess,
    }),
    importSkill: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:skills:import",
      tag: WS_METHODS.skillsImport,
      onSuccess,
    }),
  };
}
