import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { openSession, promoteSession, isAuthError, type Sessions } from "./lib/chatSessions";
import type { Jump } from "./lib/searchUtil";
import type { Access } from "./agent/agent";
import { detectLocale, type Locale } from "./i18n";
import { getSetting, setSetting } from "./lib/api";
import { listChats, listProjects, type Chat, type Project } from "./lib/data";
import { getAdapter, listAllModels, loadProviders } from "./providers";
import { readSubscriptionLimits } from "./providers/limits";
import type { TokenUsage, LimitWindow, ModelInfo, ProviderConfig, Reasoning } from "./providers/types";

export type Model = ModelInfo & { firstSeen: number };
export const modelKey = (m: { providerId: string; id: string }) => `${m.providerId}\n${m.id}`;
export type Selection = { providerId: string; model: string };
export type Section = { id: string; name: string; chatIds: number[] };
export type SettingsPage = "general" | "import" | "providers" | "usage" | "computer" | "mcp" | "git" | "rules" | "archive";

function usePersisted<T>(key: string, initial: T, ready: boolean) {
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!ready) return;
    getSetting(key, initial).then((v) => {
      setValue(v);
      setLoaded(true);
    });
  }, [ready]);
  const set = useCallback(
    (v: T | ((prev: T) => T)) =>
      setValue((prev) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        setSetting(key, next);
        return next;
      }),
    [key],
  );
  return [value, set, loaded] as const;
}

