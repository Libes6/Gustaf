import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { PanelLeft } from "lucide-react";
import { useT } from "../i18n";
import { useApp } from "../state";

export function WindowHeader() {
  const app = useApp();
  const t = useT();
  const title = app.view === "settings" ? (app.locale === "ru" ? "Настройки" : "Settings") : app.chats.find(c => c.id === app.activeChat)?.title ?? "M Code";
  return <header className="window-header" onMouseDown={e => {
    if ((e.target as HTMLElement).closest("button") || e.button !== 0 || !isTauri()) return;
    e.preventDefault();
    const window = getCurrentWindow();
    (e.detail === 2 ? window.toggleMaximize() : window.startDragging()).catch(console.error);
  }}>{app.onboarded && app.view === "chat" && <button className="icon-btn" title={t("toggleSidebar")} onClick={() => app.setSideHidden(!app.sideHidden)}><PanelLeft size={15} /></button>}<span>{title}</span></header>;
}
