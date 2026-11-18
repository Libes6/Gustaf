import { t } from "../i18n";
import type { ColorValue } from "react-native";
import { Image } from "expo-image";

export function GustafMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Image
      source={require("../../assets/gustaf-icon.png")}
      accessibilityLabel={t("Gustaf")}
      contentFit="contain"
      style={{ width: props.height, height: props.height }}
    />
  );
}
