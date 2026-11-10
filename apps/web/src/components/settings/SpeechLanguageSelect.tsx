import type { EnvironmentSpeechStatus } from "@t3tools/contracts";
import { effectiveSpeechLanguage } from "@t3tools/shared/speech";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useT } from "../../useUiLanguage";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
export const languageLabel = (code: string) => languageNames.of(code) ?? code;

type ModelLanguages = Pick<
  Extract<EnvironmentSpeechStatus, { supported: true }>,
  "languages" | "supportsLanguageDetection"
>;

export function SpeechLanguageSelect({ model }: { readonly model: ModelLanguages | null }) {
  const t = useT();
  const preference = useClientSettings((settings) => settings.speechLanguage);
  const languages = model?.languages ?? [];
  const resolved = model
    ? effectiveSpeechLanguage(
        { languages, supportsLanguageDetection: model.supportsLanguageDetection ?? false },
        preference,
      )
    : preference;
  const effectiveLabel =
    resolved === "auto" ? t("settingsD.speechLanguageSelect.autoDetect") : languageLabel(resolved);
  const unavailable =
    preference !== "auto" && preference !== resolved
      ? t("settingsD.speechLanguageSelect.unavailable").replace(
          "{language}",
          languageLabel(preference),
        )
      : null;
  const label = unavailable
    ? `${effectiveLabel} (${unavailable})`
    : preference === "auto" && resolved !== "auto"
      ? t("settingsD.speechLanguageSelect.autoWithLabel").replace("{label}", effectiveLabel)
      : effectiveLabel;
  return (
    <Select
      value={preference}
      disabled={!model}
      onValueChange={(value) => {
        if (value) void updateClientSettings({ speechLanguage: value });
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={t("settingsD.speechLanguageSelect.transcriptionLanguage")}
        className="max-w-64"
      >
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value="auto">{t("settingsD.speechLanguageSelect.auto")}</SelectItem>
        {unavailable ? (
          <SelectItem value={preference} disabled>
            {unavailable}
          </SelectItem>
        ) : null}
        {languages
          .toSorted((left, right) => languageLabel(left).localeCompare(languageLabel(right)))
          .map((code) => (
            <SelectItem key={code} value={code}>
              {languageLabel(code)}
            </SelectItem>
          ))}
      </SelectPopup>
    </Select>
  );
}
