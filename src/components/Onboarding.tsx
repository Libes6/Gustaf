import { WindowHeader } from "./WindowHeader";
import { isMac, isWindows } from "../lib/platform";
import { useState } from "react";
import { useT } from "../i18n";
import { useApp } from "../state";
import { CreateProjectDialog } from "./CreateProjectDialog";
import { ImportPanel } from "./ImportPanel";
import { ProviderForm } from "./ProviderForm";

/** First run: import projects from Cursor (or create one), then connect a model provider. */
export function Onboarding() {
  const t = useT();
  const app = useApp();
  const [step, setStep] = useState<0 | 1>(0);
  const [creating, setCreating] = useState(false);

  const finish = async () => {
    await app.reload();
    app.setOnboarded(true);
  };

  return (
    <div className="onboarding">
      <WindowHeader />
      <div className="lang-switch seg" role="group" aria-label={t("language")}>
        <button className={app.locale === "ru" ? "active" : ""} aria-pressed={app.locale === "ru"} lang="ru" aria-label="Русский" onClick={() => app.setLocale("ru")}>RU</button>
        <button className={app.locale === "en" ? "active" : ""} aria-pressed={app.locale === "en"} lang="en" aria-label="English" onClick={() => app.setLocale("en")}>EN</button>
      </div>
      <main className="onb-body">
        <div className="onb-inner">
          <div className="onb-steps" role="img" aria-label={t("stepOf", { n: step + 1, total: 2 })}>
            <i className="on" />
            <i className={step === 1 ? "on" : ""} />
          </div>
          {step === 0 ? (
            <>
              <h1>{t("onbImportTitle")}</h1>
              <p className="lead" style={{ color: "var(--text-2)", marginBottom: 20 }}>{t("onbImportLead")}</p>
              <ImportPanel onDone={async () => (await app.reload(), setStep(1))} />
              <div className="onb-foot" style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                <button className="btn-soft" onClick={() => setCreating(true)}>{t("createProject")}</button>
                <button className="btn btn-ghost" onClick={() => setStep(1)}>{t("skip")}</button>
              </div>
            </>
          ) : (
            <>
              <h1>{t("onbProviderTitle")}</h1>
              <p className="lead" style={{ color: "var(--text-2)", marginBottom: 20 }}>{t("onbProviderLead", { store: t(isMac() ? "keyStoreMac" : isWindows() ? "keyStoreWindows" : "keyStoreLinux") })}</p>
              <ProviderForm
                onSaved={async (cfg, models) => {
                  await app.refreshModels();
                  if (models[0]) app.setSelection({ providerId: cfg.id, model: models[0].id });
                  await finish();
                }}
                onCancel={finish}
              />
            </>
          )}
        </div>
      </main>
      {creating && <CreateProjectDialog onClose={() => setCreating(false)} onCreated={async () => (setCreating(false), await app.reload(), setStep(1))} />}
    </div>
  );
}
