import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  isManagedSettingPath,
  McpServerId,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { t } from "../../i18n";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { mcpEnabledPatch, mcpServerAddress } from "./mcp-settings";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { resolveMobileSettingsTargets } from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

export function SettingsMcpRouteScreen() {
  const menu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={t("MCP servers")} menus={[menu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="text-sm text-foreground-muted">
          {t(
            "These switches apply to the whole environment. Add or edit MCP servers on web or desktop.",
          )}
        </Text>
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">{t("Select a connected environment.")}</Text>
        ) : (
          selectedTargets.map((environment) => (
            <EnvironmentMcpServers key={environment.environmentId} environment={environment} />
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function EnvironmentMcpServers({ environment }: { readonly environment: SettingsTarget }) {
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
  return (
    <SettingsSection title={environment.label}>
      {!canWrite ? (
        <Text className="p-4 text-sm text-foreground-muted">
          {t("Changing MCP servers requires settings and provider management permissions.")}
        </Text>
      ) : null}
      {!terminalScope ? (
        <Text className="p-4 text-sm text-foreground-muted">
          {t("Changing local MCP servers also requires terminal access.")}
        </Text>
      ) : null}
      {!localAllowed ? (
        <Text className="p-4 text-sm text-foreground-muted">
          {t("Your organization does not allow local MCP servers.")}
        </Text>
      ) : null}
      {servers.length === 0 ? (
        <Text className="p-4 text-foreground-muted">{t("No MCP servers configured.")}</Text>
      ) : null}
      {servers.map(([key, server]) => {
        const id = McpServerId.make(key);
        const local = server.transport.type === "stdio";
        const locked = isManagedSettingPath(policy, `mcpServers.${id}`);
        return (
          <SettingsSwitchRow
            key={id}
            label={server.name ?? id}
            subtitle={`${local ? t("Local (stdio)") : t("Remote (HTTP)")} · ${mcpServerAddress(server)}${locked ? ` · ${t("Managed by your organization")}` : ""}`}
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
        );
      })}
    </SettingsSection>
  );
}
