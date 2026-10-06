// Webhook triggers (T12): the config in the "webhooks" setting, the server kept in sync with the schedules, and each
// delivery recorded and turned into a run of its schedule (lib/webhooksCore.ts, src-tauri/src/webhooks.rs).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getSetting, setSetting } from "./api";
import { getScheduled, subscribeScheduled } from "./scheduledPromptsStore";
import { getRunner } from "./scheduledRuntime";
import { activeHooks, addDelivery, newSecret, parseWebhookConfig, webhookPrompt, type Delivery, type DeliveryRecord, type WebhookConfig } from "./webhooksCore";

let config: WebhookConfig = parseWebhookConfig(undefined);
let deliveries: Record<string, DeliveryRecord[]> = {};
let serverPort: number | null = null;
let serverError = "";
const listeners = new Set<() => void>();
let version = 0;
export const subscribeWebhooks = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const webhooksVersion = () => version;
export const getWebhookConfig = () => config;
export const getDeliveries = (id: string) => deliveries[id] ?? [];
export const webhookServer = () => ({ port: serverPort, error: serverError });
const emit = () => { version++; listeners.forEach((fn) => fn()); };

let synced = "";
/** Starts, updates or stops the server when the set of active hooks (or the port) changed. */
async function sync(force = false) {
  const hooks = activeHooks(config, getScheduled());
  const key = JSON.stringify([config.port, hooks]);
  if (!force && key === synced) return;
  synced = key;
  try {
    if (hooks.length) { serverPort = await invoke<number>("webhook_serve", { port: config.port, hooks }); serverError = ""; }
    else if (serverPort !== null) { await invoke("webhook_stop"); serverPort = null; }
  } catch (e) { serverPort = null; serverError = String(e); }
  emit();
}

function save(next: WebhookConfig) {
  config = next;
  void setSetting("webhooks", config).catch(() => {});
  void sync();
  emit();
}

export function setHook(id: string, enabled: boolean) {
  const h = config.hooks[id] ?? { secret: newSecret(), enabled: false };
  save({ ...config, hooks: { ...config.hooks, [id]: { ...h, enabled } } });
}
export const rotateSecret = (id: string) => save({ ...config, hooks: { ...config.hooks, [id]: { secret: newSecret(), enabled: config.hooks[id]?.enabled ?? false } } });
export const setWebhookPort = (port: number) => save(parseWebhookConfig({ ...config, port }));

/** A delivery from the server: recorded; a signed one starts its schedule (only a switched-on schedule, never twice at once). */
export function onDelivery(d: Delivery) {
  const sc = getScheduled().find((s) => s.id === d.id);
  let outcome: DeliveryRecord["outcome"] = "rejected";
  if (d.status === 202) {
    const runner = getRunner();
    outcome = !sc?.enabled || !config.hooks[d.id]?.enabled || !runner ? "off" : runner.runNow(d.id, webhookPrompt(sc.prompt, d)) ? "started" : "running";
  }
  deliveries = { ...deliveries, [d.id]: addDelivery(deliveries[d.id] ?? [], { ...d, outcome }) };
  emit();
}

/** Loads the config, listens for deliveries and keeps the server in step with the schedules; returns the cleanup. */
export function startWebhooks() {
  let stopped = false;
  let unlisten: (() => void) | undefined;
  void getSetting<unknown>("webhooks", null).then((v) => { if (!stopped) { config = parseWebhookConfig(v); void sync(true); } });
  void listen<Delivery>("webhook-delivery", (e) => onDelivery(e.payload)).then((u) => (stopped ? u() : (unlisten = u)));
  const unsub = subscribeScheduled(() => void sync());
  return () => {
    stopped = true;
    unlisten?.();
    unsub();
    if (serverPort !== null) void invoke("webhook_stop").catch(() => {});
    serverPort = null;
    synced = "";
  };
}
