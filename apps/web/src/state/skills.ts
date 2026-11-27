import { createSkillsEnvironmentAtoms } from "@t3tools/client-runtime/state/skills";
import type { EnvironmentId, SharedSkill } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";

export const skillsEnvironment = createSkillsEnvironmentAtoms(connectionAtomRuntime);

/** The shared skills a composer in `cwd` offers; none from a server too old to run them. */
export function useSharedSkills(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): { readonly skills: ReadonlyArray<SharedSkill> | undefined; readonly refresh: () => void } {
  const configs = useServerConfigs();
  const supported = environmentId !== null && configs.get(environmentId)?.sharedSkills === true;
  const query = useEnvironmentQuery(
    supported ? skillsEnvironment.list({ environmentId, input: cwd ? { cwd } : {} }) : null,
  );
  return { skills: query.data?.skills, refresh: query.refresh };
}
