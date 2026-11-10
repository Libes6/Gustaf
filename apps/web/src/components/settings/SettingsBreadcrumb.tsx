import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";
import { useSettingsNavLabel, useT } from "../../useUiLanguage";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "Diagnostics",
  "/settings/open-source-licenses": "Open source licenses",
};

function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  return SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? null;
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const t = useT();
  const sectionLabelFor = useSettingsNavLabel();
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const stored = settingsBreadcrumbLabel(pathname);
  const sectionLabel = stored ? sectionLabelFor(normalized, stored) : null;

  return (
    <WorkspaceBreadcrumb ariaLabel={t("settingsD.settingsBreadcrumb.ariaLabel")}>
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>
            {t("settingsD.settingsBreadcrumb.settings")}
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? t("settingsD.settingsBreadcrumb.settings")}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
