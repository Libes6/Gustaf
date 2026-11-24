import { msg, T, useGT, useMessages } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import type { UsageLimitsDisplay } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../../../components/ui/AppText";
import { ListChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../../../state/preferences";
import { useAtomCommand } from "../../../../state/use-atom-command";
import { SettingsSection } from "../../components/SettingsSection";
import { DEFAULT_USAGE_LIMITS_DISPLAY } from "@t3tools/shared/usageLimitsDisplay";

const USAGE_LIMITS_DISPLAY_OPTIONS: ReadonlyArray<{
  readonly value: UsageLimitsDisplay;
  readonly label: string;
}> = [
  { value: "used", label: msg("Used", { $context: "show limits as the share spent" }) },
  { value: "remaining", label: msg("Remaining", { $context: "show limits as the share left" }) },
];

export function UsageLimitsAppearanceSection() {
  const gt = useGT();
  const m = useMessages();
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const selected = AsyncResult.isSuccess(preferences)
    ? (preferences.value.usageLimitsDisplay ?? DEFAULT_USAGE_LIMITS_DISPLAY)
    : null;

  return (
    <View className="gap-3">
      <SettingsSection title={gt("Limits display")}>
        {USAGE_LIMITS_DISPLAY_OPTIONS.map((option, index) => (
          <ListChoiceRow
            key={option.value}
            label={m(option.label)}
            selected={selected === option.value}
            separated={index > 0}
            disabled={selected === null}
            onPress={() => {
              void savePreferences({ usageLimitsDisplay: option.value });
            }}
          />
        ))}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        <T>Show provider usage limits as the share already used, or the share still remaining.</T>
      </Text>
    </View>
  );
}
