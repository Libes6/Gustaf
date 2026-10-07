import { useEffect, useState } from "react";
import { useT, type Key } from "../i18n";
import { getSetting, setSetting } from "../lib/api";
import { currentPlatform } from "../lib/platform";
import { acceleratorOf as stopAcceleratorOf } from "../lib/shortcuts";
import {
  acceleratorOf,
  DEFAULT_ACCELERATOR,
  DEFAULT_QUICK_ASK,
  displayAccelerator,
  normalizeQuickAsk,
  QUICK_ASK_SETTING,
  quickAskErrorKey,
  recordAccelerator,
  type AcceleratorError,
  type QuickAskSettings,
} from "../lib/quickAsk";
import { SettingRow } from "./SettingRow";
import { applyQuickAsk, useQuickAskStatus } from "../lib/quickAskHost";

const RECORD_ERRORS: Record<AcceleratorError, Key> = {
  modifierOnly: "quickAskRecNeedsModifier",
  needsModifier: "quickAskRecNeedsModifier",
  unsupportedKey: "quickAskRecUnsupported",
  reserved: "quickAskRecReserved",
  conflict: "quickAskRecConflict",
};

/** Settings -> Shortcuts: the "Quick ask window" switch, its global shortcut (recorded from the keyboard) and the focus-loss option. */
export function QuickAskSettings() {
  const t = useT();
  const platform = currentPlatform();
  const [settings, setSettings] = useState<QuickAskSettings>(DEFAULT_QUICK_ASK);
  const [loaded, setLoaded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<Key | null>(null);
  const status = useQuickAskStatus();

  useEffect(() => {
    getSetting<unknown>(QUICK_ASK_SETTING, null)
      .then((raw) => setSettings(normalizeQuickAsk(raw)))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const update = (patch: Partial<QuickAskSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    void setSetting(QUICK_ASK_SETTING, next).catch(() => {});
    // Registers the shortcut now; a failure (taken by another app) shows below as a notice and changes nothing else.
    void applyQuickAsk(next);
  };

  const keys = displayAccelerator(acceleratorOf(settings, platform), platform);
  const customized = settings.accelerator !== null && settings.accelerator !== DEFAULT_ACCELERATOR[platform];
  const failure = status.state === "error" && settings.enabled ? t(quickAskErrorKey(status.message)) : "";

  return (
    <>
      <div className="card" style={{ marginTop: 12 }}>
        <SettingRow
          id="quickAskSwitch"
          title={t("quickAskSwitch")}
          description={t("quickAskSwitchDesc")}
          toggle={{ on: settings.enabled, disabled: !loaded, onChange: (enabled) => update({ enabled }) }}
        />
        <SettingRow
          id="quickAskShortcut"
          title={t("quickAskShortcut")}
          description={
            settings.enabled && status.state === "on"
              ? t("quickAskStatusOn", { keys })
              : !settings.enabled
                ? t("quickAskStatusOff")
                : ""
          }
        >
          {recording ? (
            <input
              className="input narrow"
              readOnly
              autoFocus
              aria-label={t("quickAskRecording")}
              placeholder={t("quickAskRecording")}
              onBlur={() => setRecording(false)}
              onKeyDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.key === "Escape") return setRecording(false);
                const r = recordAccelerator(e.nativeEvent, platform, [stopAcceleratorOf("stopAgent", platform)]);
                if (r.ok) {
                  setRecording(false);
                  setRecordError(null);
                  update({ accelerator: r.accelerator });
                } else setRecordError(r.error === "waiting" ? null : RECORD_ERRORS[r.error]);
              }}
            />
          ) : (
            <>
              <span className="kbd-chip">{keys}</span>
              <button className="btn-soft" onClick={() => (setRecordError(null), setRecording(true))}>
                {t("quickAskRecord")}
              </button>
              {customized && (
                <button className="btn-soft" onClick={() => (setRecordError(null), update({ accelerator: null }))}>
                  {t("quickAskReset")}
                </button>
              )}
            </>
          )}
        </SettingRow>
        <SettingRow
          id="quickAskHideOnBlur"
          title={t("quickAskHideOnBlur")}
          toggle={{ on: settings.hideOnBlur, onChange: (hideOnBlur) => update({ hideOnBlur }) }}
        />
      </div>
      {recordError && (
        <p className="h4-sub" role="alert">
          {t(recordError)}
        </p>
      )}
      {failure && (
        <p className="h4-sub" role="alert" style={{ color: "var(--error-fg)" }}>
          {failure}
        </p>
      )}
    </>
  );
}
