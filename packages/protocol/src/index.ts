/**
 * @mcode/protocol: the wire contract between the M Code desktop app (server side, `apps/desktop/src-tauri`) and its
 * companion apps (`apps/mobile`).
 *
 * Rules: pure TypeScript only. No React, Tauri or React Native imports, no runtime dependencies (Expo pins its own React
 * version, which may differ from the desktop's). Everything below is a SKELETON of the planned API (see TASKS.md, "Mobile
 * companion app"): names and shapes will change before the first server implementation lands, and `PROTOCOL_VERSION` is
 * bumped on every incompatible change.
 *
 * Transport (planned): HTTPS requests for commands and reads, one WebSocket per paired device for server events. The
 * desktop stays the single source of truth; requests keep running on the desktop when the phone disconnects.
 */

/** Incompatible-change counter, exchanged in the pairing handshake and on every WebSocket connect. */
export const PROTOCOL_VERSION = 1;

/** Milliseconds since the Unix epoch, as the desktop database stores them. */
export type Timestamp = number;

/** Every route of the desktop server lives under this prefix (`POST /v1/pair`, `GET /v1/projects`, ...). */
export const API_BASE_PATH = "/v1";

/** `GET /v1/info` */
export interface ServerInfo {
  protocol: number;
  app: string;
  appVersion: string;
  /** Computer name shown on the phone. */
  desktopName: string;
}

// ---- Pairing ---------------------------------------------------------------------------------------------------------

/** The JSON a desktop encodes into the pairing QR code. */
export interface PairingQrPayload {
  protocol: number;
  /** LAN address of the desktop server. */
  host: string;
  port: number;
  /** One-time pairing code; expires within minutes and is single-use. */
  code: string;
  /** SHA-256 fingerprint (hex) of the desktop's self-signed TLS certificate; the phone pins it. */
  fingerprint: string;
}

/** `POST /pair`: the phone exchanges the QR code for a long-lived per-device token. */
export interface PairRequest {
  protocol: number;
  code: string;
  /** Human-readable device name shown in the desktop's device list. */
  deviceName: string;
  /** Optional small object (platform, model, app version); validated and bounded by the server, not stored. */
  publicInfo?: Record<string, unknown>;
}

export interface PairResponse {
  protocol: number;
  deviceId: string;
  /** Bearer token for every later request; revoked from the desktop's Settings. */
  token: string;
  desktopName: string;
}

// ---- Projects, chats, messages ---------------------------------------------------------------------------------------

export interface ProjectSummary {
  id: number;
  name: string;
  pinned: boolean;
}

/** What the sidebar badge of the desktop shows: `done` = finished while nobody looked at the chat. */
export type ChatRunStatus = "idle" | "running" | "waiting" | "done" | "failed";

export interface ChatSummary {
  id: number;
  projectId: number;
  title: string;
  archived: boolean;
  updatedAt: Timestamp;
  /** True while a request is running in this chat on the desktop (also while it waits for an approval). */
  running: boolean;
  /** Finer than `running`; sent by the desktop server, absent in older mocks. */
  status?: ChatRunStatus;
}

export type MessageRole = "user" | "assistant";

/** A tool call shown as a card in the chat (read, edit, command, ...). */
export interface ToolActivity {
  id: string;
  tool: string;
  /** Short human-readable summary, e.g. a file path or a command line. */
  summary: string;
  status: "running" | "done" | "error" | "denied";
}

export interface ChatMessage {
  id: number;
  chatId: number;
  role: MessageRole;
  /** Markdown. */
  text: string;
  tools: ToolActivity[];
  createdAt: Timestamp;
}

/** `POST /chats/:id/messages`: send a message and start a request on the desktop. */
export interface SendMessageRequest {
  text: string;
  /** Provider and model to use; omitted means the chat's current selection. */
  providerId?: string;
  model?: string;
}

// ---- Streaming events (server to phone, over the WebSocket) -----------------------------------------------------------

/** A tool call that waits for the user's decision (the desktop's approval prompt, mirrored on the phone). */
export interface ApprovalRequest {
  approvalId: string;
  chatId: number;
  tool: string;
  /** What would run or change, as shown in the desktop prompt. */
  summary: string;
}

export type ServerEvent =
  | { type: "hello"; protocol: number }
  | { type: "chat.updated"; chat: ChatSummary }
  | { type: "message.created"; message: ChatMessage }
  /** Streamed assistant text, appended to the running assistant message. */
  | { type: "message.delta"; chatId: number; messageId: number; text: string }
  | { type: "tool.updated"; chatId: number; messageId: number; tool: ToolActivity }
  | { type: "approval.requested"; approval: ApprovalRequest }
  | { type: "approval.resolved"; approvalId: string; decision: ApprovalDecision }
  | { type: "run.finished"; chatId: number; outcome: "done" | "stopped" | "error"; error?: string };

// ---- Commands (phone to server) -------------------------------------------------------------------------------------

export type ApprovalDecision = "allow" | "deny";

/** `POST /approvals/:id`: answer a pending approval. */
export interface ApprovalResponse {
  decision: ApprovalDecision;
}

/** `POST /chats/:id/stop`: stop the running request of a chat. No body; the result arrives as `run.finished`. */
export type StopRequest = Record<string, never>;

/** Shape of every non-2xx response body. */
export interface ApiError {
  code: "unauthorized" | "bad_request" | "not_found" | "version_mismatch" | "rate_limited" | "internal";
  message: string;
}
