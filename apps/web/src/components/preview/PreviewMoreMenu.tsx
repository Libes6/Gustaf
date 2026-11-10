import type { DesktopPreviewColorScheme } from "@t3tools/contracts";
import { Minus, MoreVertical, Plus as PlusIcon, RotateCcw } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useT } from "../../useUiLanguage";

const COLOR_SCHEME_OPTIONS: ReadonlyArray<{
  value: DesktopPreviewColorScheme;
  labelKey:
    | "misc.previewMoreMenu.appearanceSystem"
    | "misc.previewMoreMenu.appearanceLight"
    | "misc.previewMoreMenu.appearanceDark";
}> = [
  { value: "system", labelKey: "misc.previewMoreMenu.appearanceSystem" },
  { value: "light", labelKey: "misc.previewMoreMenu.appearanceLight" },
  { value: "dark", labelKey: "misc.previewMoreMenu.appearanceDark" },
];

export interface PreviewMoreMenuActions {
  readonly hardReload: () => void;
  readonly setColorScheme: (colorScheme: DesktopPreviewColorScheme) => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly clearCookies: () => void;
  readonly clearCache: () => void;
  readonly openDevTools?: () => void;
  readonly toggleNativePictureInPicture?: () => void;
}

interface Props {
  enabled: boolean;
  actions: PreviewMoreMenuActions;
  zoomFactor: number;
  colorScheme: DesktopPreviewColorScheme;
  deviceToolbarVisible: boolean;
  onToggleDeviceToolbar: () => void;
  nativePictureInPicture: boolean;
  profileName: string | undefined;
  move?: { readonly label: string; readonly onMove: () => void };
}

const MenuTriggerButton = ({
  menuLabel,
  moreLabel,
}: {
  readonly menuLabel: string;
  readonly moreLabel: string;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <MenuTrigger
          render={<Button variant="ghost" size="icon-xs" type="button" aria-label={menuLabel} />}
        />
      }
    >
      <MoreVertical />
    </TooltipTrigger>
    <TooltipPopup>{moreLabel}</TooltipPopup>
  </Tooltip>
);

export function PreviewMoreMenu({
  enabled,
  actions,
  zoomFactor,
  colorScheme,
  deviceToolbarVisible,
  onToggleDeviceToolbar,
  nativePictureInPicture,
  profileName,
  move,
}: Props) {
  const t = useT();
  const zoomLabel = `${Math.round(zoomFactor * 100)}%`;
  const disabled = !enabled;
  return (
    <Menu>
      <MenuTriggerButton
        menuLabel={t("misc.previewMoreMenu.previewMenu")}
        moreLabel={t("misc.previewMoreMenu.more")}
      />
      <MenuPopup align="end" sideOffset={6}>
        <MenuItem onClick={actions.hardReload} disabled={disabled}>
          {t("misc.previewMoreMenu.hardReload")}
        </MenuItem>
        {actions.openDevTools ? (
          <MenuItem onClick={actions.openDevTools} disabled={disabled}>
            {t("misc.previewMoreMenu.openDevTools")}
          </MenuItem>
        ) : null}
        {actions.toggleNativePictureInPicture ? (
          <MenuItem onClick={actions.toggleNativePictureInPicture} disabled={disabled}>
            {nativePictureInPicture
              ? t("misc.previewMoreMenu.closeSeparateWindow")
              : t("misc.previewMoreMenu.openSeparateWindow")}
          </MenuItem>
        ) : null}
        {move ? <MenuItem onClick={move.onMove}>{move.label}</MenuItem> : null}
        <MenuItem onClick={onToggleDeviceToolbar} disabled={disabled}>
          {deviceToolbarVisible
            ? t("misc.previewMoreMenu.hideDeviceToolbar")
            : t("misc.previewMoreMenu.showDeviceToolbar")}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={disabled}>
            {t("misc.previewMoreMenu.appearance")}
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={colorScheme}
              onValueChange={(value) => actions.setColorScheme(value as DesktopPreviewColorScheme)}
            >
              {COLOR_SCHEME_OPTIONS.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuItem
          closeOnClick={false}
          onClick={(event: React.MouseEvent) => event.preventDefault()}
          className="justify-between"
          disabled={disabled}
        >
          <span>{t("misc.previewMoreMenu.zoom")}</span>
          <span className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={actions.zoomOut}
              aria-label={t("misc.previewMoreMenu.zoomOut")}
              disabled={disabled}
            >
              <Minus />
            </Button>
            <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
              {zoomLabel}
            </span>
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={actions.zoomIn}
              aria-label={t("misc.previewMoreMenu.zoomIn")}
              disabled={disabled}
            >
              <PlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              onClick={actions.resetZoom}
              aria-label={t("misc.previewMoreMenu.resetZoom")}
              disabled={disabled}
            >
              <RotateCcw />
            </Button>
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuGroup>
          {profileName ? (
            <MenuGroupLabel className="max-w-64">
              <span className="block truncate">
                {t("misc.previewMoreMenu.profileLabel").replace("{name}", profileName)}
              </span>
            </MenuGroupLabel>
          ) : null}
          <MenuItem onClick={actions.clearCookies}>
            {t("misc.previewMoreMenu.clearCookies")}
          </MenuItem>
          <MenuItem onClick={actions.clearCache}>{t("misc.previewMoreMenu.clearCache")}</MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
