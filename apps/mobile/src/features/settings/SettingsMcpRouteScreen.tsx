import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  isManagedSettingPath,
  McpServerId,
} from "@t3tools/contracts";
import {
  catalogEntryToMcpServerConfig,
  MCP_CATALOG,
  type McpCatalogEntry,
} from "@t3tools/shared/mcpCatalog";
import { T, useGT, useLocale, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { mcpEnabledPatch, mcpServerAddress, mcpServerAgents } from "./mcp-settings";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { resolveMobileSettingsTargets } from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

export function SettingsMcpRouteScreen() {
  const gt = useGT();
  const menu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={gt("MCP servers")} menus={[menu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="text-sm text-foreground-muted">
          <T>
            These switches apply to the whole environment. Install remote servers from the
            marketplace below, or edit custom configs on web or desktop.
          </T>
        </Text>
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">
            <T>Select a connected environment.</T>
          </Text>
        ) : (
          selectedTargets.map((environment) => (
            <View key={environment.environmentId} className="gap-6">
              <EnvironmentMcpServers environment={environment} />
              <EnvironmentMcpMarketplace environment={environment} />
            </View>
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function EnvironmentMcpServers({ environment }: { readonly environment: SettingsTarget }) {
  const gt = useGT();
  const messages = useMessages();
  const settingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const providersScope = useEnvironmentScope(environment.environmentId, AuthProvidersManageScope);
  const terminalScope = useEnvironmentScope(environment.environmentId, AuthTerminalOperateScope);
  const canWrite = settingsScope && providersScope;
  const policy = environment.serverConfig.managedPolicy;
  const localAllowed = policy?.limits?.localMcpServers !== false;
  const writeSettings = useSettingsWriter();
  const [pending, setPending] = useState(false);
  const writing = useRef(false);
  const servers = Object.entries(environment.serverConfig.settings.mcpServers);
  const hasNotice = !canWrite || !terminalScope || !localAllowed;

  return (
    <SettingsSection title={environment.label}>
      {!canWrite ? (
        <Text className="p-4 text-sm text-foreground-muted">
          <T>Changing MCP servers requires settings and provider management permissions.</T>
        </Text>
      ) : null}
      {!terminalScope ? (
        <Text className="p-4 text-sm text-foreground-muted">
          <T>Changing local MCP servers also requires terminal access.</T>
        </Text>
      ) : null}
      {!localAllowed ? (
        <Text className="p-4 text-sm text-foreground-muted">
          <T>Your organization does not allow local MCP servers.</T>
        </Text>
      ) : null}
      {servers.length === 0 ? (
        <Text
          className={cn("p-4 text-foreground-muted", hasNotice && "border-t border-border-subtle")}
        >
          <T>No MCP servers configured.</T>
        </Text>
      ) : null}
      {servers.map(([key, server], index) => {
        const id = McpServerId.make(key);
        const local = server.transport.type === "stdio";
        const locked = isManagedSettingPath(policy, `mcpServers.${id}`);
        return (
          <View
            key={id}
            className={index > 0 || hasNotice ? "border-t border-border-subtle" : undefined}
          >
            <SettingsSwitchRow
              label={server.name ?? id}
              subtitle={[
                local ? gt("Local (stdio)") : gt("Remote (HTTP)"),
                mcpServerAddress(server),
                mcpServerAgents(server, messages),
                locked ? gt("Managed by your organization") : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              value={server.enabled}
              disabled={
                pending || !canWrite || locked || (local && (!localAllowed || !terminalScope))
              }
              onValueChange={(enabled) => {
                if (
                  writing.current ||
                  !readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope) ||
                  !readEnvironmentScope(environment.environmentId, AuthProvidersManageScope) ||
                  (local &&
                    !readEnvironmentScope(environment.environmentId, AuthTerminalOperateScope))
                )
                  return;
                writing.current = true;
                setPending(true);
                void writeSettings(resolveMobileSettingsTargets([environment], null), [
                  {
                    environmentId: environment.environmentId,
                    patch: mcpEnabledPatch(id, server, enabled),
                  },
                ]).finally(() => {
                  writing.current = false;
                  setPending(false);
                });
              }}
            />
          </View>
        );
      })}
    </SettingsSection>
  );
}

const REMOTE_MARKETPLACE_ENTRIES: ReadonlyArray<McpCatalogEntry> = MCP_CATALOG.filter(
  (entry) => entry.transport.type === "http" && entry.requiredSecrets.length === 0,
);

function isCatalogEntryInstalled(
  installed: Readonly<
    Record<string, { readonly transport: { readonly type: string; readonly url?: string } }>
  >,
  entry: McpCatalogEntry,
): boolean {
  if (Object.hasOwn(installed, entry.id)) return true;
  if (entry.transport.type !== "http") return false;
  const targetUrl = entry.transport.url.trim().replace(/\/+$/, "").toLowerCase();
  return Object.values(installed).some(
    (config) =>
      config.transport.type === "http" &&
      config.transport.url?.trim().replace(/\/+$/, "").toLowerCase() === targetUrl,
  );
}

function EnvironmentMcpMarketplace({ environment }: { readonly environment: SettingsTarget }) {
  const gt = useGT();
  const locale = useLocale();
  const settingsScope = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const providersScope = useEnvironmentScope(environment.environmentId, AuthProvidersManageScope);
  const canWrite = settingsScope && providersScope;
  const writeSettings = useSettingsWriter();
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const writing = useRef(false);
  const installed = environment.serverConfig.settings.mcpServers;
  const visibleEntries = expanded
    ? REMOTE_MARKETPLACE_ENTRIES
    : REMOTE_MARKETPLACE_ENTRIES.slice(0, 6);
  const useRuDescription = locale.toLowerCase().startsWith("ru");

  return (
    <SettingsSection
      title={gt("MCP Marketplace · {environment}", { environment: environment.label })}
    >
      {visibleEntries.map((entry, index) => {
        const alreadyInstalled = isCatalogEntryInstalled(installed, entry);
        const isInstalling = installingId === entry.id;
        return (
          <View
            key={entry.id}
            className={cn(
              "flex-row items-center justify-between gap-3 px-4 py-3",
              index > 0 && "border-t border-border-subtle",
            )}
          >
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-sm font-t3-medium text-foreground">{entry.name}</Text>
              <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                {useRuDescription ? entry.descriptionRu : entry.descriptionEn}
              </Text>
            </View>
            <Button
              size="compact"
              tone={alreadyInstalled ? "secondary" : "primary"}
              label={alreadyInstalled ? gt("Installed") : gt("Install")}
              loading={isInstalling}
              disabled={!canWrite || alreadyInstalled || installingId !== null}
              onPress={() => {
                if (
                  writing.current ||
                  !readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope) ||
                  !readEnvironmentScope(environment.environmentId, AuthProvidersManageScope)
                )
                  return;
                writing.current = true;
                setInstallingId(entry.id);
                const config = catalogEntryToMcpServerConfig(entry);
                void writeSettings(resolveMobileSettingsTargets([environment], null), [
                  {
                    environmentId: environment.environmentId,
                    patch: { mcpServers: { [entry.id]: config } },
                  },
                ]).finally(() => {
                  writing.current = false;
                  setInstallingId(null);
                });
              }}
            />
          </View>
        );
      })}
      {REMOTE_MARKETPLACE_ENTRIES.length > 6 ? (
        <View className="border-t border-border-subtle px-4 py-2.5">
          <Button
            size="compact"
            tone="text"
            label={expanded ? gt("Show fewer") : gt("Show all remote servers")}
            onPress={() => setExpanded((current) => !current)}
          />
        </View>
      ) : null}
    </SettingsSection>
  );
}
