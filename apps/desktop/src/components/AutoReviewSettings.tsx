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
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("autoReviewSetting")}</div>
            <div className="d">{t("autoReviewSettingDesc")}</div>
            <div className="d">{t("autoReviewCost")}</div>
          </div>
          <button role="switch" aria-checked={s.enabled} aria-label={t("autoReviewSetting")} className={`toggle${s.enabled ? " on" : ""}`} onClick={() => saveAutoReview({ ...s, enabled: !s.enabled })} />
        </div>
        <div className="card-row">
          <div className="grow"><div className="t">{t("autoReviewTrigger")}</div></div>
          <select className="input" aria-label={t("autoReviewTrigger")} value={s.trigger} onChange={(e) => saveAutoReview({ ...s, trigger: e.target.value as AutoTrigger })}>
            <option value="afterRun">{t("autoReviewTriggerAfterRun")}</option>
            <option value="beforeAccept">{t("autoReviewTriggerBeforeAccept")}</option>
          </select>
        </div>
        {projects.length > 0 && (
          <div className="card-row">
            <div className="grow">
              <div className="t">{t("autoReviewProjects")}</div>
              <div className="d">{t("autoReviewProjectsHint")}</div>
            </div>
          </div>
        )}
        {projects.map((p) => {
          const own = Object.prototype.hasOwnProperty.call(s.projects, p.path!) ? (s.projects[p.path!] ? "on" : "off") : "default";
          return (
            <div className="card-row" key={p.id}>
              <div className="grow"><div className="t">{p.name}</div></div>
              <select className="input" aria-label={t("autoReviewProjectLabel", { name: p.name })} value={own}
                onChange={(e) => saveAutoReview(setProjectOverride(s, p.path!, e.target.value === "default" ? undefined : e.target.value === "on"))}>
                <option value="default">{t("autoReviewProjectDefault")}</option>
                <option value="on">{t("autoReviewProjectOn")}</option>
                <option value="off">{t("autoReviewProjectOff")}</option>
              </select>
            </div>
          );
        })}
      </div>
    </>
  );
}
