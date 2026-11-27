import { useAtomValue } from "@effect/atom-react";
import {
  MEMORY_MAX_CHARS,
  type EnvironmentId,
  type MemoryClaudeImportableEntry,
  type MemorySaveAction,
  type MemoryScope,
  type ProjectId,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { DownloadIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

export function MemorySettings() {
  const gt = useGT();
  const { environment, scope } = useSettingsScope();
  if (!environment || environment.connection.phase !== "connected") {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          {gt("Connect an environment to manage memory notes.")}
        </p>
      </SettingsPageContainer>
    );
  }
  const scopedProjectId =
    scope.kind === "project" || scope.kind === "checkout"
      ? scope.members.find((member) => member.environmentId === environment.environmentId)?.id
      : undefined;
  return (
    <MemoryEnvironmentSettings
      key={environment.environmentId}
      environmentId={environment.environmentId}
      initialProjectId={scopedProjectId}
    />
  );
}

function MemoryEnvironmentSettings({
  environmentId,
  initialProjectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly initialProjectId: ProjectId | undefined;
}) {
  const gt = useGT();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | undefined>(
    initialProjectId ?? projects[0]?.id,
  );
  const activeProjectId =
    selectedProjectId && projects.some((project) => project.id === selectedProjectId)
      ? selectedProjectId
      : projects[0]?.id;

  const canWrite = useAtomValue(serverEnvironment.writeMemoryNote.permissionAtom(environmentId));
  const listImportable = useAtomCommand(serverEnvironment.listImportableMemoryFromClaude);
  const [importTarget, setImportTarget] = useState<{
    readonly scope: MemoryScope;
    readonly projectId: ProjectId | undefined;
    readonly entries: ReadonlyArray<MemoryClaudeImportableEntry>;
    readonly loading: boolean;
  } | null>(null);

  async function openImportDialog(scope: MemoryScope, projectId: ProjectId | undefined) {
    setImportTarget({ scope, projectId, entries: [], loading: true });
    const result = await listImportable({ environmentId, input: {} });
    setImportTarget((current) =>
      current && current.scope === scope && current.projectId === projectId
        ? {
            ...current,
            entries: result._tag === "Success" ? result.value.entries : [],
            loading: false,
          }
        : current,
    );
  }

  return (
    <SettingsPageContainer>
      <p className="text-xs text-muted-foreground">
        <T>
          Memory notes travel across every provider in this environment (Claude, Codex, Antigravity,
          Cursor). Clearing a note stops future delivery; an already-open native session may still
          retain earlier text until a new session starts.
        </T>
      </p>

      <MemoryNoteEditorSection
        environmentId={environmentId}
        scope="global"
        projectId={undefined}
        title={gt("Global memory")}
        description={gt(
          "Personal preferences and conventions shared across all projects in this environment.",
        )}
        placeholder={gt(
          "Add personal preferences, preferred tools, or conventions to share across providers...",
        )}
        canWrite={canWrite}
        onOpenImport={() => void openImportDialog("global", undefined)}
      />

      <SettingsSection
        title={gt("Project memory")}
        headerAction={
          projects.length > 0 && activeProjectId ? (
            <Select
              value={activeProjectId}
              onValueChange={(value) => {
                const next = projects.find((project) => project.id === value)?.id;
                if (next) setSelectedProjectId(next);
              }}
            >
              <SelectTrigger size="sm" className="w-48">
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
          ) : null
        }
      >
        {activeProjectId ? (
          <MemoryNoteEditorBody
            key={activeProjectId}
            environmentId={environmentId}
            scope="project"
            projectId={activeProjectId}
            placeholder={gt(
              "Add project decisions, test commands, or pitfalls that every provider should know...",
            )}
            canWrite={canWrite}
            onOpenImport={() => void openImportDialog("project", activeProjectId)}
          />
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            <T>Add a project to this environment to store project-specific memory.</T>
          </p>
        )}
      </SettingsSection>

      {importTarget ? (
        <ClaudeMemoryImportDialog
          environmentId={environmentId}
          scope={importTarget.scope}
          projectId={importTarget.projectId}
          entries={importTarget.entries}
          loading={importTarget.loading}
          onClose={() => setImportTarget(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function MemoryNoteEditorSection({
  environmentId,
  scope,
  projectId,
  title,
  description,
  placeholder,
  canWrite,
  onOpenImport,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: MemoryScope;
  readonly projectId: ProjectId | undefined;
  readonly title: string;
  readonly description: string;
  readonly placeholder: string;
  readonly canWrite: boolean;
  readonly onOpenImport: () => void;
}) {
  return (
    <SettingsSection title={title}>
      <p className="px-4 pt-3 text-xs text-muted-foreground">{description}</p>
      <MemoryNoteEditorBody
        environmentId={environmentId}
        scope={scope}
        projectId={projectId}
        placeholder={placeholder}
        canWrite={canWrite}
        onOpenImport={onOpenImport}
      />
    </SettingsSection>
  );
}

function MemoryNoteEditorBody({
  environmentId,
  scope,
  projectId,
  placeholder,
  canWrite,
  onOpenImport,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: MemoryScope;
  readonly projectId: ProjectId | undefined;
  readonly placeholder: string;
  readonly canWrite: boolean;
  readonly onOpenImport: () => void;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    serverEnvironment.memoryNote({
      environmentId,
      input: { scope, ...(projectId === undefined ? {} : { projectId }) },
    }),
  );
  const writeMemory = useAtomCommand(serverEnvironment.writeMemoryNote);
  const clearMemory = useAtomCommand(serverEnvironment.clearMemoryNote);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const note = query.data;
  const serverContent = note?.content ?? "";
  const value = draft ?? serverContent;
  const maxChars = note?.maxChars ?? MEMORY_MAX_CHARS;
  const overLimit = value.length > maxChars;
  const isDirty = draft !== null && draft !== serverContent;

  async function handleSave() {
    if (!canWrite || saving || overLimit) return;
    setSaving(true);
    const result = await writeMemory({
      environmentId,
      input: {
        scope,
        ...(projectId === undefined ? {} : { projectId }),
        content: value,
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setDraft(null);
      query.refresh();
      toastManager.add({ type: "success", title: gt("Memory saved") });
    } else {
      toastManager.add({ type: "error", title: gt("Could not save memory") });
    }
  }

  async function handleClear() {
    if (!canWrite || saving) return;
    setSaving(true);
    const result = await clearMemory({
      environmentId,
      input: {
        scope,
        ...(projectId === undefined ? {} : { projectId }),
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setDraft(null);
      query.refresh();
      toastManager.add({ type: "success", title: gt("Memory cleared") });
    } else {
      toastManager.add({ type: "error", title: gt("Could not clear memory") });
    }
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Badge variant="outline" size="sm">
            <T>
              rev <Var>{note?.revision ?? 0}</Var>
            </T>
          </Badge>
          <span className={overLimit ? "font-medium text-destructive" : undefined}>
            <T>
              <Var>{value.length}</Var> / <Var>{maxChars}</Var> chars
            </T>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!canWrite || saving}
            onClick={onOpenImport}
          >
            <DownloadIcon className="size-3" />
            <T>Import from Claude Code</T>
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={!canWrite || saving || (serverContent.trim() === "" && value.trim() === "")}
            onClick={() => void handleClear()}
          >
            <Trash2Icon className="size-3" />
            <T>Clear</T>
          </Button>
        </div>
      </div>

      <Textarea
        value={value}
        placeholder={placeholder}
        disabled={!canWrite || saving}
        rows={8}
        onChange={(event) => setDraft(event.target.value)}
      />

      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          {note && note.imports.length > 0 ? (
            <T>
              Imported entries: <Var>{note.imports.length}</Var>
            </T>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {isDirty ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={saving}
              onClick={() => setDraft(null)}
            >
              <T>Discard</T>
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            disabled={!canWrite || saving || !isDirty || overLimit}
            onClick={() => void handleSave()}
          >
            <T>Save</T>
          </Button>
        </div>
      </div>
    </div>
  );
}

function ClaudeMemoryImportDialog({
  environmentId,
  scope,
  projectId,
  entries,
  loading,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: MemoryScope;
  readonly projectId: ProjectId | undefined;
  readonly entries: ReadonlyArray<MemoryClaudeImportableEntry>;
  readonly loading: boolean;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const noteQuery = useEnvironmentQuery(
    serverEnvironment.memoryNote({
      environmentId,
      input: { scope, ...(projectId === undefined ? {} : { projectId }) },
    }),
  );
  const importMemory = useAtomCommand(serverEnvironment.importMemoryFromClaude);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [mode, setMode] = useState<MemorySaveAction>("append");
  const [importing, setImporting] = useState(false);

  function toggleEntry(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleImport() {
    if (importing || selectedIds.size === 0) return;
    setImporting(true);
    const result = await importMemory({
      environmentId,
      input: {
        scope,
        ...(projectId === undefined ? {} : { projectId }),
        entryIds: [...selectedIds],
        mode,
      },
    });
    setImporting(false);
    if (result._tag === "Success") {
      noteQuery.refresh();
      toastManager.add({
        type: "success",
        title: gt("Imported memory from Claude Code"),
      });
      onClose();
    } else {
      toastManager.add({
        type: "error",
        title: gt("Could not import memory from Claude Code"),
      });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <T>Import memory from Claude Code</T>
          </DialogTitle>
          <DialogDescription>
            {scope === "project" ? (
              <T>Select Claude Code memory files to copy into this project note.</T>
            ) : (
              <T>Select Claude Code memory files to copy into your global memory note.</T>
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="space-y-3">
            {loading ? (
              <p className="text-xs text-muted-foreground">
                <T>Scanning Claude Code memory files...</T>
              </p>
            ) : entries.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <T>No Claude Code memory files were found in this environment.</T>
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <Label>
                    <T>Import mode</T>
                  </Label>
                  <Select
                    value={mode}
                    onValueChange={(value) => {
                      if (value === "append" || value === "replace") setMode(value);
                    }}
                  >
                    <SelectTrigger size="sm" className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="append">{gt("Append to note")}</SelectItem>
                      <SelectItem value="replace">{gt("Replace note")}</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>

                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {entries.map((entry) => {
                    const checked = selectedIds.has(entry.id);
                    return (
                      <label
                        key={entry.id}
                        className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border/70 p-2.5 text-xs hover:bg-muted/40"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleEntry(entry.id)}
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-foreground">{entry.title}</span>
                            <Badge variant="outline" size="sm">
                              {entry.projectLabel}
                            </Badge>
                            <span className="text-muted-foreground">
                              <T>
                                <Var>{entry.charCount}</Var> chars
                              </T>
                            </span>
                          </div>
                          <p className="line-clamp-2 text-muted-foreground">{entry.preview}</p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={importing || selectedIds.size === 0}
            onClick={() => void handleImport()}
          >
            <T>
              Import (<Var>{selectedIds.size}</Var>)
            </T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
