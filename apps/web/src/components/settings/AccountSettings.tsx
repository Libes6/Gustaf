import { T, useGT, useMessages } from "gt-react";
import { LogInIcon, UserIcon } from "lucide-react";
import { useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import {
  shellAccount,
  type ShellAccount,
  type ShellAccountDevice,
  type ShellAccountState,
} from "../../shellAccount";
import { useEnvironmentQuery } from "../../state/query";
import { refreshShellAccount, shellAccountAtom } from "../../state/shellAccount";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { isThisComputerRegistered, orderDevices } from "./AccountSettings.logic";
import { ReportProblemDialog } from "./ReportProblemDialog";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

type Pending = "signIn" | "signOut" | "register" | { readonly revoke: string } | null;

export function AccountSettingsPanel() {
  const account = shellAccount();
  return (
    <SettingsPageContainer>
      {account ? <AccountSettings account={account} /> : null}
    </SettingsPageContainer>
  );
}

/** The settings sidebar's footer entry into the Gustaf account; render it only when `hasShellAccount`. */
export function AccountSidebarEntry({
  isActive,
  onClick,
}: {
  isActive: boolean;
  onClick: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const view = useEnvironmentQuery(shellAccountAtom, m).data?.view ?? { kind: "loading" as const };
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={isActive}
          aria-current={isActive ? "page" : undefined}
          onClick={onClick}
        >
          {view.kind === "signedIn" ? (
            <>
              <AccountAvatar image={view.user.image} initials={view.initials} />
              <span>{view.displayName ?? gt("GitHub account")}</span>
            </>
          ) : view.kind === "signedOut" ? (
            <>
              <LogInIcon />
              <span>
                <T>Sign in</T>
              </span>
            </>
          ) : (
            <>
              <UserIcon />
              <span>
                <T>Gustaf Account</T>
              </span>
            </>
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function AccountSettings({ account }: { account: ShellAccount }) {
  const gt = useGT();
  const m = useMessages();
  const searchableSetting = useSearchableSetting();
  const query = useEnvironmentQuery(shellAccountAtom, m);
  const [pending, setPending] = useState<Pending>(null);
  const [reporting, setReporting] = useState(false);
  // A sign-in the user cancelled rejects too; that is not an error worth a toast.
  const cancelledSignIn = useRef(false);

  const run = (action: Exclude<Pending, null>, work: () => Promise<ShellAccountState>) => {
    if (pending !== null) return;
    setPending(action);
    void work()
      .catch((error: unknown) => {
        if (action === "signIn" && cancelledSignIn.current) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: action === "signIn" ? gt("Could not sign in") : gt("Account action failed"),
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
      gt("Revoke “{name}”? It will lose access to this account.", { name: device.name }),
    );
    if (confirmed) run({ revoke: device.id }, () => account.revokeDevice(device.id));
  };

  const view = query.data?.view ?? { kind: "loading" as const };
  const devices = query.data?.devices ?? null;
  const busy = pending !== null;

  return (
    <SettingsSection id="account-section" title={gt("Gustaf Account")}>
      {view.kind === "loading" ? (
        <SettingsRow
          id={searchableSetting("account").id}
          title={gt("Gustaf Account")}
          description={query.error ?? gt("Loading…")}
        />
      ) : view.kind === "signedOut" ? (
        <SettingsRow
          id={searchableSetting("account").id}
          title={gt("Not signed in")}
          description={
            pending === "signIn"
              ? gt("Finish signing in in your browser.")
              : view.expired
                ? gt("Your session has expired. Sign in again.")
                : gt("Sign in to your Gustaf account to see and manage the devices linked to it.")
          }
          control={
            pending === "signIn" ? (
              <Button size="sm" variant="outline" onClick={cancelSignIn}>
                <T>Cancel</T>
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={signIn}>
                <T>Sign in with GitHub</T>
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
                {view.displayName ?? gt("GitHub account")}
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
                <T>Sign out</T>
              </Button>
            }
          />
          <SettingsRow
            title={gt("Devices")}
            description={
              query.error ??
              (devices?.length === 0
                ? gt("No devices are linked to this account yet.")
                : gt(
                    "Computers and phones linked to this account. Registered computers report AI usage totals (provider, model, turns, tokens) to this account; set T3CODE_TELEMETRY_ENABLED=false to stop.",
                  ))
            }
            control={
              devices !== null && !isThisComputerRegistered(devices) ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => run("register", account.registerThisComputer)}
                >
                  <T>Register this computer</T>
                </Button>
              ) : null
            }
          />
          <SettingsRow
            title={gt("Report a problem")}
            description={gt("Tell the Gustaf team what went wrong.")}
            control={
              <Button size="sm" variant="outline" onClick={() => setReporting(true)}>
                <T>Report…</T>
              </Button>
            }
          />
          {reporting ? (
            <ReportProblemDialog account={account} onClose={() => setReporting(false)} />
          ) : null}
          {orderDevices(devices ?? []).map((device) => (
            <SettingsRow
              key={device.id}
              title={
                <span className="flex items-center gap-2">
                  {device.name}
                  {device.current ? (
                    <Badge variant="secondary">
                      <T>This computer</T>
                    </Badge>
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
                  <T>Revoke</T>
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
