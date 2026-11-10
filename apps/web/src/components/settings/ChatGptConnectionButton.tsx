import type { ComponentProps } from "react";
import { OpenAI } from "../Icons";
import { Button } from "../ui/button";
import { useT } from "../../useUiLanguage";

export function ChatGptConnectionButton({ children, ...props }: ComponentProps<typeof Button>) {
  const t = useT();
  return (
    <Button {...props}>
      <OpenAI className="size-4 shrink-0" aria-hidden="true" />
      {children ?? t("settingsA.chatGpt.continueWithChatGpt")}
    </Button>
  );
}
