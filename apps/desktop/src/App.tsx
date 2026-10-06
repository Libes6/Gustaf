import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { useEffect, useState } from "react";
import { UpdatesProvider } from "./components/UpdaterPanel";
import { WindowHeader } from "./components/WindowHeader";
import { ChatView } from "./components/ChatView";
import { BudgetBanner } from "./components/Budgets";
import { Compare } from "./components/Compare";
import { CreateProjectDialog } from "./components/CreateProjectDialog";
import { Onboarding } from "./components/Onboarding";
import { MobileStatusBridge } from "./components/MobileBridge";
import { ScheduledPromptsRuntime } from "./components/ScheduledPromptsRuntime";
import { SearchPalette } from "./components/SearchPalette";
import { Settings } from "./components/Settings";
import { Rail, Sidebar } from "./components/Sidebar";
import { I18nProvider } from "./i18n";
import { isSearchShortcut } from "./lib/searchUtil";
import { useAttentionNotifications, useChatStatusSync } from "./lib/attention";
import { acceleratorOf, matches } from "./lib/shortcuts";
import { useQuickAskHost } from "./lib/quickAskHost";
import { startScratchChat } from "./lib/scratch";
import { startPrWatchPoller } from "./lib/prWatch";
import { AppProvider, type AppState } from "./state";

function Shell({ app }: { app: AppState }) {
  const [creating, setCreating] = useState(false);
  const [searching, setSearching] = useState(false);
  const [comparing, setComparing] = useState(false);
  useAttentionNotifications();
  useChatStatusSync(app.activeChat, app.view);
  useQuickAskHost(app);
  useEffect(() => startPrWatchPoller(), []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (matches(e, "settings")) (e.preventDefault(), app.openSettings());
      if (matches(e, "newChat")) (e.preventDefault(), app.newChat());
      if (matches(e, "newScratchChat")) (e.preventDefault(), void startScratchChat(app));
      if (isSearchShortcut(e) && app.ready && app.onboarded) (e.preventDefault(), setSearching(open => !open));
      if (matches(e, "closeSettings") && app.view === "settings") app.setView("chat");
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [app.view, app.ready, app.onboarded]);

  useEffect(() => {
    const accelerator = acceleratorOf("stopAgent");
    let disposed = false;
    register(accelerator, () => dispatchEvent(new Event("gustaf-stop"))).then(() => { if (disposed) unregister(accelerator); }).catch(() => {});
    return () => { disposed = true; unregister(accelerator).catch(() => {}); };
  }, []);
  if (!app.ready) return null;
  if (!app.onboarded) return <Onboarding />;
  return (
    <div className={`app${app.sideHidden && app.view === "chat" ? " side-hidden" : ""}`}>
      <WindowHeader />
      <ScheduledPromptsRuntime />
      <MobileStatusBridge />
      <BudgetBanner />
      <Rail onCreateProject={() => setCreating(true)} onCompare={() => setComparing(true)} />
      {app.view === "settings" ? (
        <Settings />
      ) : (
        <>
          <Sidebar onCreateProject={() => setCreating(true)} onSearch={() => setSearching(true)} />

        </>
      )}
      {app.sessions.items.map(session => <div key={session.key} className="chat-session" style={{ display: app.view === "chat" && app.sessions.active === session.key ? "flex" : "none" }}>
        <ChatView session={session} visible={app.view === "chat" && app.sessions.active === session.key} />
      </div>)}
      {comparing && <Compare onClose={() => setComparing(false)} />}
      {searching && <SearchPalette onClose={() => setSearching(false)} />}
      {creating && (
        <CreateProjectDialog
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await app.reload();
            app.newChat(id);
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      {(app) => (
        <I18nProvider locale={app.locale}>
          <UpdatesProvider><Shell app={app} /></UpdatesProvider>
        </I18nProvider>
      )}
    </AppProvider>
  );
}
