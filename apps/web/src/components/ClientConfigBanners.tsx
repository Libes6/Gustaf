import { announcementText } from "@t3tools/client-runtime/client-config";
import { MegaphoneIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useEffect } from "react";

import { clientConfigStore, useClientConfig } from "../clientConfig";
import { localUpdater } from "../localUpdater";
import { useUiLanguage } from "../uiLanguageStore";
import { useT } from "../useUiLanguage";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

const ALERT_VARIANT = { info: "info", warning: "warning", critical: "error" } as const;
const MAX_SHOWN = 3;

/** Cloud announcements and the minimum-version notice, above every screen of the shell. */
export function ClientConfigBanners() {
  const t = useT();
  const language = useUiLanguage();
  const { config, announcements } = useClientConfig();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the cloud on start and every few hours.
  useEffect(() => clientConfigStore?.start(), []);

  if (!config.update.required && announcements.length === 0) return null;
  return (
    <section
      aria-label={t("misc.clientConfig.announcements")}
      className="pointer-events-none fixed inset-x-0 top-12 z-50 flex flex-col items-center gap-2 px-4"
    >
      {config.update.required ? (
        <div className="pointer-events-auto w-full max-w-xl">
          <Alert variant="warning" surface="glass" controlAlignment="first-line">
            <TriangleAlertIcon />
            <AlertTitle>{t("misc.clientConfig.updateRequired")}</AlertTitle>
            <AlertDescription>
              <span>{config.update.message ?? t("misc.clientConfig.updateRequiredBody")}</span>
              {config.update.minimumVersion ? (
                <span>
                  {t("misc.clientConfig.minimumVersion")}: {config.update.minimumVersion}
                </span>
              ) : null}
            </AlertDescription>
            <AlertAction>
              <Button size="sm" onClick={() => void localUpdater()?.checkForUpdate()}>
                {t("misc.clientConfig.checkForUpdate")}
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : null}
      {announcements.slice(0, MAX_SHOWN).map((announcement) => (
        <div key={announcement.id} className="pointer-events-auto w-full max-w-xl">
          <Alert
            variant={ALERT_VARIANT[announcement.level]}
            surface="glass"
            controlAlignment="first-line"
          >
            <MegaphoneIcon />
            <AlertDescription>
              <span className="whitespace-pre-wrap text-foreground">
                {announcementText(announcement, language)}
              </span>
              {announcement.link ? (
                <a
                  href={announcement.link}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  {t("misc.clientConfig.learnMore")}
                </a>
              ) : null}
            </AlertDescription>
            <AlertAction>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={t("misc.clientConfig.dismiss")}
                onClick={() => clientConfigStore?.dismiss(announcement.id)}
              >
                <XIcon />
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ))}
    </section>
  );
}
