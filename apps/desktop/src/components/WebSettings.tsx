import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { setSetting } from "../lib/api";
import { readSecret, removeSecret, secretPresence, storeSecret } from "../lib/keys";
import { webConfig, type WebConfig } from "../agent/web";
import { SettingRow, SettingsSection } from "./SettingRow";

const domains = (s: string) => s.split(/[\s,]+/).map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "")).filter(Boolean);

/** Settings, Web tools: switch, Brave key and allow/deny domain lists for API models. */
export function WebSettings() {
  const t = useT();
  const [config, setConfig] = useState<WebConfig>({ enabled: false, allow: [], deny: [] });
  const [key, setKey] = useState("");
  const [present, setPresent] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [allowText, setAllowText] = useState("");
  const [denyText, setDenyText] = useState("");
  useEffect(() => {
    webConfig().then((c) => { setConfig(c); setAllowText(c.allow.join(", ")); setDenyText(c.deny.join(", ")); }).catch((e) => setError(String(e)));
    // presence flag, no Keychain read; keys saved before flags existed are read once here
    secretPresence("web:brave").then((p) => p ?? readSecret("web:brave").then((k) => !!k)).then(setPresent).catch(() => {});
  }, []);
  const save = async () => {
    try {
      if (key.trim()) { await storeSecret("web:brave", key.trim()); setPresent(true); setKey(""); }
      const next = { ...config, allow: domains(allowText), deny: domains(denyText) };
      await setSetting("webTools", next);
      setConfig(next); setSaved(true); setError("");
    } catch (e) { setError(String(e)); }
  };
  return (
    <SettingsSection title={t("webToolsTitle")} description={t("webToolsDesc")}>
      <SettingRow id="webEnable" title={t("webEnable")} toggle={{ on: config.enabled, onChange: (enabled) => { setConfig({ ...config, enabled }); setSaved(false); } }} />
      <SettingRow id="webBraveKey" stacked title={<label htmlFor="web-brave-key">{t("webBraveKey")}{present ? " ✓" : ""}</label>}>
        <input id="web-brave-key" type="password" className="input" autoComplete="off" value={key} placeholder={present ? "••••••••" : ""} onChange={(e) => { setKey(e.target.value); setSaved(false); }} />
      </SettingRow>
      <SettingRow id="webAllow" stacked title={<label htmlFor="web-allow">{t("webAllow")}</label>}>
        <input id="web-allow" className="input" value={allowText} onChange={(e) => { setAllowText(e.target.value); setSaved(false); }} />
      </SettingRow>
      <SettingRow id="webDeny" stacked title={<label htmlFor="web-deny">{t("webDeny")}</label>}>
        <input id="web-deny" className="input" value={denyText} onChange={(e) => { setDenyText(e.target.value); setSaved(false); }} />
      </SettingRow>
      <div className="card-row">
        <button className="btn-soft" onClick={() => void save()}>{t("webSave")}</button>
        {saved && <span className="d" role="status">{t("webSaved")}</span>}
        {present && <button className="btn-ghost" onClick={async () => { try { await removeSecret("web:brave"); setPresent(false); } catch (e) { setError(String(e)); } }}>{t("webRemoveKey")}</button>}
      </div>
      {error && <div className="error-box" role="alert">{error}</div>}
    </SettingsSection>
  );
}
