// @effect-diagnostics globalTimers:off - A plain store for React hooks, outside an Effect runtime.
// The Gustaf cloud's client config (GET /v1/client-config in apps/api): announcements, the
// minimum supported version and feature flags. Every failure falls back to the last cached
// config, or to an empty one, so the app never waits on or breaks because of the cloud.

export type AnnouncementLevel = "info" | "warning" | "critical";

export interface ClientAnnouncement {
  readonly id: string;
  readonly level: AnnouncementLevel;
  readonly text: { readonly en: string; readonly ru: string };
  readonly link: string | null;
}

export interface ClientConfig {
  readonly announcements: ReadonlyArray<ClientAnnouncement>;
  readonly update: {
    readonly required: boolean;
    readonly minimumVersion: string | null;
    readonly message: string | null;
  };
  readonly flags: Readonly<Record<string, boolean>>;
}

export const EMPTY_CLIENT_CONFIG: ClientConfig = {
  announcements: [],
  update: { required: false, minimumVersion: null, message: null },
  flags: {},
};

export const CLIENT_CONFIG_REFRESH_MS = 3 * 60 * 60 * 1000;
const CACHE_KEY = "gustaf.clientConfig.v1";
const DISMISSED_KEY = "gustaf.dismissedAnnouncements.v1";
const MAX_DISMISSED = 200;
const LEVELS = new Set<AnnouncementLevel>(["info", "warning", "critical"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);

function decodeAnnouncement(value: unknown): ClientAnnouncement | null {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.text)) return null;
  const { en, ru } = value.text;
  if (typeof en !== "string" || typeof ru !== "string") return null;
  const level = LEVELS.has(value.level as AnnouncementLevel)
    ? (value.level as AnnouncementLevel)
    : "info";
  const link = stringOrNull(value.link);
  return {
    id: value.id,
    level,
    text: { en, ru },
    link: link && /^https:\/\//i.test(link) ? link : null,
  };
}

/** Lenient: unknown fields and malformed entries are dropped, not fatal. */
export function decodeClientConfig(value: unknown): ClientConfig | null {
  if (!isRecord(value)) return null;
  const announcements = Array.isArray(value.announcements)
    ? value.announcements.flatMap((entry) => decodeAnnouncement(entry) ?? [])
    : [];
  const update = isRecord(value.update) ? value.update : {};
  const flags = isRecord(value.flags)
    ? Object.fromEntries(Object.entries(value.flags).filter(([, on]) => typeof on === "boolean"))
    : {};
  return {
    announcements,
    update: {
      required: update.required === true,
      minimumVersion: stringOrNull(update.minimumVersion),
      message: stringOrNull(update.message),
    },
    flags: flags as Record<string, boolean>,
  };
}

export function announcementText(announcement: ClientAnnouncement, language: string): string {
  return language.toLowerCase().startsWith("ru") ? announcement.text.ru : announcement.text.en;
}

export function isFeatureEnabled(config: ClientConfig, key: string): boolean {
  return config.flags[key] === true;
}

export interface ClientConfigStorage {
  readonly getItem: (key: string) => string | null | Promise<string | null>;
  readonly setItem: (key: string, value: string) => void | Promise<void>;
}

export interface ClientConfigSnapshot {
  readonly config: ClientConfig;
  /** Announcements to show: the config's, minus the ones dismissed on this device. */
  readonly announcements: ReadonlyArray<ClientAnnouncement>;
}

/**
 * Holds the config for one app version. A cached config from another version is ignored, so
 * an update notice never outlives the update. Shaped for `useSyncExternalStore`.
 */
export function createClientConfigStore(options: {
  readonly version: string;
  readonly fetchConfig: () => Promise<unknown>;
  readonly storage: ClientConfigStorage;
  readonly refreshMs?: number;
}) {
  let config = EMPTY_CLIENT_CONFIG;
  let dismissed: ReadonlyArray<string> = [];
  let snapshot: ClientConfigSnapshot = { config, announcements: [] };
  const listeners = new Set<() => void>();

  const publish = () => {
    const hidden = new Set(dismissed);
    snapshot = {
      config,
      announcements: config.announcements.filter((item) => !hidden.has(item.id)),
    };
    for (const listener of listeners) listener();
  };

  const read = async (key: string) => {
    try {
      return await options.storage.getItem(key);
    } catch {
      return null;
    }
  };
  const write = async (key: string, value: string) => {
    try {
      await options.storage.setItem(key, value);
    } catch {
      // Storage is a convenience; without it the app just refetches and may show a banner again.
    }
  };

  let fetched = false;
  const restore = async () => {
    const [cached, savedDismissed] = await Promise.all([read(CACHE_KEY), read(DISMISSED_KEY)]);
    try {
      const parsed: unknown = savedDismissed ? JSON.parse(savedDismissed) : [];
      if (Array.isArray(parsed)) dismissed = parsed.filter((id) => typeof id === "string");
    } catch {}
    try {
      const parsed: unknown = cached ? JSON.parse(cached) : null;
      const restored =
        isRecord(parsed) && parsed.version === options.version
          ? decodeClientConfig(parsed.config)
          : null;
      // A fetch that finished first is newer than the cache.
      if (restored && !fetched) config = restored;
    } catch {}
    publish();
  };

  const refresh = async () => {
    try {
      const next = decodeClientConfig(await options.fetchConfig());
      if (!next) return;
      fetched = true;
      config = next;
      publish();
      await write(CACHE_KEY, JSON.stringify({ version: options.version, config }));
    } catch {
      // Offline, signed out of a broken session, or the cloud is down: keep what we have.
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    restore,
    refresh,
    /** Restores the cache, fetches, and refetches on an interval; returns the stop function. */
    start: () => {
      void restore().then(refresh);
      const timer = setInterval(
        () => void refresh(),
        options.refreshMs ?? CLIENT_CONFIG_REFRESH_MS,
      );
      return () => clearInterval(timer);
    },
    dismiss: (id: string) => {
      if (dismissed.includes(id)) return;
      dismissed = [...dismissed, id].slice(-MAX_DISMISSED);
      publish();
      void write(DISMISSED_KEY, JSON.stringify(dismissed));
    },
  };
}

export type ClientConfigStore = ReturnType<typeof createClientConfigStore>;
