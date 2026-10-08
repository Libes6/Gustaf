import { useT } from "../i18n";
import { saveDeviceSettings, useDeviceSettings } from "../agent/deviceSettingsStore";
import { SettingRow, SettingsSection } from "./SettingRow";

/** Settings > Computer use > Devices: whether agents may drive simulators and emulators (docs/features/devices.md, "Agents"). */
export function DeviceSettings() {
  const t = useT();
  const s = useDeviceSettings();
  return (
    <SettingsSection title={t("deviceAgentTitle")} description={t("deviceAgentLead")}>
      <SettingRow
        id="deviceAgentAccess"
        title={t("deviceAgentAccess")}
        description={t("deviceAgentAccessDesc")}
        toggle={{ on: s.access, onChange: (access) => saveDeviceSettings({ ...s, access }) }}
      />
      <SettingRow
        id="deviceAgentAsk"
        title={t("deviceAgentAsk")}
        description={t("deviceAgentAskDesc")}
        toggle={{ on: s.askFirst, onChange: (askFirst) => saveDeviceSettings({ ...s, askFirst }), disabled: !s.access }}
      />
    </SettingsSection>
  );
}
