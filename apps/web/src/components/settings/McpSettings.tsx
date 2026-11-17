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
          ? `Could not read: ${result.value.unreadablePaths.join(", ")}`
          : "",
      );
    }
  }
  return (
    <SettingsPageContainer>
      <SettingsSection title={t("settingsE.mcp.s1")}>
        <p className="px-4 py-3 text-sm text-muted-foreground">{t("settingsE.mcp.s2")}</p>
        {!canEdit && <p role="status">{t("settingsE.mcp.s3")}</p>}
        {!localAllowed && <p role="status">{t("settingsE.mcp.s4")}</p>}
        {projectIds.length === 0 && (
          <div className="flex gap-2 px-4 py-2">
            <Button disabled={!canEdit || busy} onClick={() => setEditing({ id: "" })}>
              {t("settingsE.mcp.s5")}
            </Button>
            <Button disabled={!canEdit || busy} onClick={() => setPaste("")}>
              {t("settingsE.mcp.s6")}
            </Button>
            <Button disabled={!canEdit || busy} onClick={loadImports}>
              {t("settingsE.mcp.s7")}
            </Button>
          </div>
        )}
        {projectIds.length > 0 && (
          <Button disabled={!canEdit || busy} onClick={loadImports}>
            {t("settingsE.mcp.s38")}
          </Button>
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
                    <select
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
                      onChange={(e) => {
                        const enabled =
                          e.target.value === "inherit" ? {} : { enabled: e.target.value === "on" };
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
                      <option value="inherit">
                        {t("settingsE.mcp.s8")}
                        {config.enabled ? t("settingsE.mcp.s9") : t("settingsE.mcp.s10")})
                      </option>
                      <option value="on">{t("settingsE.mcp.s11")}</option>
                      <option value="off">{t("settingsE.mcp.s12")}</option>
                    </select>
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
                        onClick={() => {
                          if (window.confirm(`Delete MCP server ${id}?`))
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
        <SettingsSection title={t("settingsE.mcp.s7")}>
          <p>{t("settingsE.mcp.s15")}</p>
          {imports.map((entry) => (
            <SettingsRow
              key={JSON.stringify([entry.source, entry.sourcePath, entry.projectDir, entry.name])}
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
          <Button variant="ghost" onClick={() => setImports(null)}>
            {t("settingsE.mcp.s18")}
          </Button>
        </SettingsSection>
      )}
      {error && <p role="alert">{error}</p>}
      {editing && (
        <McpEditor
          key={editing.id}
          editing={editing}
          localAllowed={localAllowed}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={async (id, config) => {
            if (!editing.id && Object.hasOwn(settings.mcpServers, id)) {
              setError("This id already exists.");
              return;
            }
            if (await save({ mcpServers: { [id]: config } })) setEditing(null);
          }}
        />
      )}
      {paste !== null && (
        <SettingsSection title={t("settingsE.mcp.s6")}>
          <label>
            .mcp.json
            <Input
              aria-label={t("settingsE.mcp.s19")}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
            />
          </label>
          <Button
            disabled={busy}
            onClick={async () => {
              let configs;
              try {
                configs = parseMcpServerJson(paste);
                if (Object.keys(configs).some((id) => Object.hasOwn(settings.mcpServers, id)))
                  throw new Error("An id already exists.");
                if (
                  !localAllowed &&
                  Object.values(configs).some((c) => c.transport.type === "stdio")
                )
                  throw new Error("Local servers are not allowed.");
              } catch (e) {
                setError(String(e));
                return;
              }
              if (await save({ mcpServers: configs })) setPaste(null);
            }}
          >
            {t("settingsE.mcp.s20")}
          </Button>
          <Button onClick={() => setPaste(null)}>{t("settingsE.mcp.s21")}</Button>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function McpEditor({
  editing,
  localAllowed,
  busy,
  onSave,
  onCancel,
}: {
  editing: { id: string; config?: McpServerConfig };
  localAllowed: boolean;
  busy: boolean;
  onSave: (id: string, config: McpServerConfig) => Promise<void>;
  onCancel: () => void;
}) {
  const transport = editing.config?.transport;
  const [id, setId] = useState(editing.id);
  const [type, setType] = useState<"stdio" | "http">(transport?.type ?? "http");
  const [address, setAddress] = useState(
    transport?.type === "stdio" ? transport.command : (transport?.url ?? ""),
  );
  const [args, setArgs] = useState(
    JSON.stringify(transport?.type === "stdio" ? transport.args : []),
  );
  const [cwd, setCwd] = useState(transport?.type === "stdio" ? transport.cwd : "thread");
  const t = useT();
  const [nextRow, setNextRow] = useState(0);
  const [rows, setRows] = useState(() =>
    Object.entries(transport?.type === "stdio" ? transport.env : (transport?.headers ?? {})).map(
      ([key, value]) => ({ key, value, draft: "", rowId: key }),
    ),
  );
  const [error, setError] = useState("");
  return (
    <SettingsSection title={editing.id ? t("settingsE.mcp.s22") : t("settingsE.mcp.s23")}>
      <label>
        {t("settingsE.mcp.s24")}
        <Input disabled={!!editing.id} value={id} onChange={(e) => setId(e.target.value)} />
      </label>
      <label>
        {t("settingsE.mcp.s25")}
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value === "stdio" ? "stdio" : "http");
            setAddress("");
            setRows([]);
          }}
        >
          <option value="http">{t("settingsE.mcp.s26")}</option>
          <option value="stdio" disabled={!localAllowed}>
            {t("settingsE.mcp.s27")}
          </option>
        </select>
      </label>
      <label>
        {type === "stdio" ? t("settingsE.mcp.s28") : t("settingsE.mcp.s29")}
        <Input value={address} onChange={(e) => setAddress(e.target.value)} />
      </label>
      {type === "stdio" && (
        <>
          <label>
            {t("settingsE.mcp.s30")}
            <Input value={args} onChange={(e) => setArgs(e.target.value)} />
          </label>
          <label>
            {t("settingsE.mcp.s31")}
            <Input value={cwd} onChange={(e) => setCwd(e.target.value)} />
          </label>
        </>
      )}
      <p>{type === "stdio" ? t("settingsE.mcp.s32") : t("settingsE.mcp.s33")}</p>
      {rows.map((row, index) => (
        <div className="flex gap-2" key={row.rowId}>
          <Input
            aria-label={t("settingsE.mcp.s34")}
            value={row.key}
            onChange={(e) =>
              setRows(rows.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))
            }
          />
          <SecretInput
            aria-label={`Secret for ${row.key}`}
            value={row.draft}
            configured={row.value !== ""}
            onChange={(e) =>
              setRows(rows.map((r, i) => (i === index ? { ...r, draft: e.target.value } : r)))
            }
          />
          <Button variant="ghost" onClick={() => setRows(rows.filter((_, i) => i !== index))}>
            {t("settingsE.mcp.s35")}
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        onClick={() => {
          setRows([...rows, { key: "", value: "", draft: "", rowId: `new:${nextRow}` }]);
          setNextRow(nextRow + 1);
        }}
      >
        {t("settingsE.mcp.s36")}
      </Button>
      {error && <p role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button
          disabled={busy || (type === "stdio" && !localAllowed)}
          onClick={async () => {
            let config;
            try {
              decodeMcpId(id);
              if (new Set(rows.map((r) => r.key)).size !== rows.length)
                throw new Error("Duplicate keys.");
              const secrets = Object.fromEntries(rows.map((r) => [r.key, r.draft || r.value]));
              config = decodeMcpConfig({
                ...editing.config,
                enabled: editing.config?.enabled ?? false,
                transport:
                  type === "stdio"
                    ? { type, command: address, args: JSON.parse(args), cwd, env: secrets }
                    : { type, url: address, headers: secrets },
              });
            } catch (e) {
              setError(String(e));
              return;
            }
            await onSave(id, config);
          }}
        >
          {t("settingsE.mcp.s37")}
        </Button>
        <Button onClick={onCancel}>{t("settingsE.mcp.s21")}</Button>
      </div>
    </SettingsSection>
  );
}
