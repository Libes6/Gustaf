import { invoke } from "@tauri-apps/api/core";

// Commands of src-tauri/src/mobile_server.rs (the phone companion server; see docs/features/mobile-server.md).

export type MobileStatus = {
  /** The saved switch: the server starts together with the app while it is on. */
  enabled: boolean;
  running: boolean;
  host: string | null;
  port: number | null;
  savedPort: number;
  /** SHA-256 of the server certificate, lowercase hex (what the QR pins). */
  fingerprint: string | null;
  protocol: number;
  devices: number;
  pairing: { code: string; expiresAt: number } | null;
  error: string | null;
};
export type MobileDevice = { id: string; name: string; createdAt: number; lastSeenAt: number | null };
/** Idle chats are left out of reports. */
export type MobileChatStatus = "running" | "waiting" | "failed" | "done";

export const mobileServer = {
  status: () => invoke<MobileStatus>("mobile_server_status"),
  /** `port`: omitted = the remembered one, 0 = a new random one, n = exactly n. */
  start: (port?: number) => invoke<MobileStatus>("mobile_server_start", { port: port ?? null }),
  stop: () => invoke<MobileStatus>("mobile_server_stop"),
  pairingStart: () => invoke<MobileStatus>("mobile_pairing_start"),
  pairingCancel: () => invoke<MobileStatus>("mobile_pairing_cancel"),
  devices: () => invoke<MobileDevice[]>("mobile_devices"),
  revoke: (id: string) => invoke<boolean>("mobile_device_revoke", { id }),
  /** The webview owns run state; the server only learns it from this report (replaces the previous one). */
  reportStatus: (statuses: { chatId: number; status: MobileChatStatus }[]) => invoke<void>("mobile_report_status", { statuses }),
};
