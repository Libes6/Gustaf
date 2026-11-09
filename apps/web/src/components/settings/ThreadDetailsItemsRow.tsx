import { ChevronDownIcon } from "lucide-react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { ThreadDetailsItemsMenuItems } from "../chat/ThreadDetailsItemsMenu";
import {
  isDefaultThreadDetailsVisibility,
  resolveThreadDetailsVisibility,
  RESET_THREAD_DETAILS_ITEMS,
  THREAD_DETAILS_ITEMS,
} from "../chat/threadDetailsItems";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useLocalizedSettingLookup, useT } from "../../useUiLanguage";

export function ThreadDetailsItemsRow() {
  const visibility = useClientSettings(resolveThreadDetailsVisibility);
  const t = useT();
  const row = useLocalizedSettingLookup();
  const enabled = THREAD_DETAILS_ITEMS.filter((item) => visibility[item.id]).length;
  const count = t("threadDetails.count")
    .replace("{enabled}", String(enabled))
    .replace("{total}", String(THREAD_DETAILS_ITEMS.length));
  return (
    <SettingsRow
      {...row("thread-details-items")}
      resetAction={
        isDefaultThreadDetailsVisibility(visibility) ? null : (
          <SettingResetButton
            label="thread details"
            onClick={() => updateClientSettings(RESET_THREAD_DETAILS_ITEMS)}
          />
        )
      }
      control={
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-between sm:w-40"
                aria-label={count}
              />
            }
          >
            {count}
            <ChevronDownIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end">
            <ThreadDetailsItemsMenuItems />
          </MenuPopup>
        </Menu>
      }
    />
  );
}
