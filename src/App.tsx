import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { useEffect, useState } from "react";
import { WindowHeader } from "./components/WindowHeader";
import { ChatView } from "./components/ChatView";
import { BudgetBanner } from "./components/Budgets";
import { CreateProjectDialog } from "./components/CreateProjectDialog";
import { Onboarding } from "./components/Onboarding";
import { Settings } from "./components/Settings";
import { Rail, Sidebar } from "./components/Sidebar";
import { I18nProvider } from "./i18n";
import { AppProvider, type AppState } from "./state";

function Shell({ app }: { app: AppState }) {
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ",") (e.preventDefault(), app.openSettings());
      if (e.metaKey && e.key.toLowerCase() === "n" && !e.shiftKey) (e.preventDefault(), app.newChat());
      if (e.key === "Escape" && app.view === "settings") app.setView("chat");
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [app.view]);

  useEffect(() => {
    let disposed = false;
    register("CommandOrControl+Shift+Escape", () => dispatchEvent(new Event("mcode-stop"))).then(() => { if (disposed) unregister("CommandOrControl+Shift+Escape"); }).catch(() => {});
    return () => { disposed = true; unregister("CommandOrControl+Shift+Escape").catch(() => {}); };
  }, []);
  if (!app.ready) return null;
  if (!app.onboarded) return <Onboarding />;
  return (
    <div className={`app${app.sideHidden && app.view === "chat" ? " side-hidden" : ""}`}>
      <WindowHeader />
      <BudgetBanner />
      <Rail onCreateProject={() => setCreating(true)} />
      {app.view === "settings" ? (
        <Settings />
      ) : (
        <>
          <Sidebar onCreateProject={() => setCreating(true)} />

        </>
      )}
      {app.sessions.items.map(session => <div key={session.key} className="chat-session" style={{ display: app.view === "chat" && app.sessions.active === session.key ? "flex" : "none" }}>
        <ChatView session={session} visible={app.view === "chat" && app.sessions.active === session.key} />
      </div>)}
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
          <Shell app={app} />
        </I18nProvider>
      )}
    </AppProvider>
  );
}
