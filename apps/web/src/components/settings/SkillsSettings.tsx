import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type SharedSkill,
  SharedSkillError,
  type SharedSkillSource,
  type SkillCompatibilityIssue,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const isSharedSkillError = Schema.is(SharedSkillError);

const ISSUE_LABELS: Record<SkillCompatibilityIssue, string> = {
  "invalid-name": msg("Folder name cannot be typed as a skill"),
  "invalid-frontmatter": msg("Frontmatter cannot be read"),
  "too-large": msg("SKILL.md is too large"),
  "agent-only": msg("For agents only"),
  "claude-arguments": msg("Uses Claude arguments"),
  "claude-shell-commands": msg("Runs commands only in Claude"),
  "claude-fork-context": msg("Forks context only in Claude"),
  "claude-allowed-tools": msg("Tool limits apply only in Claude"),
};

const ERROR_MESSAGES: Record<SharedSkillError["reason"], string> = {
  "not-found": msg("The skill was not found."),
  "already-exists": msg("A skill with this name already exists there."),
  "source-changed": msg("The skill changed after it was previewed. Open it again."),
  "workspace-required": msg("Choose a project for this action."),
  "too-large": msg("The skill folder is too large to copy."),
  filesystem: msg("Gustaf could not read or write the skill files."),
};

const NO_PROJECT = "none";

export function SkillsSettings() {
  const gt = useGT();
  const { environment, scope } = useSettingsScope();
  const configs = useServerConfigs();
  if (!environment || environment.connection.phase !== "connected") {
    return <p>{gt("Connect an environment to manage skills.")}</p>;
  }
  if (configs.get(environment.environmentId)?.sharedSkills !== true) {
    return <p>{gt("Update this environment to use shared skills.")}</p>;
  }
  const scopedMember =
    scope.kind === "project" || scope.kind === "checkout"
      ? scope.members.find((member) => member.environmentId === environment.environmentId)
      : undefined;
  return (
    <SkillsEnvironmentSettings
      key={environment.environmentId}
      environmentId={environment.environmentId}
      scopedCwd={scopedMember?.workspaceRoot}
    />
  );
}

