import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import { I18nProvider, type Locale } from "../../src/i18n";
import type { Chat, Project } from "../../src/lib/data";
import type { ProviderConfig } from "../../src/providers/types";
import { AppContext, type AppState } from "../../src/state";

export const project = (over: Partial<Project> = {}): Project => ({
  id: 1,
  name: "Alpha",
  path: "/work/alpha",
  pinned: 0,
  created_at: 1,
  ...over,
});
export const chat = (over: Partial<Chat> = {}): Chat =>
  ({ id: 1, project_id: 1, title: "First chat", updated_at: 1_700_000_000_000, ...over }) as Chat;
export const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({ id: "p1", name: "Anthropic", kind: "anthropic", ...over }) as ProviderConfig;

/**
 * A complete app state with sensible defaults; every function not given is a `vi.fn()` spy (created on first access,
 * the same spy every time). Override only what the test cares about.
 */
export function makeApp(over: Record<string, unknown> = {}): AppState {
  const base: Record<string, unknown> = {
    ready: true,
    locale: "en",
    onboarded: true,
    selection: null,
    reasoning: "medium",
    access: "auto",
    computerUse: false,
    reviewCopy: false,
    followUp: "queue",
    favorites: [],
    hiddenModels: [],
    checkedAt: 0,
    allowlist: [],
    sections: [],
    usage: {},
    tokenStats: {},
    limits: {},
    loadingLimits: null,
    limitErrors: {},
    projects: [],
    chats: [],
    providers: [],
    models: [],
    modelErrors: {},
    activeChat: null,
    draftProject: null,
    sessions: { active: "initial", items: [{ key: "initial", chatId: null, projectId: null }] },
    jump: null,
    providerHealth: {},
    checkingProvider: null,
    view: "chat",
    settingsPage: "general",
    settingTarget: null,
    sideHidden: false,
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) => (k in t ? t[k] : (t[k] = vi.fn())),
  }) as unknown as AppState;
}

export function renderApp(ui: ReactElement, app: AppState = makeApp(), locale: Locale = "en") {
  const wrap = (node: ReactElement) => (
    <I18nProvider locale={locale}>
      <AppContext.Provider value={app}>{node}</AppContext.Provider>
    </I18nProvider>
  );
  const result = render(wrap(ui));
  return { app, ...result, rerenderApp: (next: ReactElement) => result.rerender(wrap(next)) };
}
