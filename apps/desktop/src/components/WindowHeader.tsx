import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { PanelLeft } from "lucide-react";
import { useT } from "../i18n";
import { isMac } from "../lib/platform";
import { useApp } from "../state";

export function WindowHeader() {
  const app = useApp();
  const t = useT();
  const title = app.view === "settings" ? (app.locale === "ru" ? "Настройки" : "Settings") : app.chats.find(c => c.id === app.activeChat)?.title ?? "Gustaf";
  return <header className="window-header" onMouseDown={e => {
    // Only macOS has the overlay title bar; elsewhere the native decorations handle dragging and maximizing.
    if (!isMac() || (e.target as HTMLElement).closest("button") || e.button !== 0 || !isTauri()) return;
    e.preventDefault();
    const window = getCurrentWindow();
    (e.detail === 2 ? window.toggleMaximize() : window.startDragging()).catch(console.error);
  }}>{app.onboarded && app.view === "chat" && <button className="icon-btn" title={t("toggleSidebar")} aria-label={t("toggleSidebar")} aria-expanded={!app.sideHidden} onClick={() => app.setSideHidden(!app.sideHidden)}><PanelLeft size={15} /></button>}<span>{title}</span></header>;
}