function SkillsEnvironmentSettings({
  environmentId,
  scopedCwd,
}: {
  readonly environmentId: EnvironmentId;
  readonly scopedCwd: string | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [pickedProject, setPickedProject] = useState<string | null>(null);
  const project =
    projects.find((candidate) => candidate.id === pickedProject) ??
    (pickedProject === NO_PROJECT ? undefined : projects[0]);
  const cwd = scopedCwd ?? project?.workspaceRoot;
  const query = useEnvironmentQuery(
    skillsEnvironment.list({
      environmentId,
      input: { ...(cwd ? { cwd } : {}), includeImportable: true },
    }),
  );
  const canWrite = useAtomValue(skillsEnvironment.importSkill.permissionAtom(environmentId));
  const setEnabled = useAtomCommand(skillsEnvironment.setEnabled);
  const remove = useAtomCommand(skillsEnvironment.remove);
  const [opened, setOpened] = useState<SharedSkill | null>(null);

  const skills = query.data?.skills ?? [];
  const importable = query.data?.importable ?? [];

  const removeSkill = async (skill: SharedSkill, location: SharedSkillSource) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      gt("Delete skill “{name}” and its folder?", { name: skill.name }),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    await remove({
      environmentId,
      input: { location, name: skill.name, ...(cwd ? { cwd } : {}) },
    });
  };

  const skillRow = (skill: SharedSkill) => {
    const location =
      skill.location === "project" || skill.location === "global" ? skill.location : null;
    return (
      <SettingsRow
        key={`${skill.location}:${skill.name}`}
        title={skill.name}
        description={skill.description ?? skill.path}
        status={
          skill.issues.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {skill.issues.map((issue) => (
                <Badge key={issue} variant="secondary">
                  {messages(ISSUE_LABELS[issue])}
                </Badge>
              ))}
            </span>
          ) : undefined
        }
        control={
          <div className="flex items-center gap-2">
            <Button size="xs" variant="ghost" onClick={() => setOpened(skill)}>
              {location === null ? gt("Import…") : gt("View", { $context: "verb, opens a skill" })}
            </Button>
            {location === null ? null : (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canWrite}
                  onClick={() => void removeSkill(skill, location)}
                >
                  {gt("Delete")}
                </Button>
                <Switch
                  aria-label={gt("Enable skill {name}", { name: skill.name })}
                  checked={skill.enabled}
                  disabled={!canWrite}
                  onCheckedChange={(enabled) =>
                    void setEnabled({
                      environmentId,
                      input: { location, name: skill.name, enabled, ...(cwd ? { cwd } : {}) },
                    })
                  }
                />
              </>
            )}
          </div>
        }
      />
    );
  };

  const section = (title: string, rows: ReadonlyArray<SharedSkill>, empty: string) => (
    <SettingsSection title={title}>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {query.isPending ? gt("Loading…") : empty}
        </p>
      ) : (
        rows.map(skillRow)
      )}
    </SettingsSection>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title={gt("Shared skills")} id="shared-skills">
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {gt(
            "These skills work with every provider. Type $ or / in a thread and pick one to run it.",
          )}
        </p>
        {scopedCwd === undefined && projects.length > 0 ? (
          <SettingsRow
            title={gt("Project", { $context: "label of a project picker" })}
            description={cwd ?? gt("Only global skills are shown.")}
            control={
              <Select
                value={project?.id ?? NO_PROJECT}
                onValueChange={(value) => {
                  if (value !== null) setPickedProject(value);
                }}
              >
                <SelectTrigger
                  aria-label={gt("Project", { $context: "label of a project picker" })}
                >
                  <SelectValue>{project?.title ?? gt("No project")}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </SelectItem>
                  ))}
                  <SelectItem value={NO_PROJECT}>{gt("No project")}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
        {query.error ? (
          <p role="alert" className="px-4 pb-3 text-sm text-destructive">
            {query.error}
          </p>
        ) : null}
      </SettingsSection>
      {cwd
        ? section(
            gt("Project skills"),
            skills.filter((skill) => skill.location === "project"),
            gt("This project has no skills in .agents/skills."),
          )
        : null}
      {section(
        gt("Global skills"),
        skills.filter((skill) => skill.location === "global"),
        gt("No global skills yet."),
      )}
      {section(gt("From Claude Code"), importable, gt("No Claude Code skills found to import."))}
      {opened ? (
        <SkillDialog
          key={`${opened.location}:${opened.name}`}
          environmentId={environmentId}
          cwd={cwd}
          skill={opened}
          canWrite={canWrite}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

/** A skill's SKILL.md and files; for a Claude Code skill, the preview of its import. */
function SkillDialog({
  environmentId,
  cwd,
  skill,
  canWrite,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | undefined;
  readonly skill: SharedSkill;
  readonly canWrite: boolean;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const query = useEnvironmentQuery(
    skillsEnvironment.read({
      environmentId,
      input: { location: skill.location, name: skill.name, ...(cwd ? { cwd } : {}) },
    }),
  );
  const importSkill = useAtomCommand(skillsEnvironment.importSkill, { reportFailure: false });
  const from =
    skill.location === "claude-project" || skill.location === "claude-user" ? skill.location : null;
  const [target, setTarget] = useState<SharedSkillSource>(
    from === "claude-project" ? "project" : "global",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const targetLabel = (value: SharedSkillSource) =>
    value === "project" ? gt("This project") : gt("All projects");

  const runImport = async () => {
    if (from === null || !query.data) return;
    setBusy(true);
    setError(null);
    const result = await importSkill({
      environmentId,
      input: {
        from,
        name: skill.name,
        to: target,
        revision: query.data.skill.revision,
        ...(cwd ? { cwd } : {}),
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      onClose();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(
      isSharedSkillError(failure)
        ? messages(ERROR_MESSAGES[failure.reason])
        : gt("The skill could not be imported."),
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{skill.name}</DialogTitle>
          <DialogDescription>{skill.path}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {query.error ? <p role="alert">{query.error}</p> : null}
          {query.data ? (
            <div className="grid gap-3">
              <pre className="max-h-72 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
                {query.data.content}
              </pre>
              <ul className="max-h-32 overflow-auto text-xs text-muted-foreground">
                {query.data.files.map((file) => (
                  <li key={file.path}>{file.path}</li>
                ))}
              </ul>
              {query.data.skippedLinks.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {gt("Links leading outside the skill are not copied: {paths}", {
                    paths: query.data.skippedLinks.join(", "),
                  })}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{gt("Loading…")}</p>
          )}
          {error ? (
            <p role="alert" className="pt-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {from !== null && cwd ? (
            <Select
              value={target}
              onValueChange={(value) => {
                if (value !== null) setTarget(value as SharedSkillSource);
              }}
            >
              <SelectTrigger aria-label={gt("Import to")}>
                <SelectValue>{targetLabel(target)}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="project">{targetLabel("project")}</SelectItem>
                <SelectItem value="global">{targetLabel("global")}</SelectItem>
              </SelectPopup>
            </Select>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            {gt("Close")}
          </Button>
          {from === null ? null : (
            <Button disabled={!canWrite || busy || !query.data} onClick={() => void runImport()}>
              {gt("Import")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
