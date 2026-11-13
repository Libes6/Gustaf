import { useT } from "../../useUiLanguage";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ProjectId, WorktreeInventoryEntry } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { vcsEnvironment } from "../../state/vcs";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { OpenInPicker } from "../chat/OpenInPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function InventoryRow({
  entry,
  environmentId,
  inspect,
  pending,
}: {
  entry: WorktreeInventoryEntry;
  environmentId: EnvironmentId;
  inspect: (path: string) => void;
  pending: boolean;
}) {
  const t = useT();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return (
    <div className="space-y-2 border-t border-border py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {entry.branch ?? t("settingsE.worktreeInventory.detached")}
          </p>
          <code className="break-all text-xs select-text">{entry.path}</code>
          <p className="text-xs text-muted-foreground">
            {!entry.exists
              ? t("settingsE.worktreeInventory.missing")
              : entry.registered
                ? t("settingsE.worktreeInventory.registered")
                : t("settingsE.worktreeInventory.historyPath")}
            {entry.prunable ? t("settingsE.worktreeInventory.prunable") : ""}
            {t("settingsE.worktreeInventory.unknownOrigin")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={pending || !entry.exists}
          onClick={() => inspect(entry.path)}
        >
          {t("settingsE.worktreeInventory.inspect")}
        </Button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {entry.threads.map((thread) =>
          thread.deleted ? (
            <span key={thread.id} className="text-xs text-muted-foreground">
              {thread.title}
              {t("settingsE.worktreeInventory.deleted")}
            </span>
          ) : (
            <Link
              key={thread.id}
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: thread.id }}
              className="text-xs underline"
            >
              {thread.title}
              {thread.archived ? t("settingsE.worktreeInventory.archived") : ""}
            </Link>
          ),
        )}
      </div>
      {entry.threads.flatMap((thread) =>
        thread.pullRequests.map((pr) => (
          <a
            key={`${thread.id}:${pr.url}`}
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="mr-3 text-xs underline"
          >
            #{pr.number}
            {pr.title ? ` · ${pr.title}` : ""}
            {pr.state ? ` · ${pr.state}` : ""}
          </a>
        )),
      )}
      {entry.error && (
        <p role="alert" className="text-xs text-destructive">
          {entry.error}
        </p>
      )}
      {entry.hasWorkingTreeChanges !== null && (
        <p className="text-xs text-muted-foreground">
          {entry.hasWorkingTreeChanges
            ? t("settingsE.worktreeInventory.changed")
            : t("settingsE.worktreeInventory.clean")}
        </p>
      )}
      {entry.exists && (
        <OpenInPicker
          environmentId={environmentId}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          availableEditors={config?.availableEditors ?? []}
          openInCwd={entry.path}
          enableShortcut={false}
          compact
        />
      )}
    </div>
  );
}

function EnvironmentInventory({
  environmentId,
  label,
  projectIds,
  query,
}: {
  environmentId: EnvironmentId;
  label: string;
  projectIds: ReadonlyArray<ProjectId> | undefined;
  query: string;
}) {
  const t = useT();
  const permission = useAtomValue(vcsEnvironment.worktreeInventory.permissionAtom(environmentId));
  const [inspectPath, setInspectPath] = useState<string | undefined>();
  const inventory = useEnvironmentQuery(
    vcsEnvironment.worktreeInventoryQuery({ environmentId, input: { projectIds, inspectPath } }),
  );
  const result = inventory.data;
  const pending = inventory.isPending;
  const error = inventory.error;
  const inspect = (path: string) => {
    if (inspectPath === path) inventory.refresh();
    else setInspectPath(path);
  };
  const visible =
    result?.entries.filter((entry) =>
      `${entry.path} ${entry.branch ?? ""} ${entry.threads.map((thread) => thread.title).join(" ")}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    ) ?? [];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{label}</p>
        <Button
          variant="outline"
          size="sm"
          disabled={pending || !permission}
          onClick={inventory.refresh}
        >
          {t("settingsE.worktreeInventory.refresh")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {result?.errors.map((issue) => (
        <p key={issue.projectId} role="alert" className="text-xs text-destructive">
          {issue.message}
        </p>
      ))}
      {!result && pending && (
        <p className="text-xs text-muted-foreground">{t("settingsE.worktreeInventory.checking")}</p>
      )}
      {result && visible.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("settingsE.worktreeInventory.empty")}</p>
      )}
      {visible.map((entry) => (
        <InventoryRow
          key={entry.path}
          entry={entry}
          environmentId={environmentId}
          pending={pending || !permission}
          inspect={(path) => void inspect(path)}
        />
      ))}
    </div>
  );
}

export function WorktreeInventory() {
  const t = useT();
  const { scope, environments } = useSettingsScope();
  const [query, setQuery] = useState("");
  return (
    <SettingsSection id="worktree-inventory" title={t("settingsE.worktreeInventory.title")}>
      <div className="space-y-3 px-3 py-3 sm:px-4">
        <p className="text-xs text-muted-foreground">
          {t("settingsE.worktreeInventory.description")}
        </p>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("settingsE.worktreeInventory.search")}
          aria-label={t("settingsE.worktreeInventory.search")}
        />
        {scope.environmentIds.map((environmentId) => {
          const projectIds =
            scope.kind === "project" || scope.kind === "checkout"
              ? scope.members
                  .filter((member) => member.environmentId === environmentId)
                  .map((member) => member.id)
              : undefined;
          return (
            <EnvironmentInventory
              key={JSON.stringify([environmentId, projectIds])}
              environmentId={environmentId}
              projectIds={projectIds}
              query={query}
              label={
                environments.find((env) => env.environmentId === environmentId)?.label ??
                environmentId
              }
            />
          );
        })}
      </div>
    </SettingsSection>
  );
}
