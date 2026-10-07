import type { ChatSummary, PairingQrPayload, ProjectSummary } from "@gustaf/protocol";
import { create } from "zustand";
import { GustafClient, pairWithDesktop, type ConnectionState, type DesktopApi } from "../api/client.ts";
import { MockServer } from "../api/mock.ts";
import { isPinningAvailable, pinnedTransport } from "../../modules/gustaf-pinned";
import {
  deleteToken,
  loadDesktops,
  loadPrefs,
  loadToken,
  saveDesktops,
  savePrefs,
  saveToken,
  type PairedDesktop,
  type Prefs,
} from "../storage/secure.ts";

/**
 * App-wide state: preferences, paired desktops and the one active `DesktopApi` (real or mock). zustand is used instead of
 * React context because screens subscribe to slices without a provider tree and the store is usable outside components
 * (the API client's listeners); it adds one tiny dependency and no native code.
 */
interface Store {
  ready: boolean;
  prefs: Prefs;
  desktops: PairedDesktop[];
  api: DesktopApi | null;
  /** "demo" while the in-memory mock is active. */
  mode: "none" | "demo" | "real";
  activeDesktop: PairedDesktop | null;
  connection: ConnectionState | "none";
  /** The chat shown on the main screen. `chatId: null` is a new chat in `projectId` (created by the first message). */
  current: { chatId: number | null; projectId: number | null };
  /** Projects with their chats for the menu; null until the first load. */
  index: { projects: ProjectSummary[]; chats: ChatSummary[] } | null;
  indexError: string | null;
  menuOpen: boolean;

  init(): Promise<void>;
  setPrefs(patch: Partial<Prefs>): void;
  startDemo(): void;
  pair(payload: PairingQrPayload, deviceName: string): Promise<void>;
  connectTo(desktop: PairedDesktop): Promise<void>;
  disconnect(): void;
  forget(id: string): Promise<void>;
  openChat(chatId: number, projectId: number): void;
  newChat(projectId?: number | null): void;
  setMenu(open: boolean): void;
  refreshIndex(): Promise<void>;
}

let unsubConn: (() => void) | null = null;
let unsubEvents: (() => void) | null = null;
let indexTimer: ReturnType<typeof setTimeout> | null = null;
/** The certificate-pinning transport where the native module exists; otherwise the default one (which rejects the desktop's self-signed certificate). */
const transport = isPinningAvailable ? pinnedTransport : undefined;

export const useStore = create<Store>((set, get) => {
  const attach = (api: DesktopApi, mode: "demo" | "real", desktop: PairedDesktop | null) => {
    get().disconnect();
    unsubConn = api.onConnection((connection) => {
      set({ connection });
      if (connection === "connected") void get().refreshIndex();
    });
    // The menu follows the desktop: a changed chat or a new message refreshes the list (collapsed, so bursts cost one request).
    unsubEvents = api.subscribe((e) => {
      if (e.type !== "chat.updated" && e.type !== "run.finished" && e.type !== "message.created") return;
      if (indexTimer) clearTimeout(indexTimer);
      indexTimer = setTimeout(() => void get().refreshIndex(), 500);
    });
    set({ api, mode, activeDesktop: desktop, connection: "connecting", current: { chatId: null, projectId: null }, index: null, indexError: null });
    api.connect();
  };

  return {
    ready: false,
    prefs: { theme: "system", locale: "system" },
    desktops: [],
    api: null,
    mode: "none",
    activeDesktop: null,
    connection: "none",
    current: { chatId: null, projectId: null },
    index: null,
    indexError: null,
    menuOpen: false,

    async init() {
      const [prefs, desktops] = await Promise.all([loadPrefs(), loadDesktops()]);
      set({ prefs, desktops, ready: true });
      const first = desktops[0];
      if (first) await get().connectTo(first);
    },

    setPrefs(patch) {
      const prefs = { ...get().prefs, ...patch };
      set({ prefs });
      void savePrefs(prefs).catch(() => {});
    },

    startDemo() {
      attach(new MockServer(), "demo", null);
    },

    async pair(payload, deviceName) {
      const res = await pairWithDesktop(payload, deviceName, transport);
      const desktop: PairedDesktop = {
        id: res.deviceId,
        name: res.desktopName,
        host: payload.host,
        port: payload.port,
        fingerprint: payload.fingerprint,
        pairedAt: Date.now(),
      };
      await saveToken(desktop.id, res.token);
      const desktops = [...get().desktops.filter((d) => d.id !== desktop.id), desktop];
      await saveDesktops(desktops);
      set({ desktops });
      attach(new GustafClient({ ...desktop, token: res.token, transport }), "real", desktop);
    },

    async connectTo(desktop) {
      const token = await loadToken(desktop.id);
      if (!token) return;
      attach(new GustafClient({ ...desktop, token, transport }), "real", desktop);
    },

    disconnect() {
      unsubConn?.();
      unsubConn = null;
      unsubEvents?.();
      unsubEvents = null;
      if (indexTimer) clearTimeout(indexTimer);
      get().api?.close();
      set({ api: null, mode: "none", activeDesktop: null, connection: "none", index: null, indexError: null, current: { chatId: null, projectId: null }, menuOpen: false });
    },

    openChat(chatId, projectId) {
      set({ current: { chatId, projectId }, menuOpen: false });
    },

    newChat(projectId) {
      const { current, index } = get();
      const project = projectId ?? current.projectId ?? index?.projects[0]?.id ?? null;
      set({ current: { chatId: null, projectId: project }, menuOpen: false });
    },

    setMenu(open) {
      set({ menuOpen: open });
    },

    async refreshIndex() {
      const api = get().api;
      if (!api) return;
      try {
        const projects = await api.listProjects();
        const chats = (await Promise.all(projects.map((p) => api.listChats(p.id)))).flat().filter((c) => !c.archived);
        if (get().api !== api) return;
        set({ index: { projects, chats }, indexError: null });
        // A fresh start lands in the project of the most recent chat.
        if (get().current.projectId === null && get().current.chatId === null) {
          const latest = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)[0];
          set({ current: { chatId: null, projectId: latest?.projectId ?? projects[0]?.id ?? null } });
        }
      } catch (e) {
        if (get().api === api) set({ indexError: e instanceof Error ? e.message : String(e) });
      }
    },

    async forget(id) {
      if (get().activeDesktop?.id === id) get().disconnect();
      await deleteToken(id).catch(() => {});
      const desktops = get().desktops.filter((d) => d.id !== id);
      await saveDesktops(desktops);
      set({ desktops });
    },
  };
});
