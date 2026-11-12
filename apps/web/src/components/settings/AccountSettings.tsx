import { useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import {
  shellAccount,
  type ShellAccount,
  type ShellAccountDevice,
  type ShellAccountState,
} from "../../shellAccount";
import { refreshShellAccount, shellAccountAtom } from "../../state/shellAccount";
import { useEnvironmentQuery } from "../../state/query";
import { useT } from "../../useUiLanguage";
import type { MessageKey } from "../../i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { isThisComputerRegistered, orderDevices } from "./AccountSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type Pending = "signIn" | "signOut" | "register" | { readonly revoke: string } | null;

/** The Gustaf cloud account; only the Tauri shell offers it. */
export function AccountSettingsSection() {
  const account = shellAccount();
  return account ? <AccountSettings account={account} /> : null;
}

function AccountSettings({ account }: { account: ShellAccount }) {
  const t = useT();
  const query = useEnvironmentQuery(shellAccountAtom);
  const [pending, setPending] = useState<Pending>(null);
  // A sign-in the user cancelled rejects too; that is not an error worth a toast.
  const cancelledSignIn = useRef(false);

  const run = (action: Exclude<Pending, null>, work: () => Promise<ShellAccountState>) => {
    if (pending !== null) return;
    setPending(action);
    void work()
      .catch((error: unknown) => {
        if (action === "signIn" && cancelledSignIn.current) return;
        const title: MessageKey =
          action === "signIn" ? "settingsD.account.signInFailed" : "settingsD.account.actionFailed";
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t(title),
            description: error instanceof Error ? error.message : String(error),
          }),
        );
      })
      .finally(() => {
        setPending(null);
        refreshShellAccount();
      });
  };

  const signIn = () => {
    cancelledSignIn.current = false;
    run("signIn", account.signIn);
  };
  const cancelSignIn = () => {
    cancelledSignIn.current = true;
    void account.cancelSignIn();
  };
  const revoke = async (device: ShellAccountDevice) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      t("settingsD.account.revokeConfirm").replace("{name}", device.name),
    );
    if (confirmed) run({ revoke: device.id }, () => account.revokeDevice(device.id));
  };

  const view = query.data?.view ?? { kind: "loading" as const };
  const devices = query.data?.devices ?? null;
  const busy = pending !== null;

  return (
    <SettingsSection id="account-section" title={t("settingsD.account.title")}>
      {view.kind === "loading" ? (
        <SettingsRow
          id={searchableSetting("account").id}
          title={t("settingsD.account.title")}
          description={query.error ?? t("settingsD.account.loading")}
        />
      ) : view.kind === "signedOut" ? (
        <SettingsRow
          id={searchableSetting("account").id}
          title={t("settingsD.account.notSignedIn")}
          description={
            pending === "signIn"
              ? t("settingsD.account.finishInBrowser")
              : view.expired
                ? t("settingsD.account.expired")
                : t("settingsD.account.signedOutDescription")
          }
          control={
            pending === "signIn" ? (
              <Button size="sm" variant="outline" onClick={cancelSignIn}>
                {t("settingsD.account.cancel")}
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={signIn}>
                {t("settingsD.account.signIn")}
              </Button>
            )
          }
        />
      ) : (
        <>
          <SettingsRow
            id={searchableSetting("account").id}
            title={
              <span className="flex items-center gap-2">
                <AccountAvatar image={view.user.image} initials={view.initials} />
                {view.displayName ?? t("settingsD.account.unnamed")}
              </span>
            }
            description={view.secondary ?? undefined}
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => run("signOut", account.signOut)}
              >
                {t("settingsD.account.signOut")}
              </Button>
            }
          />
          <SettingsRow
            title={t("settingsD.account.devices")}
            description={
              query.error ??
              (devices?.length === 0
                ? t("settingsD.account.noDevices")
                : t("settingsD.account.devicesDescription"))
            }
            control={
              devices !== null && !isThisComputerRegistered(devices) ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => run("register", account.registerThisComputer)}
                >
                  {t("settingsD.account.registerThisComputer")}
                </Button>
              ) : null
            }
          />
          {orderDevices(devices ?? []).map((device) => (
            <SettingsRow
              key={device.id}
              title={
                <span className="flex items-center gap-2">
                  {device.name}
                  {device.current ? (
                    <Badge variant="secondary">{t("settingsD.account.thisComputer")}</Badge>
                  ) : null}
                </span>
              }
              control={
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={busy}
                  onClick={() => void revoke(device)}
                >
                  {t("settingsD.account.revoke")}
                </Button>
              }
            />
          ))}
        </>
      )}
    </SettingsSection>
  );
}

function AccountAvatar({ image, initials }: { image: string | null; initials: string }) {
  return image ? (
    <img src={image} alt="" className="size-6 rounded-full" referrerPolicy="no-referrer" />
  ) : (
    <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs">
      {initials}
    </span>
  );
}
