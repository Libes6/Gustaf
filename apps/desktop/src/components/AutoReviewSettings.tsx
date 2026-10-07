import { SettingRow } from "./SettingRow";
import { useT } from "../i18n";
import { setProjectOverride, type AutoTrigger } from "../lib/autoReview";
import { saveAutoReview, useAutoReviewSettings } from "../lib/autoReviewStore";
import { useApp } from "../state";

/**
 * Settings > Git and commands: review changes automatically (global default, when to review, per-project override).
 * Each automatic review is one more model request that sends the diff to the provider, so the cost is stated here.
 */
export function AutoReviewSettings() {
  const t = useT();
  const app = useApp();
  const s = useAutoReviewSettings();
  const projects = app.projects.filter((p) => p.path);
  return (
    <>
      <div className="card">
        <SettingRow id="autoReview" title={t("autoReviewSetting")} description={<>{t("autoReviewSettingDesc")}<div>{t("autoReviewCost")}</div></>}
          toggle={{ on: s.enabled, onChange: (on) => saveAutoReview({ ...s, enabled: on }) }} />
        <SettingRow id="autoReviewTrigger" title={t("autoReviewTrigger")}>
          <select className="input" aria-label={t("autoReviewTrigger")} value={s.trigger} onChange={(e) => saveAutoReview({ ...s, trigger: e.target.value as AutoTrigger })}>
            <option value="afterRun">{t("autoReviewTriggerAfterRun")}</option>
            <option value="beforeAccept">{t("autoReviewTriggerBeforeAccept")}</option>
          </select>
        </SettingRow>
        {projects.length > 0 && <SettingRow title={t("autoReviewProjects")} description={t("autoReviewProjectsHint")} />}
        {projects.map((p) => {
          const own = Object.prototype.hasOwnProperty.call(s.projects, p.path!) ? (s.projects[p.path!] ? "on" : "off") : "default";
          return (
            <SettingRow key={p.id} title={p.name}>
              <select className="input" aria-label={t("autoReviewProjectLabel", { name: p.name })} value={own}
                onChange={(e) => saveAutoReview(setProjectOverride(s, p.path!, e.target.value === "default" ? undefined : e.target.value === "on"))}>
                <option value="default">{t("autoReviewProjectDefault")}</option>
                <option value="on">{t("autoReviewProjectOn")}</option>
                <option value="off">{t("autoReviewProjectOff")}</option>
              </select>
            </SettingRow>
          );
        })}
      </div>
    </>
  );
}
