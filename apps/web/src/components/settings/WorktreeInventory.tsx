import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ProjectId, WorktreeInventoryEntry } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { vcsEnvironment } from "../../state/vcs";
import { OpenInPicker } from "../chat/OpenInPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function InventoryRow(props: {
  readonly entry: WorktreeInventoryEntry;
  readonly environmentId: EnvironmentId;
  readonly inspect: (path: string) => void;
  readonly pending: boolean;
}) {
  const { entry, environmentId } = props;
  const gt = useGT();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const prState = {
    open: gt("open", { $context: "pull request state" }),
    closed: gt("closed", { $context: "pull request state" }),
    merged: gt("merged", { $context: "pull request state" }),
  };
  const facts = [
    !entry.exists
      ? gt("Folder is missing")
      : entry.registered
        ? gt("Git worktree")
        : gt("Path from thread history"),
    ...(entry.prunable ? [gt("Git can prune it")] : []),
  ];
  return (
    <div className="space-y-2 border-t border-border py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {entry.branch ?? gt("Detached HEAD", { $context: "a Git worktree with no branch" })}
          </p>
          <code className="text-xs break-all select-text">{entry.path}</code>
          <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={props.pending || !entry.exists}
          onClick={() => props.inspect(entry.path)}
        >
          <T>Check changes</T>
        </Button>
      </div>
      {entry.threads.length > 0 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {entry.threads.map((thread) =>
            thread.deleted ? (
              <span key={thread.id} className="text-xs text-muted-foreground">
                {gt("{title} (deleted)", { title: thread.title })}
              </span>
            ) : (
              <Link
                key={thread.id}
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: thread.id }}
                className="text-xs underline"
              >
                {thread.archived ? gt("{title} (archived)", { title: thread.title }) : thread.title}
              </Link>
            ),
          )}
        </div>
      ) : null}
      {entry.threads.flatMap((thread) =>
        thread.pullRequests.map((pr) => (
          <a
            key={`${thread.id}:${pr.url}`}
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="mr-3 text-xs underline"
          >
            {[`#${pr.number}`, pr.title, pr.state === null ? null : prState[pr.state]]
              .filter(Boolean)
              .join(" · ")}
          </a>
        )),
      )}
      {entry.error ? (
        <p role="alert" className="text-xs text-destructive">
          {entry.error}
        </p>
      ) : null}
      {entry.hasWorkingTreeChanges === null ? null : (
        <p className="text-xs text-muted-foreground">
          {entry.hasWorkingTreeChanges ? gt("Has file changes") : gt("No changes")}
        </p>
      )}
      {entry.exists ? (
        <OpenInPicker
          environmentId={environmentId}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          availableEditors={config?.availableEditors ?? []}
          openInCwd={entry.path}
          enableShortcut={false}
          compact
        />
      ) : null}
    </div>
  );
}

function EnvironmentInventory(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projectIds: ReadonlyArray<ProjectId> | undefined;
  readonly query: string;
}) {
  const { environmentId, projectIds } = props;
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .worktreeInventory === true;
  const permission =
    useAtomValue(vcsEnvironment.worktreeInventory.permissionAtom(environmentId)) && supported;
  const [inspectPath, setInspectPath] = useState<string | undefined>();
  const inventory = useEnvironmentQuery(
    permission
      ? vcsEnvironment.worktreeInventoryQuery({
          environmentId,
          input: {
            ...(projectIds === undefined ? {} : { projectIds }),
            ...(inspectPath === undefined ? {} : { inspectPath }),
          },
        })
      : null,
  );
  const result = inventory.data;
  const pending = inventory.isPending;
  const inspect = (path: string) => {
    if (inspectPath === path) inventory.refresh();
    else setInspectPath(path);
  };
  const query = props.query.toLocaleLowerCase();
  const visible =
    result?.entries.filter((entry) =>
      [entry.path, entry.branch ?? "", ...entry.threads.map((thread) => thread.title)]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
    ) ?? [];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{props.label}</p>
        <Button
          variant="outline"
          size="sm"
          disabled={pending || !permission}
          onClick={inventory.refresh}
        >
          <T>Refresh list</T>
        </Button>
      </div>
      {supported ? null : (
        <p className="text-xs text-muted-foreground">
          <T>Update this environment to see its worktrees.</T>
        </p>
      )}
      {inventory.error ? (
        <p role="alert" className="text-xs text-destructive">
          {inventory.error}
        </p>
      ) : null}
      {result?.errors.map((issue) => (
        <p key={issue.projectId} role="alert" className="text-xs text-destructive">
          {issue.message}
        </p>
      ))}
      {!result && pending ? (
        <p className="text-xs text-muted-foreground">
          <T>Loading…</T>
        </p>
      ) : null}
      {result && visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          <T>No worktrees found.</T>
        </p>
      ) : null}
      {visible.map((entry) => (
        <InventoryRow
          key={entry.path}
          entry={entry}
          environmentId={environmentId}
          pending={pending || !permission}
          inspect={inspect}
        />
      ))}
    </div>
  );
}

/** Every worktree of the selected projects, with the threads and PRs that used it. Read-only. */
export function WorktreeInventory() {
  const gt = useGT();
  const { scope, environments } = useSettingsScope();
  const [query, setQuery] = useState("");
  return (
    <SettingsSection id="worktree-inventory" title={gt("Worktree inventory")}>
      <div className="space-y-3 px-3 py-3 sm:px-4">
        <p className="text-xs text-muted-foreground">
          <T>
            Git worktrees and worktree paths from thread history, including deleted threads. File
            changes are checked only when you ask.
          </T>
        </p>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={gt("Find a worktree")}
          aria-label={gt("Find a worktree")}
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
                environments.find((entry) => entry.environmentId === environmentId)?.label ??
                environmentId
              }
            />
          );
        })}
      </div>
    </SettingsSection>
  );
}
