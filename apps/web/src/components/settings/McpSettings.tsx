import { useAtomValue } from "@effect/atom-react";
import {
  McpServerConfig,
  McpServerId,
  type EnvironmentId,
  type McpImportableServer,
  type ProjectId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { parseMcpServerJson } from "@t3tools/client-runtime/mcp-server-input";
import * as Schema from "effect/Schema";
import { useT } from "../../useUiLanguage";
import { useState } from "react";
import { ChevronDownIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { ensureLocalApi } from "../../localApi";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "../ui/collapsible";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useManagedPolicy } from "../../state/managedPolicy";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const isMcpId = Schema.is(McpServerId);
const decodeMcpId = Schema.decodeSync(McpServerId);
const decodeMcpConfig = Schema.decodeUnknownSync(McpServerConfig);

export function McpSettings() {
  const t = useT();
  const { environment, scope } = useSettingsScope();
  if (!environment || environment.connection.phase !== "connected")
    return <p>{t("settingsE.mcp.s0")}</p>;
  const members =
    scope.kind === "project" || scope.kind === "checkout"
      ? scope.members.filter((m) => m.environmentId === environment.environmentId)
      : [];
  return (
    <McpEnvironmentSettings
      key={environment.environmentId}
      environmentId={environment.environmentId}
      projectIds={members.map((m) => m.id)}
      projectDir={members[0]?.workspaceRoot}
    />
  );
}

function McpEnvironmentSettings({
  environmentId,
  projectIds,
  projectDir,
}: {
  environmentId: EnvironmentId;
  projectIds: ProjectId[];
  projectDir?: string | undefined;
}) {
  const t = useT();
  const settings = useEnvironmentSettings(environmentId, (s) => s);
  const policy = useManagedPolicy(environmentId);
  const canEdit = useAtomValue(serverEnvironment.mcpListImportable.permissionAtom(environmentId));
  const canLocal = useAtomValue(serverEnvironment.importMcpServers.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const list = useAtomCommand(serverEnvironment.mcpListImportable);
  const importServers = useAtomCommand(serverEnvironment.importMcpServers);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; config?: McpServerConfig } | null>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const [imports, setImports] = useState<readonly McpImportableServer[] | null>(null);
  const localAllowed = canLocal && policy?.limits?.localMcpServers !== false;
  async function save(patch: ServerSettingsPatch) {
    setBusy(true);
    const result = await update({ environmentId, input: { patch } });
    setBusy(false);
    return result._tag === "Success";
  }
  async function loadImports() {
    const result = await list({ environmentId, input: projectDir ? { projectDir } : {} });
    if (result._tag === "Success") {
      setImports(result.value.servers);
      setError(
        result.value.unreadablePaths.length
          ? t("settingsE.mcp.unreadable").replace(
              "{paths}",
              result.value.unreadablePaths.join(", "),
            )
          : "",
      );
    }
  }
  return (
    <SettingsPageContainer>
      <SettingsSection
        title={t("settingsE.mcp.s1")}
        titleAction={
          projectIds.length === 0 ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={t("settingsE.mcp.s5")}
              disabled={!canEdit || busy}
              onClick={() => setEditing({ id: "" })}
            >
              <PlusIcon />
            </Button>
          ) : undefined
        }
        headerAction={
          <div className="flex flex-wrap items-center gap-1">
            {projectIds.length === 0 && (
              <Button
                size="xs"
                variant="ghost"
                disabled={!canEdit || busy}
                onClick={() => {
                  setError("");
                  setPaste("");
                }}
              >
                {t("settingsE.mcp.s6")}
              </Button>
            )}
            <Button size="xs" variant="ghost" disabled={!canEdit || busy} onClick={loadImports}>
              {t("settingsE.mcp.s7")}
            </Button>
          </div>
        }
      >
        <p className="px-4 py-3 text-sm text-muted-foreground">{t("settingsE.mcp.s2")}</p>
        {!canEdit && <p role="status">{t("settingsE.mcp.s3")}</p>}
        {!localAllowed && <p role="status">{t("settingsE.mcp.s4")}</p>}
        {Object.keys(settings.mcpServers).length === 0 && (
          <div className="grid justify-items-start gap-3 px-4 py-5">
            <p className="text-sm text-muted-foreground">{t("settingsE.mcp.empty")}</p>
            {projectIds.length === 0 && (
              <Button
                size="sm"
                variant="outline"
                disabled={!canEdit || busy}
                onClick={() => setEditing({ id: "" })}
              >
                <PlusIcon />
                {t("settingsE.mcp.s5")}
              </Button>
            )}
          </div>
        )}
        {(Object.entries(settings.mcpServers) as [McpServerId, McpServerConfig][]).map(
          ([id, config]) => (
            <SettingsRow
              key={id}
              title={config.name ?? id}
              description={`${id} · ${config.transport.type} · ${config.transport.type === "stdio" ? [config.transport.command, ...config.transport.args].join(" ") : config.transport.url}`}
              control={
                <div className="flex items-center gap-2">
                  {projectIds.length ? (
                    <Select
                      aria-label={`${id} project override`}
                      disabled={
                        !canEdit || busy || (config.transport.type === "stdio" && !localAllowed)
                      }
                      value={
                        settings.projectSettingsOverrides[projectIds[0]!]?.mcpServers?.[id]
                          ?.enabled === undefined
                          ? "inherit"
                          : settings.projectSettingsOverrides[projectIds[0]!]?.mcpServers?.[id]
                                ?.enabled
                            ? "on"
                            : "off"
                      }
                      onValueChange={(value) => {
                        if (value === null) return;
                        const enabled = value === "inherit" ? {} : { enabled: value === "on" };
                        void save({
                          projectSettingsOverrides: Object.fromEntries(
                            projectIds.map((pid) => [
                              pid,
                              {
                                ...settings.projectSettingsOverrides[pid],
                                mcpServers: {
                                  ...settings.projectSettingsOverrides[pid]?.mcpServers,
                                  [id]: enabled,
                                },
                              },
                            ]),
                          ),
                        });
                      }}
                    >
                      <SelectTrigger size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="inherit">
                          {t("settingsE.mcp.s8")}
                          {config.enabled ? t("settingsE.mcp.s9") : t("settingsE.mcp.s10")})
                        </SelectItem>
                        <SelectItem value="on">{t("settingsE.mcp.s11")}</SelectItem>
                        <SelectItem value="off">{t("settingsE.mcp.s12")}</SelectItem>
                      </SelectPopup>
                    </Select>
                  ) : (
                    <>
                      <Switch
                        aria-label={`Enable ${id}`}
                        checked={config.enabled}
                        disabled={
                          !canEdit || busy || (config.transport.type === "stdio" && !localAllowed)
                        }
                        onCheckedChange={(enabled) => {
                          void save({ mcpServers: { [id]: { ...config, enabled } } });
                        }}
                      />
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!canEdit || busy}
                        onClick={() => setEditing({ id, config })}
                      >
                        {t("settingsE.mcp.s13")}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={!canEdit || busy}
                        onClick={async () => {
                          if (
                            await ensureLocalApi().dialogs.confirm(
                              t("settingsE.mcp.deleteConfirm").replace("{name}", config.name ?? id),
                              { variant: "destructive" },
                            )
                          )
                            void save({ mcpServers: { [id]: null } });
                        }}
                      >
                        {t("settingsE.mcp.s14")}
                      </Button>
                    </>
                  )}
                </div>
              }
            />
          ),
        )}
      </SettingsSection>
      {imports !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setImports(null);
          }}
        >
          <DialogPopup className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t("settingsE.mcp.s7")}</DialogTitle>
              <DialogDescription>{t("settingsE.mcp.s15")}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              {imports.map((entry) => (
                <SettingsRow
                  key={JSON.stringify([
                    entry.source,
                    entry.sourcePath,
                    entry.projectDir,
                    entry.name,
                  ])}
                  title={entry.name}
                  description={
                    <span className="block">
                      <span className="block">
                        {entry.source} · {entry.sourcePath}
                      </span>
                      <span className="block whitespace-pre-wrap break-all font-mono">
                        {entry.transport.type === "stdio"
                          ? JSON.stringify([entry.transport.command, ...entry.transport.args])
                          : entry.transport.url}
                      </span>
                      <span className="block">
                        {entry.transport.type === "stdio"
                          ? entry.transport.envKeys.join(", ")
                          : entry.transport.headerKeys.join(", ")}
                      </span>
                    </span>
                  }
                  control={
                    <Button
                      disabled={
                        busy ||
                        entry.alreadyInGustaf ||
                        !isMcpId(entry.suggestedId) ||
                        (entry.transport.type === "stdio" && !localAllowed)
                      }
                      onClick={async () => {
                        setBusy(true);
                        const result = await importServers({
                          environmentId,
                          input: {
                            ...(projectDir ? { projectDir } : {}),
                            entries: [
                              {
                                source: entry.source,
                                name: entry.name,
                                ...(entry.projectDir ? { projectDir: entry.projectDir } : {}),
                                id: decodeMcpId(entry.suggestedId),
                                transport: entry.transport.type,
                              },
                            ],
                          },
                        });
                        setBusy(false);
                        if (result._tag === "Success") await loadImports();
                      }}
                    >
                      {entry.alreadyInGustaf ? t("settingsE.mcp.s16") : t("settingsE.mcp.s17")}
                    </Button>
                  }
                />
              ))}
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" disabled={busy} onClick={() => setImports(null)}>
                {t("settingsE.mcp.s18")}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
      {error && paste === null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {editing && (
        <McpEditor
          key={editing.id}
          editing={editing}
          localAllowed={localAllowed}
          busy={busy}
          existingIds={Object.keys(settings.mcpServers)}
          onCancel={() => setEditing(null)}
          onSave={async (id, config) => {
            if (!editing.id && Object.hasOwn(settings.mcpServers, id)) {
              setError(t("settingsE.mcp.idTaken"));
              return;
            }
            if (await save({ mcpServers: { [id]: config } })) setEditing(null);
          }}
        />
      )}
      {paste !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setPaste(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>{t("settingsE.mcp.s6")}</DialogTitle>
              <DialogDescription>{t("settingsE.mcp.jsonHint")}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="grid gap-2">
                <Label htmlFor="mcp-json">.mcp.json</Label>
                <Textarea
                  id="mcp-json"
                  rows={8}
                  spellCheck={false}
                  autoFocus
                  aria-label={t("settingsE.mcp.s19")}
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                />
              </div>
              {error && (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {error}
                </p>
              )}
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" disabled={busy} onClick={() => setPaste(null)}>
                {t("settingsE.mcp.s21")}
              </Button>
              <Button
                disabled={busy || !paste.trim()}
                onClick={async () => {
                  let configs;
                  try {
                    configs = parseMcpServerJson(paste);
                    if (Object.keys(configs).some((id) => Object.hasOwn(settings.mcpServers, id)))
                      throw new Error(t("settingsE.mcp.idTaken"));
                    if (
                      !localAllowed &&
                      Object.values(configs).some((c) => c.transport.type === "stdio")
                    )
                      throw new Error(t("settingsE.mcp.localDisallowed"));
                  } catch (e) {
                    setError(
                      e instanceof Error &&
                        [t("settingsE.mcp.idTaken"), t("settingsE.mcp.localDisallowed")].includes(
                          e.message,
                        )
                        ? e.message
                        : t("settingsE.mcp.jsonInvalid"),
                    );
                    return;
                  }
                  if (await save({ mcpServers: configs })) setPaste(null);
                }}
              >
                {t("settingsE.mcp.s20")}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
    </SettingsPageContainer>
  );
}

function McpEditor({
  editing,
  localAllowed,
  busy,
  existingIds,
  onSave,
  onCancel,
}: {
  editing: { id: string; config?: McpServerConfig };
  localAllowed: boolean;
  busy: boolean;
  existingIds: string[];
  onSave: (id: string, config: McpServerConfig) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const transport = editing.config?.transport;
  const [name, setName] = useState(editing.config?.name ?? editing.id);
  const [customId, setCustomId] = useState<string | null>(editing.id || null);
  const suggestedId = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const id = customId ?? (suggestedId || "mcp-server");
  const [type, setType] = useState<"stdio" | "http">(transport?.type ?? "http");
  const [address, setAddress] = useState(
    transport?.type === "stdio" ? transport.command : (transport?.url ?? ""),
  );
  const [args, setArgs] = useState(
    JSON.stringify(transport?.type === "stdio" ? transport.args : []),
  );
  const [cwd, setCwd] = useState(transport?.type === "stdio" ? transport.cwd : "thread");
  const [nextRow, setNextRow] = useState(0);
  const [rows, setRows] = useState(() =>
    Object.entries(transport?.type === "stdio" ? transport.env : (transport?.headers ?? {})).map(
      ([key, value]) => ({ key, value, draft: "", rowId: key }),
    ),
  );
  const [error, setError] = useState("");
  const [idError, setIdError] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  async function submit() {
    setError("");
    setIdError("");
    if (!isMcpId(id)) {
      setAdvancedOpen(true);
      setIdError(t("settingsE.mcp.idHint"));
      return;
    }
    if (!editing.id && existingIds.includes(id)) {
      setAdvancedOpen(true);
      setIdError(t("settingsE.mcp.idTaken"));
      return;
    }
    let config;
    try {
      if (new Set(rows.map((r) => r.key)).size !== rows.length) {
        setError(t("settingsE.mcp.duplicateKeys"));
        return;
      }
      const secrets = Object.fromEntries(rows.map((r) => [r.key, r.draft || r.value]));
      config = decodeMcpConfig({
        ...editing.config,
        name: name.trim() || id,
        enabled: editing.config?.enabled ?? false,
        transport:
          type === "stdio"
            ? { type, command: address, args: JSON.parse(args), cwd, env: secrets }
            : { type, url: address, headers: secrets },
      });
    } catch {
      setError(t("settingsE.mcp.invalidConfig"));
      return;
    }
    await onSave(id, config);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{editing.id ? t("settingsE.mcp.s22") : t("settingsE.mcp.s23")}</DialogTitle>
          <DialogDescription>{t("settingsE.mcp.editorHint")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="mcp-server-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-name">{t("settingsE.mcp.name")}</Label>
              <Input
                id="mcp-name"
                value={name}
                autoFocus
                placeholder="Figma"
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-transport">{t("settingsE.mcp.s25")}</Label>
              <Select
                value={type}
                disabled={busy}
                onValueChange={(value) => {
                  if (value !== "http" && value !== "stdio") return;
                  setType(value);
                  setAddress("");
                  setRows([]);
                }}
              >
                <SelectTrigger id="mcp-transport">
                  <SelectValue>
                    {type === "http" ? t("settingsE.mcp.s26") : t("settingsE.mcp.s27")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="http">{t("settingsE.mcp.s26")}</SelectItem>
                  <SelectItem value="stdio" disabled={!localAllowed}>
                    {t("settingsE.mcp.s27")}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-address">
                {type === "stdio" ? t("settingsE.mcp.s28") : t("settingsE.mcp.s29")}
              </Label>
              <Input
                id="mcp-address"
                value={address}
                placeholder={type === "stdio" ? "npx" : "https://mcp.example.com/mcp"}
                disabled={busy}
                spellCheck={false}
                onChange={(e) => setAddress(e.target.value)}
              />
            </div>
            {type === "stdio" && (
              <div className="grid gap-1.5">
                <Label htmlFor="mcp-args">{t("settingsE.mcp.s30")}</Label>
                <Input
                  id="mcp-args"
                  value={args}
                  disabled={busy}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder='["-y", "@example/mcp-server"]'
                />
              </div>
            )}
            <div className="grid gap-2">
              <Label>{type === "stdio" ? t("settingsE.mcp.s32") : t("settingsE.mcp.s33")}</Label>
              {rows.map((row, index) => (
                <div className="flex items-center gap-2" key={row.rowId}>
                  <div className="min-w-0 flex-1">
                    <Input
                      aria-label={t("settingsE.mcp.s34")}
                      placeholder={type === "stdio" ? "API_KEY" : "Authorization"}
                      disabled={busy}
                      value={row.key}
                      onChange={(e) =>
                        setRows(
                          rows.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)),
                        )
                      }
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <SecretInput
                      aria-label={t("settingsE.mcp.secretValue")}
                      value={row.draft}
                      configured={row.value !== ""}
                      disabled={busy}
                      onChange={(e) =>
                        setRows(
                          rows.map((r, i) => (i === index ? { ...r, draft: e.target.value } : r)),
                        )
                      }
                    />
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={t("settingsE.mcp.s35")}
                    disabled={busy}
                    onClick={() => setRows(rows.filter((_, i) => i !== index))}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setRows([...rows, { key: "", value: "", draft: "", rowId: `new:${nextRow}` }]);
                    setNextRow(nextRow + 1);
                  }}
                >
                  <PlusIcon />
                  {t("settingsE.mcp.s36")}
                </Button>
              </div>
            </div>
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
                <ChevronDownIcon />
                {t("settingsE.mcp.advanced")}
              </CollapsibleTrigger>
              <CollapsiblePanel animate={false}>
                <div className="grid gap-4 pt-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="mcp-id">{t("settingsE.mcp.s24")}</Label>
                    <Input
                      id="mcp-id"
                      disabled={!!editing.id || busy}
                      value={id}
                      aria-invalid={!!idError}
                      onChange={(e) => setCustomId(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">{t("settingsE.mcp.idHint")}</p>
                  </div>
                  {type === "stdio" && (
                    <div className="grid gap-1.5">
                      <Label htmlFor="mcp-cwd">{t("settingsE.mcp.s31")}</Label>
                      <Input
                        id="mcp-cwd"
                        value={cwd}
                        disabled={busy}
                        onChange={(e) => setCwd(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              </CollapsiblePanel>
            </Collapsible>
            {idError && (
              <p role="alert" className="text-xs text-destructive">
                {idError}
              </p>
            )}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            {t("settingsE.mcp.s21")}
          </Button>
          <Button
            type="submit"
            form="mcp-server-form"
            disabled={
              busy || !name.trim() || !address.trim() || (type === "stdio" && !localAllowed)
            }
          >
            {editing.id ? t("settingsE.mcp.s37") : t("settingsE.mcp.s5")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
