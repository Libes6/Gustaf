// Tauri side of the quick-ask feature: the Rust commands (src-tauri/src/quick_ask.rs) and the events between the
// quick-ask window and the main window. Components use this module only, so tests replace it with one vi.mock.
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { QUICK_ASK_EVENTS, type OpenChatEvent, type UsageEvent } from "./quickAsk";

export const quickAskApi = {
  /** Turns the feature on/off and (re)registers the global shortcut. Rejects with `<code>: <message>` when that fails. */
  configure: (enabled: boolean, accelerator: string | null, hideOnBlur: boolean) => invoke<void>("quick_ask_configure", { enabled, accelerator, hideOnBlur }),
  show: () => invoke<void>("quick_ask_show"),
  hide: () => invoke<void>("quick_ask_hide"),
  toggle: () => invoke<void>("quick_ask_toggle"),
  /** The page is loaded (reveals a window that was just created). */
  ready: () => invoke<void>("quick_ask_ready"),
  resize: (height: number) => invoke<void>("quick_ask_resize", { height }),
  /** Hides the quick-ask window and brings the main window to the front. */
  openMain: () => invoke<void>("quick_ask_open_main"),
  onShown: (cb: () => void) => listen(QUICK_ASK_EVENTS.shown, cb),
  emitUsage: (e: UsageEvent) => emitTo("main", QUICK_ASK_EVENTS.usage, e),
  emitOpenChat: (e: OpenChatEvent) => emitTo("main", QUICK_ASK_EVENTS.openChat, e),
  /** Main window: listeners for what the quick-ask window reports. */
  onUsage: (cb: (e: UsageEvent) => void) => listen<UsageEvent>(QUICK_ASK_EVENTS.usage, (ev) => cb(ev.payload)),
  onOpenChat: (cb: (e: OpenChatEvent) => void) => listen<OpenChatEvent>(QUICK_ASK_EVENTS.openChat, (ev) => cb(ev.payload)),
};
