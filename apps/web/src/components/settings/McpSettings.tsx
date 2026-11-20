import { useAtomValue } from "@effect/atom-react";
import {
  McpServerConfig,
  McpServerId,
  type EnvironmentId,
  type McpImportableServer,
  type McpServerStatus,
  PROVIDER_DISPLAY_NAMES,
  type ProjectId,
  type ProviderDriverKind,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { parseMcpServerJson } from "@t3tools/client-runtime/mcp-server-input";
import * as Schema from "effect/Schema";
import { useT } from "../../useUiLanguage";
import { useEffect, useEffectEvent, useState } from "react";
import { ChevronDownIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { ensureLocalApi } from "../../localApi";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { useEnvironmentHttpBaseUrl, useEnvironmentProviders } from "../../state/environments";
import { Checkbox } from "../ui/checkbox";
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
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useManagedPolicy } from "../../state/managedPolicy";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { McpConnectorsSection } from "./McpConnectorsSection";
import {
  currentMcpStatus,
  groupMcpTools,
  mcpStatusKey,
  mcpToolFilterUnsupported,
  mcpToolGroupMode,
  recordMcpStatuses,
  setMcpToolsEnabled,
  withDisabledTools,
  type McpCheckedStatuses,
  type McpToolGroupMode,
} from "./McpSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const isMcpId = Schema.is(McpServerId);
const decodeMcpId = Schema.decodeSync(McpServerId);
const decodeMcpConfig = Schema.decodeUnknownSync(McpServerConfig);

const driverName = (driver: ProviderDriverKind) =>
  PROVIDER_DISPLAY_NAMES[driver] ?? formatProviderDriverKindLabel(driver);

// React Compiler skips components that throw inside try, so parsing stays out here.
function parsePastedServers(paste: string) {
  try {
    return parseMcpServerJson(paste);
  } catch {
    return undefined;
  }
}

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
  const canCheck = useAtomValue(serverEnvironment.mcpServerStatus.permissionAtom(environmentId));
  const checkServers = useAtomCommand(serverEnvironment.mcpServerStatus, { reportFailure: false });
  // Each answer with the config it was asked for, so an edited server shows as checking.
  const [checked, setChecked] = useState<McpCheckedStatuses>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const serversKey = JSON.stringify(
    Object.entries(settings.mcpServers).map(([id, config]) => [id, mcpStatusKey(config)]),
  );
  const hasServers = Object.keys(settings.mcpServers).length > 0;
  function applyCheck(
    configs: typeof settings.mcpServers,
    result: Awaited<ReturnType<typeof checkServers>>,
  ) {
    setCheckFailed(result._tag !== "Success");
    if (result._tag !== "Success") return;
    setChecked((previous) => recordMcpStatuses(previous, configs, result.value.servers));
  }
  const checkCurrent = useEffectEvent((isCurrent: () => boolean) => {
    const configs = settings.mcpServers;
    void checkServers({ environmentId, input: {} }).then((result) => {
      if (isCurrent()) applyCheck(configs, result);
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Checking starts servers on the environment; it runs when the section opens and when a server's config changes.
  useEffect(() => {
    if (!canCheck || !hasServers) return;
    let current = true;
    checkCurrent(() => current);
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A server's config changing is what asks for a new check.
  }, [canCheck, environmentId, hasServers, serversKey]);
  /** `configs` must be what the environment holds now; after a save, the settings here lag. */
  async function refreshStatuses(
    ids: readonly McpServerId[],
    configs?: typeof settings.mcpServers,
  ) {
    setRefreshing(true);
    const result = await checkServers({ environmentId, input: { refresh: ids } });
    setRefreshing(false);
    applyCheck(configs ?? settings.mcpServers, result);
    return result;
  }
  const signIn = useAtomCommand(serverEnvironment.signInMcpServer);
  const submitSignIn = useAtomCommand(serverEnvironment.submitMcpServerSignInCallback);
  const signOut = useAtomCommand(serverEnvironment.signOutMcpServer);
  // Sign-ins whose browser may be on another device; each landing address can be pasted.
  const [awaitingSignIn, setAwaitingSignIn] = useState<
    Readonly<Partial<Record<McpServerId, { url: string; authUrl: string }>>>
  >({});
  const awaitingIds = Object.keys(awaitingSignIn) as McpServerId[];
  function setAwaiting(id: McpServerId, value: { url: string; authUrl: string } | undefined) {
    setAwaitingSignIn((previous) => {
      const next: Partial<Record<McpServerId, { url: string; authUrl: string }>> = { ...previous };
      if (value === undefined) delete next[id];
      else next[id] = value;
      return next;
    });
  }
  // Only a browser on the environment's machine reaches its loopback callback.
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const sameMachine = httpBaseUrl !== null && isLoopbackHost(new URL(httpBaseUrl).hostname);
  const [signingIn, setSigningIn] = useState(false);
  async function startSignIn(id: McpServerId) {
    setSigningIn(true);
    const result = await signIn({ environmentId, input: { id } });
    setSigningIn(false);
    if (result._tag !== "Success") return;
    void ensureLocalApi().shell.openExternal(result.value.authUrl);
    setAwaiting(id, { url: "", authUrl: result.value.authUrl });
  }
  async function finishSignIn(id: McpServerId) {
    const callbackUrl = awaitingSignIn[id]?.url.trim();
    if (!callbackUrl) return;
    setSigningIn(true);
    const result = await submitSignIn({ environmentId, input: { callbackUrl } });
    setSigningIn(false);
    if (result._tag !== "Success") return;
    setAwaiting(result.value.id, undefined);
    await refreshStatuses([result.value.id]);
  }
  async function endSignIn(id: McpServerId) {
    setSigningIn(true);
    const result = await signOut({ environmentId, input: { id } });
    setSigningIn(false);
    if (result._tag === "Success") await refreshStatuses([id]);
  }
  const recheckAwaited = useEffectEvent(async () => {
    if (awaitingIds.length === 0) return;
    const result = await refreshStatuses(awaitingIds);
    if (result._tag !== "Success") return;
    for (const server of result.value.servers) {
      if (server.signedIn && awaitingIds.includes(server.id)) setAwaiting(server.id, undefined);
    }
  });
  const awaitingAny = awaitingIds.length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A sign-in finished in the browser lands on the environment; returning to the window is when to look.
  useEffect(() => {
    if (!awaitingAny) return;
    const onFocus = () => void recheckAwaited();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [awaitingAny]);
  function currentStatus(id: McpServerId) {
    return currentMcpStatus(checked, id, settings.mcpServers[id]);
  }
  function signInControl(id: McpServerId) {
    const status = currentStatus(id);
    // A stored sign-in the server no longer accepts offers both: sign in again, or drop it.
    const canSignIn = status?.status === "needs-auth" && awaitingSignIn[id] === undefined;
    return (
      <>
        {canSignIn && (
          <Button size="xs" disabled={!canCheck || signingIn} onClick={() => startSignIn(id)}>
            {t("settingsE.mcp.signIn.start")}
          </Button>
        )}
        {status?.signedIn && (
          <Button
            size="xs"
            variant="outline"
            disabled={!canCheck || signingIn}
            onClick={() => endSignIn(id)}
          >
            {t("settingsE.mcp.signIn.signOut")}
          </Button>
        )}
      </>
    );
  }
  function signInPrompt(id: McpServerId) {
    const awaiting = awaitingSignIn[id];
    if (awaiting === undefined) return null;
    return (
      <div className="grid gap-2 px-4 pb-3">
        <p className="text-sm text-muted-foreground">
          {t(
            sameMachine ? "settingsE.mcp.signIn.pasteHint" : "settingsE.mcp.signIn.pasteHintRemote",
          )}
        </p>
        {/* Opened after an await, the window can be blocked as a popup; this link always works. */}
        <a
          href={awaiting.authUrl}
          target="_blank"
          rel="noreferrer"
          className="justify-self-start text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {t("settingsE.mcp.signIn.openPage")}
        </a>
        <div className="flex gap-2">
          <Input
            aria-label={t("settingsE.mcp.signIn.pasteLabel")}
            placeholder="http://127.0.0.1:…/mcp-oauth/callback?code=…"
            value={awaiting.url}
            onChange={(event) => setAwaiting(id, { ...awaiting, url: event.target.value })}
          />
          <Button
            size="sm"
            disabled={signingIn || !awaiting.url.trim()}
            onClick={() => finishSignIn(id)}
          >
            {t("settingsE.mcp.signIn.finish")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAwaiting(id, undefined)}>
            {t("settingsE.mcp.signIn.cancel")}
          </Button>
        </div>
      </div>
    );
  }
  function statusLine(id: McpServerId) {
    if (!canCheck) return undefined;
    const status = currentStatus(id);
    if (status === undefined) {
      return checkFailed && !refreshing ? undefined : (
        <McpStatusLine dot="bg-muted-foreground/40" text={t("settingsE.mcp.status.checking")} />
      );
    }
    switch (status.status) {
      case "connected": {
        const tools = String(status.tools?.length ?? 0);
        return (
          <McpStatusLine
            dot="bg-success"
            text={
              status.resourceCount
                ? t("settingsE.mcp.status.toolsAndResources")
                    .replace("{tools}", tools)
                    .replace("{resources}", String(status.resourceCount))
                : t("settingsE.mcp.status.tools").replace("{tools}", tools)
            }
          />
        );
      }
      case "needs-auth":
        return (
          <McpStatusLine dot="bg-warning" text={t("settingsE.mcp.connectors.status.needs-auth")} />
        );
      case "failed":
        return (
          <McpStatusLine
            dot="bg-destructive"
            text={status.error ?? t("settingsE.mcp.connectors.status.failed")}
          />
        );
      case "pending":
      case "disabled":
        return (
          <McpStatusLine
            dot="bg-muted-foreground/40"
            text={t(`settingsE.mcp.connectors.status.${status.status}`)}
          />
        );
    }
  }
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; config?: McpServerConfig } | null>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const [imports, setImports] = useState<readonly McpImportableServer[] | null>(null);
  const [toolsFor, setToolsFor] = useState<McpServerId | null>(null);
  const installedDrivers = (useEnvironmentProviders().get(environmentId) ?? [])
    .filter((provider) => provider.installed)
    .map((provider) => provider.driver);
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
            {canCheck && hasServers && (
              <Button
                size="xs"
                variant="ghost"
                disabled={refreshing}
                onClick={() => refreshStatuses(Object.keys(settings.mcpServers) as McpServerId[])}
              >
                {t("settingsE.mcp.status.refresh")}
              </Button>
            )}
          </div>
        }
      >
        <p className="px-4 py-3 text-sm text-muted-foreground">{t("settingsE.mcp.s2")}</p>
        {!canEdit && <p role="status">{t("settingsE.mcp.s3")}</p>}
        {!localAllowed && <p role="status">{t("settingsE.mcp.s4")}</p>}
        {checkFailed && <p role="alert">{t("settingsE.mcp.status.listFailed")}</p>}
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
              description={`${id} · ${config.transport.type} · ${config.transport.type === "stdio" ? [config.transport.command, ...config.transport.args].join(" ") : config.transport.url} · ${
                config.providers === undefined
                  ? t("settingsE.mcp.agentsAll")
                  : config.providers.length === 0
                    ? t("settingsE.mcp.agentsNone")
                    : t("settingsE.mcp.agentsOnly").replace(
                        "{names}",
                        config.providers.map(driverName).join(", "),
                      )
              }`}
              status={statusLine(id)}
              control={
                <div className="flex items-center gap-2">
                  {signInControl(id)}
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
                      {currentStatus(id)?.status === "connected" && (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={!canEdit}
                          onClick={() => setToolsFor(id)}
                        >
                          {t("settingsE.mcp.tools.open")}
                        </Button>
                      )}
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
            >
              {signInPrompt(id)}
            </SettingsRow>
          ),
        )}
      </SettingsSection>
      <McpConnectorsSection environmentId={environmentId} projectDir={projectDir} />
      {toolsFor !== null && settings.mcpServers[toolsFor] !== undefined && (
        <McpToolsDialog
          key={toolsFor}
          id={toolsFor}
          config={settings.mcpServers[toolsFor]}
          status={currentStatus(toolsFor)}
          unsupported={mcpToolFilterUnsupported(
            settings.mcpServers[toolsFor].providers,
            installedDrivers,
          )}
          disabled={!canEdit}
          refreshing={refreshing}
          onSave={(config) => save({ mcpServers: { [toolsFor]: config } })}
          onRefresh={() => refreshStatuses([toolsFor])}
          onClose={() => setToolsFor(null)}
        />
      )}
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
              <DialogDescription>
                {t("settingsE.mcp.s15")} {t("settingsE.mcp.importAgents")}
              </DialogDescription>
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
          environmentId={environmentId}
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
            if (await save({ mcpServers: { [id]: config } })) {
              setEditing(null);
              // A changed secret keeps its reference, so the config alone would not show it.
              if (canCheck && config.enabled) {
                const mcpId = decodeMcpId(id);
                void refreshStatuses([mcpId], { ...settings.mcpServers, [mcpId]: config });
              }
            }
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
                  const configs = parsePastedServers(paste);
                  const problem =
                    configs === undefined
                      ? "settingsE.mcp.jsonInvalid"
                      : Object.keys(configs).some((id) => Object.hasOwn(settings.mcpServers, id))
                        ? "settingsE.mcp.idTaken"
                        : !localAllowed &&
                            Object.values(configs).some((c) => c.transport.type === "stdio")
                          ? "settingsE.mcp.localDisallowed"
                          : undefined;
                  if (configs === undefined || problem !== undefined) {
                    setError(t(problem ?? "settingsE.mcp.jsonInvalid"));
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

function McpToolsDialog({
  id,
  config,
  status,
  unsupported,
  disabled,
  refreshing,
  onSave,
  onRefresh,
  onClose,
}: {
  id: McpServerId;
  config: McpServerConfig;
  status: McpServerStatus | undefined;
  unsupported: readonly ProviderDriverKind[];
  disabled: boolean;
  refreshing: boolean;
  onSave: (config: McpServerConfig) => Promise<boolean>;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const t = useT();
  // Switches answer at once; each change is saved in the background.
  const [off, setOff] = useState<readonly string[]>(config.disabledTools ?? []);
  // Picking "Custom" keeps the group's switches as they are until one changes.
  const [customGroups, setCustomGroups] = useState<ReadonlySet<string>>(new Set());
  const tools = status?.status === "connected" ? (status.tools ?? []) : undefined;
  const { reads, writes } = groupMcpTools(tools ?? []);
  const names = [...reads, ...writes];
  const enabledCount = names.filter((name) => !off.includes(name)).length;
  function apply(next: readonly string[]) {
    setOff(next);
    void onSave(withDisabledTools(config, next));
  }
  const modeLabels: Record<McpToolGroupMode, string> = {
    all: t("settingsE.mcp.tools.allowAll"),
    none: t("settingsE.mcp.tools.allowNone"),
    custom: t("settingsE.mcp.tools.custom"),
  };
  const modeItems = (Object.keys(modeLabels) as McpToolGroupMode[]).map((value) => ({
    value,
    label: modeLabels[value],
  }));
  function group(key: "reads" | "writes", groupNames: readonly string[]) {
    if (groupNames.length === 0) return null;
    const mode = customGroups.has(key) ? "custom" : mcpToolGroupMode(groupNames, off);
    const title = t(`settingsE.mcp.tools.${key}`);
    return (
      <section className="grid gap-1 rounded-lg border p-2">
        <div className="flex items-center justify-between gap-2 px-1">
          <h3 className="text-sm font-medium">{title}</h3>
          <Select
            items={modeItems}
            value={mode}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === null) return;
              setCustomGroups((previous) => {
                const next = new Set(previous);
                if (value === "custom") next.add(key);
                else next.delete(key);
                return next;
              });
              if (value !== "custom") apply(setMcpToolsEnabled(off, groupNames, value === "all"));
            }}
          >
            <SelectTrigger size="xs" className="w-auto" aria-label={title}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {modeItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        {groupNames.map((name) => (
          <label
            key={name}
            className="flex items-center justify-between gap-3 rounded-md px-1 py-1.5 text-sm"
          >
            <span className="min-w-0 break-all font-mono text-xs">{name}</span>
            <Switch
              checked={!off.includes(name)}
              disabled={disabled}
              onCheckedChange={(enabled) => apply(setMcpToolsEnabled(off, [name], enabled))}
            />
          </label>
        ))}
      </section>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("settingsE.mcp.tools.title").replace("{name}", config.name ?? id)}
          </DialogTitle>
          <DialogDescription>
            {tools === undefined
              ? t("settingsE.mcp.tools.unknown")
              : t("settingsE.mcp.tools.count")
                  .replace("{enabled}", String(enabledCount))
                  .replace("{total}", String(names.length))}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            {unsupported.length > 0 && (
              <p role="note" className="text-sm text-muted-foreground">
                {t("settingsE.mcp.tools.unsupported").replace(
                  "{names}",
                  unsupported.map(driverName).join(", "),
                )}
              </p>
            )}
            {tools !== undefined && names.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("settingsE.mcp.tools.none")}</p>
            )}
            {group("reads", reads)}
            {group("writes", writes)}
          </div>
        </DialogPanel>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" disabled={refreshing} onClick={onRefresh}>
            {t("settingsE.mcp.status.refresh")}
          </Button>
          <Button onClick={onClose}>{t("settingsE.mcp.tools.done")}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function McpStatusLine({ dot, text }: { dot: string; text: string }) {
  return (
    <span className="flex items-start gap-1.5">
      <span className="flex h-4 items-center">
        <ConnectionStatusDot dotClassName={dot} />
      </span>
      <span className="line-clamp-3 whitespace-pre-wrap break-words">{text}</span>
    </span>
  );
}

function McpEditor({
  environmentId,
  editing,
  localAllowed,
  busy,
  existingIds,
  onSave,
  onCancel,
}: {
  environmentId: EnvironmentId;
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
  const [agents, setAgents] = useState<readonly ProviderDriverKind[] | null>(
    editing.config?.providers ?? null,
  );
  const installedDrivers = (useEnvironmentProviders().get(environmentId) ?? [])
    .filter((provider) => provider.installed)
    .map((provider) => provider.driver);
  const agentChoices = [...new Set([...installedDrivers, ...(agents ?? [])])];

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
      const { providers: _providers, ...previous } = editing.config ?? {};
      config = decodeMcpConfig({
        ...previous,
        ...(agents === null ? {} : { providers: agents }),
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
                // i18n-ignore -- Figma is a product name.
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
              <Label htmlFor="mcp-agents">{t("settingsE.mcp.agents")}</Label>
              <Select
                value={agents === null ? "all" : "selected"}
                disabled={busy}
                onValueChange={(value) => setAgents(value === "selected" ? (agents ?? []) : null)}
              >
                <SelectTrigger id="mcp-agents">
                  <SelectValue>
                    {agents === null
                      ? t("settingsE.mcp.agentsAll")
                      : t("settingsE.mcp.agentsSelected")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="all">{t("settingsE.mcp.agentsAll")}</SelectItem>
                  <SelectItem value="selected">{t("settingsE.mcp.agentsSelected")}</SelectItem>
                </SelectPopup>
              </Select>
              {agents !== null &&
                agentChoices.map((driver) => (
                  <label key={driver} className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      checked={agents.includes(driver)}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        setAgents(
                          checked === true
                            ? [...agents, driver]
                            : agents.filter((entry) => entry !== driver),
                        )
                      }
                    />
                    {driverName(driver)}
                  </label>
                ))}
            </div>
            <div className="grid gap-2">
              <Label>{type === "stdio" ? t("settingsE.mcp.s32") : t("settingsE.mcp.s33")}</Label>
              {rows.map((row, index) => (
                <div className="flex items-center gap-2" key={row.rowId}>
                  <div className="min-w-0 flex-1">
                    <Input
                      aria-label={t("settingsE.mcp.s34")}
                      // i18n-ignore -- These are literal environment variable and HTTP header names.
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
