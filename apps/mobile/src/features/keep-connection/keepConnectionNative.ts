import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface KeepConnectionNative {
  start(title: string, text: string, stopLabel: string, channelName: string): boolean;
  stop(): void;
  runningSince(): number | null;
  takeTurnedOff(): boolean;
  addListener(event: "onTurnedOff", listener: () => void): { remove(): void };
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<KeepConnectionNative>("T3KeepConnection")
    : null;

export function supportsKeepConnection(): boolean {
  return native !== null;
}

export function startKeepConnection(content: {
  readonly title: string;
  readonly text: string;
  readonly stopLabel: string;
  readonly channelName: string;
}): boolean {
  return (
    native?.start(content.title, content.text, content.stopLabel, content.channelName) ?? false
  );
}

export function stopKeepConnection(): void {
  native?.stop();
}

/** When the running service started, or null when none runs. */
export function keepConnectionRunningSince(): number | null {
  return native?.runningSince() ?? null;
}

/** Whether "Turn off" was tapped in the notification since the last call. */
export function takeKeepConnectionTurnedOff(): boolean {
  return native?.takeTurnedOff() ?? false;
}

export function onKeepConnectionTurnedOff(listener: () => void): () => void {
  const subscription = native?.addListener("onTurnedOff", listener);
  return () => subscription?.remove();
}
