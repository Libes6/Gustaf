import type { PairingQrPayload } from "@mcode/protocol";
import { create } from "zustand";
import { MCodeClient, pairWithDesktop, type ConnectionState, type DesktopApi } from "../api/client.ts";
import { MockServer } from "../api/mock.ts";
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

  init(): Promise<void>;
  setPrefs(patch: Partial<Prefs>): void;
  startDemo(): void;
  pair(payload: PairingQrPayload, deviceName: string): Promise<void>;
  connectTo(desktop: PairedDesktop): Promise<void>;
  disconnect(): void;
  forget(id: string): Promise<void>;
}

let unsubConn: (() => void) | null = null;

export const useStore = create<Store>((set, get) => {
  const attach = (api: DesktopApi, mode: "demo" | "real", desktop: PairedDesktop | null) => {
    get().disconnect();
    unsubConn = api.onConnection((connection) => set({ connection }));
    set({ api, mode, activeDesktop: desktop, connection: "connecting" });
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
      const res = await pairWithDesktop(payload, deviceName);
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
      attach(new MCodeClient({ ...desktop, token: res.token }), "real", desktop);
    },

    async connectTo(desktop) {
      const token = await loadToken(desktop.id);
      if (!token) return;
      attach(new MCodeClient({ ...desktop, token }), "real", desktop);
    },

    disconnect() {
      unsubConn?.();
      unsubConn = null;
      get().api?.close();
      set({ api: null, mode: "none", activeDesktop: null, connection: "none" });
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
