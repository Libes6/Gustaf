import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, McpConnector, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useT } from "../../useUiLanguage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Servers Claude Code loads from its own config and claude.ai account, with their sign-in. */
export function McpConnectorsSection({
  environmentId,
  projectDir,
}: {
  environmentId: EnvironmentId;
  projectDir?: string | undefined;
}) {
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const claudeInstances = providers.filter(
    (provider) => provider.driver === "claudeAgent" && provider.enabled,
  );
  return (
    <>
      {claudeInstances.map((provider) => (
        <ConnectorInstanceSection
          key={provider.instanceId}
          environmentId={environmentId}
          instanceId={provider.instanceId}
          label={claudeInstances.length > 1 ? (provider.displayName ?? provider.instanceId) : null}
          projectDir={projectDir}
        />
      ))}
    </>
  );
}

function ConnectorInstanceSection({
  environmentId,
  instanceId,
  label,
  projectDir,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  label: string | null;
  projectDir?: string | undefined;
}) {
  const t = useT();
  const allowed = useAtomValue(serverEnvironment.mcpListConnectors.permissionAtom(environmentId));
  const list = useAtomCommand(serverEnvironment.mcpListConnectors, { reportFailure: false });
  const authorize = useAtomCommand(serverEnvironment.authorizeMcpConnector, {
    reportFailure: false,
  });
  const submitCallback = useAtomCommand(serverEnvironment.submitMcpConnectorCallback, {
    reportFailure: false,
  });
  const [connectors, setConnectors] = useState<readonly McpConnector[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // A loopback sign-in whose browser may be on another device; its landing address can be pasted.
  const [awaiting, setAwaiting] = useState<{ name: string; url: string } | null>(null);
  const scope = projectDir ? { projectDir } : {};

  async function refresh() {
    setBusy("list");
    const result = await list({ environmentId, input: { instanceId, ...scope } });
    setBusy(null);
    if (result._tag === "Success") {
      setConnectors(result.value.connectors);
      setError("");
    } else setError(t("settingsE.mcp.connectors.listFailed"));
  }

  async function startSignIn(name: string) {
    setBusy(name);
    const result = await authorize({ environmentId, input: { instanceId, name, ...scope } });
    setBusy(null);
    if (result._tag !== "Success") {
      setError(t("settingsE.mcp.connectors.authorizeFailed").replace("{name}", name));
      return;
    }
    setError("");
    if (result.value.authUrl) void ensureLocalApi().shell.openExternal(result.value.authUrl);
    setAwaiting(result.value.callbackExpected ? { name, url: "" } : null);
  }

  async function finishSignIn() {
    if (!awaiting?.url.trim()) return;
    setBusy(awaiting.name);
    const result = await submitCallback({
      environmentId,
      input: { instanceId, name: awaiting.name, callbackUrl: awaiting.url.trim() },
    });
    setBusy(null);
    if (result._tag !== "Success") {
      setError(t("settingsE.mcp.connectors.callbackFailed"));
      return;
    }
    setAwaiting(null);
    await refresh();
  }

  const statusLabel = (connector: McpConnector) =>
    connector.authorizing
      ? t("settingsE.mcp.connectors.status.authorizing")
      : t(`settingsE.mcp.connectors.status.${connector.status}`);
  const signInable = (connector: McpConnector) =>
    connector.auth !== "none" &&
    connector.status !== "connected" &&
    connector.status !== "disabled";
  const sorted = [...(connectors ?? [])].sort(
    (a, b) => Number(signInable(b)) - Number(signInable(a)) || a.name.localeCompare(b.name),
  );

  return (
    <SettingsSection
      title={
        label === null
          ? t("settingsE.mcp.connectors.title")
          : t("settingsE.mcp.connectors.titleFor").replace("{instance}", label)
      }
      headerAction={
        <Button size="xs" variant="ghost" disabled={!allowed || busy !== null} onClick={refresh}>
          {connectors === null
            ? t("settingsE.mcp.connectors.check")
            : t("settingsE.mcp.connectors.recheck")}
        </Button>
      }
    >
      <p className="px-4 py-3 text-sm text-muted-foreground">
        {t("settingsE.mcp.connectors.hint")}
      </p>
      {!allowed && <p role="status">{t("settingsE.mcp.connectors.permission")}</p>}
      {busy === "list" && <p role="status">{t("settingsE.mcp.connectors.checking")}</p>}
      {error && <p role="alert">{error}</p>}
      {connectors !== null && connectors.length === 0 && (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {t("settingsE.mcp.connectors.empty")}
        </p>
      )}
      {sorted.map((connector) => (
        <SettingsRow
          key={connector.name}
          title={connector.name}
          description={[statusLabel(connector), connector.source].filter(Boolean).join(" · ")}
          control={
            signInable(connector) ? (
              <Button
                size="xs"
                variant="outline"
                disabled={!allowed || busy !== null}
                onClick={() => startSignIn(connector.name)}
              >
                {t("settingsE.mcp.connectors.authorize")}
              </Button>
            ) : undefined
          }
        >
          {awaiting?.name === connector.name && (
            <div className="grid gap-2 px-4 pb-3">
              <p className="text-sm text-muted-foreground">
                {t("settingsE.mcp.connectors.pasteHint")}
              </p>
              <div className="flex gap-2">
                <Input
                  aria-label={t("settingsE.mcp.connectors.pasteLabel")}
                  placeholder="http://localhost:…/callback?code=…"
                  value={awaiting.url}
                  onChange={(event) => setAwaiting({ ...awaiting, url: event.target.value })}
                />
                <Button
                  size="sm"
                  disabled={busy !== null || !awaiting.url.trim()}
                  onClick={finishSignIn}
                >
                  {t("settingsE.mcp.connectors.finish")}
                </Button>
              </div>
            </div>
          )}
        </SettingsRow>
      ))}
      {connectors?.some((connector) => connector.auth === "claudeai" && signInable(connector)) && (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {t("settingsE.mcp.connectors.claudeAiHint")}
        </p>
      )}
    </SettingsSection>
  );
}
