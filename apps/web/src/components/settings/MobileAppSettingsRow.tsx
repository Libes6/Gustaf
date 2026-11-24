import { GUSTAF_LATEST_RELEASE_URL } from "@t3tools/shared/gustafService";
import { T, useGT, useMessages, Var } from "gt-react";

import { AndroidIcon } from "../Icons";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

// Gustaf has no store listings; the Android build is attached to each release.
const stores = [
  {
    label: "Android",
    store: "GitHub Releases",
    url: GUSTAF_LATEST_RELEASE_URL,
    Icon: AndroidIcon,
  },
];

export function MobileAppSettingsRow() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description={gt("Connect to your server from your phone or tablet.")}
      control={
        <div className="flex items-center gap-2">
          {stores.map(({ label, store, url, Icon }) => (
            <Popover key={store}>
              <PopoverTrigger render={<Button size="sm" variant="outline" />}>
                <Icon />
                {m(label)}
              </PopoverTrigger>
              <PopoverPopup align="end">
                <div className="flex flex-col items-center gap-3">
                  <PopoverTitle>{store}</PopoverTitle>
                  <p className="text-xs text-muted-foreground">
                    <T>Scan with your phone camera.</T>
                  </p>
                  <div className="rounded-lg bg-white p-1.5">
                    <QRCodeSvg
                      value={url}
                      size={128}
                      level="M"
                      marginSize={1}
                      title={gt("{store} link", { store })}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    render={<a href={url} target="_blank" rel="noreferrer noopener" />}
                  >
                    <T>
                      Open <Var>{store}</Var>
                    </T>
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
