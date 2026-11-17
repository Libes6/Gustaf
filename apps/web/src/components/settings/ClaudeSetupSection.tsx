import {
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { managedInstanceLocks, useManagedPolicy } from "../../state/managedPolicy";
import { useT } from "../../useUiLanguage";
import { Button } from "../ui/button";
import { readCodexSetupMode } from "./CodexSetupSection.logic";
import { ProviderSetupSection } from "./ProviderSetupSection";
import { SettingsRow } from "./settingsLayout";

const CLAUDE = ProviderDriverKind.make("claudeAgent");

export function ClaudeSetupSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly config: unknown;
  readonly binaryPath: string;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => void;
  readonly onModeChange: (mode: "managed" | "existing") => void;
}) {
  const t = useT();
  const locked = managedInstanceLocks(
    useManagedPolicy(props.environmentId),
    CLAUDE,
  )?.configKeys.has("setupMode");
  const mode = readCodexSetupMode(props.config);
  const customBinary = props.binaryPath !== "" && props.binaryPath !== "claude";
  if (mode === "existing") {
    if (props.readOnly || locked || customBinary) return null;
    return (
      <SettingsRow
        title={t("settingsC.claudeSetup.managedTitle")}
        description={t("settingsC.claudeSetup.managedDesc").replace(
          "{environment}",
          props.environmentLabel,
        )}
        control={
          <Button size="sm" variant="outline" onClick={() => props.onModeChange("managed")}>
            {t("settingsC.claudeSetup.useManaged")}
          </Button>
        }
      />
    );
  }
  return (
    <div className="divide-y divide-border/50">
      <ProviderSetupSection
        environmentId={props.environmentId}
        environmentLabel={props.environmentLabel}
        instanceId={props.instanceId}
        providerName="Claude"
        provider={props.provider}
        binaryPath={customBinary ? props.binaryPath : undefined}
        enabled={props.enabled}
        readOnly={props.readOnly}
        onEnable={props.onEnable}
      />
      {props.readOnly || locked ? null : (
        <SettingsRow
          title={t("settingsC.claudeSetup.existingTitle")}
          description={t("settingsC.claudeSetup.existingDesc")}
          control={
            <Button size="sm" variant="outline" onClick={() => props.onModeChange("existing")}>
              {t("settingsC.claudeSetup.useExisting")}
            </Button>
          }
        />
      )}
    </div>
  );
}
