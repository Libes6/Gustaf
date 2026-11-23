import Constants from "expo-constants";
import { Image } from "expo-image";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { m } from "../../i18n/messages";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import type { AccountUser } from "./accountApi";
import {
  accountDeviceRows,
  accountErrorMessage,
  canRegisterPhone,
  reportErrorMessage,
} from "./accountScreenState";
import { accountStore, useAccount } from "./useAccount";

export function AccountSettingsRouteScreen() {
  const gt = useGT();
  const messages = useMessages();
  const insets = useSafeAreaInsets();
  const account = useAccount();
  const error = accountErrorMessage(account.error, messages);

  return (
    <SettingsScreen
      title={gt("Account")}
      refresh={
        account.status === "signedIn"
          ? {
              accessibilityLabel: gt("Refresh"),
              disabled: account.busy !== null,
              onPress: () => void accountStore.refreshDevices(),
            }
          : undefined
      }
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {error ? <ErrorBanner message={error} /> : null}
        {account.status === "loading" ? (
          <AppActivityIndicator />
        ) : account.status === "signedOut" || !account.user ? (
          <View className="gap-4">
            <Text className="text-base text-foreground-muted">
              <T>Sign in to see and manage the computers and phones linked to your account.</T>
            </Text>
            <Button
              label={gt("Sign in with GitHub")}
              tone="primary"
              loading={account.busy === "signIn"}
              onPress={() => void accountStore.signIn()}
            />
          </View>
        ) : (
          <SignedInAccount user={account.user} />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function SignedInAccount(props: { readonly user: AccountUser }) {
  const gt = useGT();
  const messages = useMessages();
  const account = useAccount();
  const rows = account.devices
    ? accountDeviceRows(account.devices, account.phoneDeviceId, messages)
    : null;

  const confirmRevoke = (id: string, name: string, isThisPhone: boolean) =>
    Dialog.confirm({
      title: gt("Remove device?"),
      message: isThisPhone
        ? gt("This phone will no longer be linked to your account.")
        : gt("{name}: this device will lose access to your account.", { name }),
      confirmText: gt("Remove"),
      cancelText: gt("Cancel"),
      destructive: true,
      onConfirm: () => void accountStore.revokeDevice(id),
    });

  const reportProblem = () =>
    Dialog.prompt({
      title: gt("Report a problem"),
      message: gt(
        "Describe what happened. The report is sent with your account, the app version and your platform.",
      ),
      placeholder: gt("What went wrong?"),
      initialValue: "",
      confirmText: gt("Send"),
      cancelText: gt("Cancel"),
      onConfirm: (value) => {
        const message = value.trim().slice(0, 5000);
        if (!message) return;
        accountStore
          .reportProblem({
            message,
            appVersion: Constants.expoConfig?.version ?? "0.0.0",
            platform: `${Platform.OS} ${String(Platform.Version)}`,
          })
          .then(
            () => Dialog.alert(m(msg("Report sent")), m(msg("Thank you!"))),
            (cause: unknown) =>
              Dialog.alert(m(msg("Could not send the report")), reportErrorMessage(cause, m)),
          );
      },
    });

  const confirmSignOut = () =>
    Dialog.confirm({
      title: gt("Sign out?"),
      message: gt("This phone will forget your account."),
      confirmText: gt("Sign out"),
      cancelText: gt("Cancel"),
      destructive: true,
      onConfirm: () => void accountStore.signOut(),
    });

  return (
    <>
      <View className="flex-row items-center gap-4">
        {props.user.image ? (
          <Image
            source={{ uri: props.user.image }}
            accessibilityIgnoresInvertColors
            style={{ width: 56, height: 56, borderRadius: 28 }}
          />
        ) : (
          <SymbolView
            name="person.crop.circle"
            size={56}
            tintColorClassName="accent-icon"
            type="monochrome"
            weight="regular"
          />
        )}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-lg font-t3-bold text-foreground" numberOfLines={1}>
            {props.user.name}
          </Text>
          <Text className="text-base text-foreground-muted" numberOfLines={1}>
            {props.user.email}
          </Text>
        </View>
      </View>

      <SettingsSection title={gt("Devices")}>
        {rows === null ? (
          <View className="p-4">
            <AppActivityIndicator />
          </View>
        ) : (
          rows.map((row) => (
            <ListActionRow
              key={row.id}
              icon={row.icon}
              label={row.name}
              description={row.detail}
              loading={account.revokingDeviceId === row.id}
              onPress={() => confirmRevoke(row.id, row.name, row.isThisPhone)}
            />
          ))
        )}
        {canRegisterPhone(account) ? (
          <ListActionRow
            icon="plus"
            label={gt("Register this phone")}
            loading={account.busy === "registerPhone"}
            onPress={() => void accountStore.registerPhone()}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection>
        <ListActionRow icon="text.bubble" label={gt("Report a problem")} onPress={reportProblem} />
      </SettingsSection>

      <SettingsSection>
        <ListActionRow
          label={gt("Sign out")}
          tone="danger"
          loading={account.busy === "signOut"}
          onPress={confirmSignOut}
        />
      </SettingsSection>
    </>
  );
}
