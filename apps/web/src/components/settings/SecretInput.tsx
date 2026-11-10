import { DraftInput, type DraftInputProps } from "../ui/draft-input";
import { Input, type InputProps } from "../ui/input";
import { useT } from "../../useUiLanguage";

type SecretInputProps = Omit<InputProps, "type" | "autoComplete" | "defaultValue" | "value"> & {
  /** Pass only the replacement draft as `value`. */
  readonly configured?: boolean;
  readonly value: string;
  readonly onCommit?: DraftInputProps["onCommit"];
};

export function SecretInput({
  configured = false,
  placeholder,
  onCommit,
  ...props
}: SecretInputProps) {
  const t = useT();
  const shared = {
    ...props,
    type: "password" as const,
    autoComplete: "off",
    spellCheck: false,
    placeholder: configured
      ? t("settingsD.secretInput.storedReplace")
      : (placeholder ?? t("settingsD.secretInput.notSet")),
  };
  if (onCommit) {
    return (
      <DraftInput
        {...shared}
        onCommit={(next) => {
          if (configured && next === "") return;
          onCommit(next);
        }}
      />
    );
  }
  return <Input {...shared} />;
}
