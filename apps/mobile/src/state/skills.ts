import { createSkillsEnvironmentAtoms } from "@t3tools/client-runtime/state/skills";
import type { EnvironmentId, SharedSkill } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentServerConfig } from "./entities";
import { useEnvironmentQuery } from "./query";

const skillsEnvironment = createSkillsEnvironmentAtoms(connectionAtomRuntime);

/** The shared skills a composer in `cwd` offers; none from a server too old to run them. */
export function useSharedSkills(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): ReadonlyArray<SharedSkill> | undefined {
  const supported = useEnvironmentServerConfig(environmentId)?.sharedSkills === true;
  const query = useEnvironmentQuery(
    supported && environmentId !== null
      ? skillsEnvironment.list({ environmentId, input: cwd ? { cwd } : {} })
      : null,
  );
  return query.data?.skills;
}
