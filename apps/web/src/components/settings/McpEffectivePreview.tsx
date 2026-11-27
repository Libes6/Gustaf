import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  McpPreviewResult,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";
import { useProjects } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function McpEffectivePreview({
  environmentId,
  projectIds,
  settingsKey,
}: {
  environmentId: EnvironmentId;
  projectIds: ProjectId[];
  settingsKey: string;
}) {
  const gt = useGT();
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      (projectIds.length === 0 || projectIds.includes(project.id)),
  );
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [providerId, setProviderId] = useState<ProviderInstanceId | null>(null);
  const selectedProject = projectId ?? projects[0]?.id;
  const selectedProvider = providerId ?? providers[0]?.instanceId;
  const preview = useAtomCommand(serverEnvironment.mcpPreview, { reportFailure: false });
  const allowed = useAtomValue(serverEnvironment.mcpPreview.permissionAtom(environmentId));
  const [answer, setAnswer] = useState<{
    projectId: ProjectId;
    providerId: ProviderInstanceId;
    settingsKey: string;
    value?: McpPreviewResult;
    failed: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const current =
    answer?.projectId === selectedProject &&
    answer?.providerId === selectedProvider &&
    answer?.settingsKey === settingsKey
      ? answer
      : null;
  return (
    <SettingsSection title={gt("Effective MCP servers")}>
      <div className="grid gap-3 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          {gt(
            "Preview the next session in the project directory. Connection status comes from the latest check.",
          )}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-40 gap-1.5">
            <Label htmlFor="mcp-preview-project">{gt("Project")}</Label>
            <Select
              value={selectedProject ?? null}
              onValueChange={setProjectId}
              items={projects.map((project) => ({ value: project.id, label: project.title }))}
            >
              <SelectTrigger id="mcp-preview-project">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="grid min-w-40 gap-1.5">
            <Label htmlFor="mcp-preview-provider">{gt("Provider")}</Label>
            <Select
              value={selectedProvider ?? null}
              onValueChange={setProviderId}
              items={providers.map((provider) => ({
                value: provider.instanceId,
                label: provider.displayName ?? provider.driver,
              }))}
            >
              <SelectTrigger id="mcp-preview-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {providers.map((provider) => (
                  <SelectItem key={provider.instanceId} value={provider.instanceId}>
                    {provider.displayName ?? provider.driver}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <Button
            variant="outline"
            disabled={
              !allowed || busy || selectedProject === undefined || selectedProvider === undefined
            }
            onClick={async () => {
              if (selectedProject === undefined || selectedProvider === undefined) return;
              setBusy(true);
              const result = await preview({
                environmentId,
                input: { projectId: selectedProject, providerInstanceId: selectedProvider },
              });
              setAnswer({
                projectId: selectedProject,
                providerId: selectedProvider,
                settingsKey,
                failed: result._tag !== "Success",
                ...(result._tag === "Success" ? { value: result.value } : {}),
              });
              setBusy(false);
            }}
          >
            {busy ? gt("Checking…") : gt("Preview")}
          </Button>
        </div>
        {projects.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {gt("Add a project to preview its MCP configuration.")}
          </p>
        )}
        {current?.failed && (
          <p role="alert" className="text-sm text-destructive">
            {gt("Could not load the MCP preview.")}
          </p>
        )}
        {current?.value?.servers.length === 0 && (
          <p className="text-sm text-muted-foreground">{gt("No MCP servers are configured.")}</p>
        )}
      </div>
      {current?.value?.servers.map((server) => (
        <SettingsRow
          key={`${server.source}:${server.id}`}
          title={server.id}
          description={
            <>
              <span className="block break-all">{server.source}</span>
              {server.reason && <span className="block">{server.reason}</span>}
              <span className="block">{server.status?.status ?? gt("Not checked")}</span>
            </>
          }
          control={
            <span className="text-xs text-muted-foreground">
              {server.disposition === "passed"
                ? gt("Passed to provider")
                : server.disposition === "native"
                  ? gt("Loaded by provider")
                  : gt("Skipped")}
            </span>
          }
        />
      ))}
    </SettingsSection>
  );
}
