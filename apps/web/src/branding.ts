import type { DesktopAppBranding } from "@t3tools/contracts";
import { GUSTAF_LATEST_RELEASE_URL } from "@t3tools/shared/gustafService";
import {
  formatAppDisplayName,
  resolveHostedAppChannelLabel,
  resolveWebAppStageLabel,
} from "./branding.logic";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
// The web bundle's version is the server package's, not the installed desktop app's.
const injectedDesktopAppVersion =
  typeof window === "undefined" ? null : (window.desktopBridge?.getAppVersion?.() ?? null);
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  hostedAppChannel === "latest" || hostedAppChannel === "nightly" ? hostedAppChannel : null;
export const HOSTED_APP_CHANNEL_LABEL = resolveHostedAppChannelLabel(HOSTED_APP_CHANNEL);
export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? "Gustaf";
export const APP_STAGE_LABEL =
  injectedDesktopAppBranding?.stageLabel ??
  resolveWebAppStageLabel({
    hostedAppChannel: HOSTED_APP_CHANNEL,
    development: import.meta.env.DEV,
  });
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ??
  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });
export const APP_VERSION = injectedDesktopAppVersion || import.meta.env.APP_VERSION || "0.0.0";
export const DESKTOP_DOWNLOAD_URL = GUSTAF_LATEST_RELEASE_URL;
// The release page lists the Android build; Gustaf has no store listing to redirect by phone.
export const MOBILE_APP_URL = GUSTAF_LATEST_RELEASE_URL;
