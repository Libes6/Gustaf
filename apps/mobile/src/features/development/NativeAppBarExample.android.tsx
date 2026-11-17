import { t } from "../../i18n";
import { View } from "react-native";
import { Text } from "@expo/ui/jetpack-compose";
import { IconButton } from "../../components/ui/IconButton";
import { NativeAppBar } from "../../components/ui/NativeAppBar.android";

export function NativeAppBarExample() {
  return (
    <NativeAppBar
      title={<Text style={{ fontSize: 21 }}>{t("Native app bar")}</Text>}
      navigationIcon={
        <IconButton icon="arrow.left" accessibilityLabel={t("Example back")} onPress={() => {}} />
      }
      actions={
        <View className="flex-row">
          <IconButton
            icon="magnifyingglass"
            accessibilityLabel={t("Example search")}
            onPress={() => {}}
          />
        </View>
      }
    />
  );
}
