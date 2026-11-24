import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, McpConnector, ProviderInstanceId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
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
  const gt = useGT();
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
    } else setError(gt("Could not check Claude Code's servers."));
  }

  async function startSignIn(name: string) {
    setBusy(name);
    const result = await authorize({ environmentId, input: { instanceId, name, ...scope } });
    setBusy(null);
    if (result._tag !== "Success") {
      setError(gt("Could not start the sign-in to {name}.", { name }));
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
      setError(
        gt(
          "The address was not accepted. Copy the full address from the browser after signing in, or start again.",
        ),
      );
      return;
    }
    setAwaiting(null);
    await refresh();
  }

  const statusLabel = (connector: McpConnector) => {
    if (connector.authorizing) return gt("Waiting for sign-in");
    switch (connector.status) {
      case "connected":
        return gt("Connected");
      case "needs-auth":
        return gt("Needs sign-in");
      case "failed":
        return gt("Failed to connect");
      case "pending":
        return gt("Connecting");
      case "disabled":
        return gt("Turned off");
    }
  };
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
          ? gt("Claude Code connectors")
          : gt("Claude Code connectors · {instance}", { instance: label })
      }
      headerAction={
        <Button size="xs" variant="ghost" disabled={!allowed || busy !== null} onClick={refresh}>
          {connectors === null
            ? gt("Check", { $context: "verb, checks connectors" })
            : gt("Check again")}
        </Button>
      }
    >
      <p className="px-4 py-3 text-sm text-muted-foreground">
        <T>
          Servers Claude Code loads by itself: claude.ai connectors and servers from its own config.
          Checking starts them briefly. Sign in here so agents can use them.
        </T>
      </p>
      {!allowed && (
        <p role="status" className="px-4 py-2.5 text-sm text-muted-foreground">
          <T>Requires providers:manage.</T>
        </p>
      )}
      {busy === "list" && (
        <p role="status" className="px-4 py-2.5 text-sm text-muted-foreground">
          <T>Checking servers… this can take up to 20 seconds.</T>
        </p>
      )}
      {error && (
        <p role="alert" className="px-4 py-2.5 text-sm text-destructive">
          {error}
        </p>
      )}
      {connectors !== null && connectors.length === 0 && (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          <T>Claude Code has no servers of its own here.</T>
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
                <T>Sign in</T>
              </Button>
            ) : undefined
          }
        >
          {awaiting?.name === connector.name && (
            <div className="grid gap-2 px-4 pb-3">
              <p className="text-sm text-muted-foreground">
                <T>
                  Finish signing in in the browser. If it then shows a page that cannot be opened,
                  copy that page&apos;s address here.
                </T>
              </p>
              <div className="flex gap-2">
                <Input
                  aria-label={gt("Address after signing in")}
                  placeholder="http://localhost:…/callback?code=…"
                  value={awaiting.url}
                  onChange={(event) => setAwaiting({ ...awaiting, url: event.target.value })}
                />
                <Button
                  size="sm"
                  disabled={busy !== null || !awaiting.url.trim()}
                  onClick={finishSignIn}
                >
                  <T>Finish</T>
                </Button>
              </div>
            </div>
          )}
        </SettingsRow>
      ))}
      {connectors?.some((connector) => connector.auth === "claudeai" && signInable(connector)) && (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          <T>
            claude.ai connectors are signed in on claude.ai. When you are done there, select Check
            again; open threads reconnect automatically.
          </T>
        </p>
      )}
    </SettingsSection>
  );
}
