import { AndroidIcon, AppleIcon } from "../Icons";
import { useT } from "../../useUiLanguage";
import type { MessageKey } from "../../i18n";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const stores = [
  {
    labelKey: "settingsB.MobileAppSettingsRow.iphoneAndIpad" as MessageKey,
    store: "App Store",
    url: "https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824",
    Icon: AppleIcon,
  },
  {
    labelKey: "settingsB.MobileAppSettingsRow.android" as MessageKey,
    store: "Google Play",
    url: "https://play.google.com/store/apps/details?id=com.t3tools.t3code",
    Icon: AndroidIcon,
  },
];

export function MobileAppSettingsRow() {
  const t = useT();
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description={t("settingsB.MobileAppSettingsRow.description")}
      control={
        <div className="flex items-center gap-2">
          {stores.map(({ labelKey, store, url, Icon }) => (
            <Popover key={store}>
              <PopoverTrigger render={<Button size="sm" variant="outline" />}>
                <Icon />
                {t(labelKey)}
              </PopoverTrigger>
              <PopoverPopup align="end">
                <div className="flex flex-col items-center gap-3">
                  <PopoverTitle>{store}</PopoverTitle>
                  <p className="text-xs text-muted-foreground">
                    {t("settingsB.MobileAppSettingsRow.scan")}
                  </p>
                  <div className="rounded-lg bg-white p-1.5">
                    <QRCodeSvg
                      value={url}
                      size={128}
                      level="M"
                      marginSize={1}
                      title={`${store} link`}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    render={<a href={url} target="_blank" rel="noreferrer noopener" />}
                  >
                    {t("settingsB.MobileAppSettingsRow.open").replace("{store}", store)}
                  </Button>
                </div>
              </PopoverPopup>
            </Popover>
          ))}
        </div>
      }
    />
  );
}
