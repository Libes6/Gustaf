import { useState } from "react";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { useT } from "../../useUiLanguage";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// Toggling relaunches desktop; the switch reflects startup state.
export function LocalEnvironmentSetting() {
  const t = useT();
  const setEnabled = window.desktopBridge?.setLocalEnvironmentEnabled;
  const [enabled] = useState(() => !isLocalEnvironmentDisabled());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!setEnabled) return null;

  const applyChange = async () => {
    setIsUpdating(true);
    setError(null);
    try {
      await setEnabled(!enabled);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("settingsB.LocalEnvironmentSetting.changeFailed"),
      );
      setIsUpdating(false);
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("local-environment")}
        description={
          enabled
            ? t("settingsB.LocalEnvironmentSetting.onDescription")
            : t("settingsB.LocalEnvironmentSetting.offDescription")
        }
        control={
          <Switch
            checked={enabled}
            disabled={isUpdating}
            onCheckedChange={() => setConfirmOpen(true)}
            aria-label={t("settingsB.LocalEnvironmentSetting.ariaLabel")}
          />
        }
      />
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (isUpdating) return;
          setConfirmOpen(open);
          if (!open) setError(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {enabled
                ? t("settingsB.LocalEnvironmentSetting.turnOffTitle")
                : t("settingsB.LocalEnvironmentSetting.turnOnTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {enabled
                ? t("settingsB.LocalEnvironmentSetting.turnOffBody")
                : t("settingsB.LocalEnvironmentSetting.turnOnBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="px-6 pb-4 text-sm text-destructive">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogClose disabled={isUpdating} render={<Button variant="outline" />}>
              {t("settingsB.LocalEnvironmentSetting.cancel")}
            </AlertDialogClose>
            <Button
              variant={enabled ? "destructive" : "default"}
              disabled={isUpdating}
              onClick={() => void applyChange()}
            >
              {isUpdating ? (
                <>
                  <Spinner size="sm" />
                  {t("settingsB.LocalEnvironmentSetting.restarting")}
                </>
              ) : enabled ? (
                t("settingsB.LocalEnvironmentSetting.restartAndOff")
              ) : (
                t("settingsB.LocalEnvironmentSetting.restartAndOn")
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