function useAppState() {
  const [locale, setLocale, localeLoaded] = usePersisted<Locale>("locale", detectLocale(), true);
  const [onboarded, setOnboarded, onboardedLoaded] = usePersisted("onboarded", false, true);
  const [selection, setSelection] = usePersisted<Selection | null>("selection", null, true);
  const [reasoning, setReasoning] = usePersisted<Reasoning>("reasoning", "medium", true);
  const [access, setAccess] = usePersisted<Access>("access", "auto", true);
  const [computerUse, setComputerUse] = usePersisted("computerUse", false, true);
  const [favorites, setFavorites] = usePersisted<string[]>("favorites", [], true);
  const [hiddenModels, setHiddenModels] = usePersisted<string[]>("hiddenModels", [], true);
  const [checkedAt, setCheckedAt] = useState(0);
  const [allowlist, setAllowlist] = usePersisted<string[]>("cmdAllowlist", ["git status", "git diff", "ls", "npm test", "npm run build"], true);
  const [sections, setSections] = usePersisted<Section[]>("sections", [], true);
  const [tokenStats, setTokenStats] = usePersisted<Record<string, TokenUsage & { providerId: string; model: string; turns: number }>>("tokenStats", {}, true);
  const [limits, setLimits] = usePersisted<Record<string, { windows: LimitWindow[]; checkedAt: number }>>("subscriptionLimits", {}, true);
  const [limitErrors, setLimitErrors] = useState<Record<string, string>>({});
  const [loadingLimits, setLoadingLimits] = useState<string | null>(null);
  const recordTokens = (providerId: string, model: string, usage?: TokenUsage) => {
    if (!usage) return;
    const key = modelKey({ providerId, id: model });
    setTokenStats(stats => { const old = stats[key]; return { ...stats, [key]: { providerId, model, turns: (old?.turns ?? 0) + 1, input: (old?.input ?? 0) + usage.input, output: (old?.output ?? 0) + usage.output, cached: (old?.cached ?? 0) + usage.cached, cacheWrite: (old?.cacheWrite ?? 0) + usage.cacheWrite, reasoning: (old?.reasoning ?? 0) + usage.reasoning } }; });
  };
  const recordLimits = (id: string, windows: LimitWindow[]) => setLimits(all => ({ ...all, [id]: { windows: [...(all[id]?.windows ?? []).filter(w => !windows.some(next => next.id === w.id)), ...windows], checkedAt: Date.now() } }));
  const refreshLimits = async (p: ProviderConfig) => {
    if (loadingLimits) return;
    setLoadingLimits(p.id); setLimitErrors(s => ({ ...s, [p.id]: "" }));
    try { recordLimits(p.id, await readSubscriptionLimits(p)); }
    catch (e) { setLimitErrors(s => ({ ...s, [p.id]: String(e instanceof Error ? e.message : e) })); }
    finally { setLoadingLimits(null); }
  };
  const [usage, setUsage] = usePersisted<Record<string, number>>("usage", {}, true);

  const [projects, setProjects] = useState<Project[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<Sessions>({ active: "initial", items: [{ key: "initial", chatId: null, projectId: null }] });
  const activeSession = sessions.items.find(s => s.key === sessions.active)!;
  const activeChat = activeSession.chatId;
  const draftProject = activeSession.projectId;
  const openChat = (id: number, projectId: number | null) => { setSessions(s => openSession(s, id, projectId, crypto.randomUUID())); setView("chat"); };
  // Opening a search result: the chat view scrolls to `jump.messageId` once the chat is shown (lib/useMessageJump.ts).
  const [jump, setJump] = useState<Jump | null>(null);
  const openChatAt = (id: number, projectId: number | null, messageId: number) => { setJump({ chatId: id, messageId, seq: Date.now() }); openChat(id, projectId); };
  const clearJump = useCallback(() => setJump(null), []);
  const newChat = (projectId: number | null = null) => { setSessions(s => openSession(s, null, projectId, crypto.randomUUID())); setView("chat"); };
  const setSessionBusy = (key: string, busy: boolean) => setSessions(s => ({ ...s, items: s.items.map(item => item.key === key ? { ...item, busy } : item) }));
  const promoteChat = (key: string, id: number) => setSessions(s => promoteSession(s, key, id));
  const [providerHealth, setProviderHealth] = usePersisted<Record<string, { status: "ok" | "auth" | "error"; message: string }>>("providerHealth", {}, true);
  const [checkingProvider, setCheckingProvider] = useState<string | null>(null);
  const recordProviderResult = (id: string, message = "") => setProviderHealth(s => ({ ...s, [id]: { status: message ? isAuthError(message) ? "auth" : "error" : "ok", message } }));
  const checkProvider = async (p: ProviderConfig) => {
    if (checkingProvider) return;
    setCheckingProvider(p.id);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const adapter = await getAdapter(p);
      const model = selection?.providerId === p.id ? selection.model : models.find(m => m.providerId === p.id)?.id ?? "default";
      bumpUsage(p.id);
      const out = await adapter.turn({ system: "Reply OK. Do not use tools or access files.", messages: [{ role: "user", parts: [{ type: "text", text: "Reply OK" }] }], model, tools: [], access: "readonly", signal: ctl.signal, onText: () => {}, onLimits: windows => recordLimits(p.id, windows) });
      recordTokens(p.id, model, out.usage);
      if (ctl.signal.aborted) throw new Error("Проверка превысила 30 секунд");
      recordProviderResult(p.id);
    } catch (e) { recordProviderResult(p.id, ctl.signal.aborted ? "Проверка превысила 30 секунд" : String(e instanceof Error ? e.message : e)); }
    finally { clearTimeout(timer); setCheckingProvider(null); }
  };
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const [sideHidden, setSideHidden] = useState(false);

  const reload = useCallback(async () => {
    const [p, c] = await Promise.all([listProjects(), listChats()]);
    setProjects(p);
    setChats(c);
  }, []);

  const refreshModels = useCallback(async (list?: ProviderConfig[]) => {
    const ps = list ?? (await loadProviders());
    setProviders(ps);
    const { models, errors } = await listAllModels(ps);
    setModels(models);
    setModelErrors(errors);
    setCheckedAt(Date.now());
    return models;
  }, []);

  useEffect(() => {
    reload();
    refreshModels();
  }, []);

  const openSettings = (page: SettingsPage = "general") => {
    setSettingsPage(page);
    setView("settings");
  };

  const bumpUsage = (providerId: string) => setUsage((u) => ({ ...u, [providerId]: (u[providerId] ?? 0) + 1 }));

  return {
    ready: localeLoaded && onboardedLoaded,
    locale, setLocale, onboarded, setOnboarded,
    selection, setSelection, reasoning, setReasoning, access, setAccess, computerUse, setComputerUse,
    favorites, setFavorites, hiddenModels, setHiddenModels, checkedAt, allowlist, setAllowlist, sections, setSections, usage, bumpUsage, tokenStats, recordTokens, limits, recordLimits, refreshLimits, loadingLimits, limitErrors,
    projects, chats, reload, providers, models, modelErrors, refreshModels,
    activeChat, draftProject, sessions, setSessionBusy, openChat, openChatAt, jump, clearJump, newChat, promoteChat, providerHealth, recordProviderResult, checkProvider, checkingProvider,
    view, setView, settingsPage, openSettings, sideHidden, setSideHidden,
  };
}

export type AppState = ReturnType<typeof useAppState>;
const Ctx = createContext<AppState>(null!);
/** Exported so component tests (tests/ui) can provide a fake state. */
export const AppContext = Ctx;

export function AppProvider({ children }: { children: (s: AppState) => ReactNode }) {
  const s = useAppState();
  return <Ctx.Provider value={s}>{children(s)}</Ctx.Provider>;
}

export const useApp = () => useContext(Ctx);
