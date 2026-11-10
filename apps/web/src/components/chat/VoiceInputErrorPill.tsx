import { MICROPHONE_PERMISSION_ERROR } from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { RotateCcwIcon, SettingsIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceInputPill } from "./VoiceInputPill";
import { useT } from "../../useUiLanguage";
import type { MessageKey } from "~/i18n";

// Raw backend messages stay English (they are lookup keys); the shown text comes from messages.
const VOICE_ERROR_TEXT: Record<string, { label: MessageKey; message: MessageKey }> = {
  [MICROPHONE_PERMISSION_ERROR]: {
    label: "chatB.VoiceInputErrorPill.micPermissionLabel",
    message: "chatB.VoiceInputErrorPill.micPermissionMessage",
  },
  "Microphone access is required for voice input.": {
    label: "chatB.VoiceInputErrorPill.micAccessLabel",
    message: "chatB.VoiceInputErrorPill.micAccessMessage",
  },
  "This draft is no longer available.": {
    label: "chatB.VoiceInputErrorPill.draftUnavailableLabel",
    message: "chatB.VoiceInputErrorPill.draftUnavailableMessage",
  },
  "Another voice recording is already active.": {
    label: "chatB.VoiceInputErrorPill.anotherRecordingLabel",
    message: "chatB.VoiceInputErrorPill.anotherRecordingMessage",
  },
  "Voice transcription is not available.": {
    label: "chatB.VoiceInputErrorPill.transcriptionUnavailableLabel",
    message: "chatB.VoiceInputErrorPill.transcriptionUnavailableMessage",
  },
  "Voice transcription is still finishing. Try again shortly.": {
    label: "chatB.VoiceInputErrorPill.transcriptionBusyLabel",
    message: "chatB.VoiceInputErrorPill.transcriptionBusyMessage",
  },
  "Voice transcription is not available for this language.": {
    label: "chatB.VoiceInputErrorPill.languageUnsupportedLabel",
    message: "chatB.VoiceInputErrorPill.languageUnsupportedMessage",
  },
  "Could not prepare voice transcription.": {
    label: "chatB.VoiceInputErrorPill.prepareFailedLabel",
    message: "chatB.VoiceInputErrorPill.prepareFailedMessage",
  },
  "Could not start voice recording.": {
    label: "chatB.VoiceInputErrorPill.startFailedLabel",
    message: "chatB.VoiceInputErrorPill.startFailedMessage",
  },
  "Voice recording was interrupted.": {
    label: "chatB.VoiceInputErrorPill.interruptedLabel",
    message: "chatB.VoiceInputErrorPill.interruptedMessage",
  },
  "Could not finish voice recording.": {
    label: "chatB.VoiceInputErrorPill.finishFailedLabel",
    message: "chatB.VoiceInputErrorPill.finishFailedMessage",
  },
  "Could not transcribe this recording.": {
    label: "chatB.VoiceInputErrorPill.transcribeFailedLabel",
    message: "chatB.VoiceInputErrorPill.transcribeFailedMessage",
  },
  "Voice transcription on this environment failed.": {
    label: "chatB.VoiceInputErrorPill.transcribeEnvFailedLabel",
    message: "chatB.VoiceInputErrorPill.transcribeEnvFailedMessage",
  },
  "The draft changed while voice input was running. The transcript was not added.": {
    label: "chatB.VoiceInputErrorPill.draftChangedLabel",
    message: "chatB.VoiceInputErrorPill.draftChangedMessage",
  },
  "No speech was detected.": {
    label: "chatB.VoiceInputErrorPill.noSpeechLabel",
    message: "chatB.VoiceInputErrorPill.noSpeechMessage",
  },
  "Microphone processing failed.": {
    label: "chatB.VoiceInputErrorPill.micProcessingLabel",
    message: "chatB.VoiceInputErrorPill.micProcessingMessage",
  },
  "The microphone disconnected.": {
    label: "chatB.VoiceInputErrorPill.micDisconnectedLabel",
    message: "chatB.VoiceInputErrorPill.micDisconnectedMessage",
  },
};

function voiceErrorLabel(error: string | null, t: (key: MessageKey) => string): string {
  const entry = error ? VOICE_ERROR_TEXT[error] : undefined;
  return entry ? t(entry.label) : t("chatB.VoiceInputErrorPill.voiceInputFailed");
}

function voiceErrorMessage(error: string | null, t: (key: MessageKey) => string): string {
  const entry = error ? VOICE_ERROR_TEXT[error] : undefined;
  return entry ? t(entry.message) : (error ?? t("chatB.VoiceInputErrorPill.voiceInputFailed"));
}

export function VoiceInputErrorPill(props: {
  error: string | null;
  errorAction: "retry" | "settings" | null;
  disabled?: boolean;
  cancelShortcutLabel?: string | null;
  onRetry(): void;
  onDismiss(): void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const openSettings = props.errorAction === "settings";
  const actionLabel = openSettings
    ? t("chatB.VoiceInputErrorPill.openVoiceSettings")
    : props.error === "Could not transcribe this recording." ||
        props.error === "Voice transcription on this environment failed."
      ? t("chatB.VoiceInputErrorPill.retryTranscription")
      : t("chatB.VoiceInputErrorPill.recordAgain");
  return (
    <VoiceInputPill>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm-pill"
              variant="ghost"
              aria-label={t("chatB.VoiceInputErrorPill.dismissVoiceError")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onDismiss}
            >
              <XIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">
          {t("chatB.VoiceInputErrorPill.dismissVoiceError")}
          {props.cancelShortcutLabel ? ` (${props.cancelShortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              role="status"
              aria-label={voiceErrorMessage(props.error, t)}
              className="min-w-0 flex-1 truncate text-sm text-destructive"
            />
          }
        >
          {voiceErrorLabel(props.error, t)}
        </TooltipTrigger>
        <TooltipPopup side="top">{voiceErrorMessage(props.error, t)}</TooltipPopup>
      </Tooltip>
      {props.errorAction ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm-pill"
                variant="ghost"
                aria-label={actionLabel}
                disabled={props.disabled}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (openSettings) {
                    props.onDismiss();
                    void navigate({ to: "/settings/voice" });
                  } else {
                    props.onRetry();
                  }
                }}
              >
                {openSettings ? <SettingsIcon /> : <RotateCcwIcon />}
              </Button>
            }
          />
          <TooltipPopup side="top">{actionLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </VoiceInputPill>
  );
}
