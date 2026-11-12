import { Image } from "expo-image";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { t } from "../../i18n";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import type { AccountUser } from "./accountApi";
import { accountDeviceRows, accountErrorMessage, canRegisterPhone } from "./accountScreenState";
import { accountStore, useAccount } from "./useAccount";

export function AccountSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const account = useAccount();
  const error = accountErrorMessage(account.error);

  return (
    <SettingsScreen
      title={t("Account")}
      refresh={
        account.status === "signedIn"
          ? {
              accessibilityLabel: t("Refresh"),
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
              {t("Sign in to see and manage the computers and phones linked to your account.")}
            </Text>
            <Button
              label={t("Sign in with GitHub")}
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
  const account = useAccount();
  const rows = account.devices ? accountDeviceRows(account.devices, account.phoneDeviceId) : null;

  const confirmRevoke = (id: string, name: string, isThisPhone: boolean) =>
    Dialog.confirm({
      title: t("Remove device?"),
      message: isThisPhone
        ? t("This phone will no longer be linked to your account.")
        : `${name}: ${t("this device will lose access to your account.")}`,
      confirmText: t("Remove"),
      cancelText: t("Cancel"),
      destructive: true,
      onConfirm: () => void accountStore.revokeDevice(id),
    });

  const confirmSignOut = () =>
    Dialog.confirm({
      title: t("Sign out?"),
      message: t("This phone will forget your account."),
      confirmText: t("Sign out"),
      cancelText: t("Cancel"),
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

      <SettingsSection title={t("Devices")}>
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
            label={t("Register this phone")}
            loading={account.busy === "registerPhone"}
            onPress={() => void accountStore.registerPhone()}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection>
        <ListActionRow
          label={t("Sign out")}
          tone="danger"
          loading={account.busy === "signOut"}
          onPress={confirmSignOut}
        />
      </SettingsSection>
    </>
  );
}
