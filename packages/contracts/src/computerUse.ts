/**
 * Computer use: agents seeing and driving a whole Mac through the Gustaf shell's executor.
 * The shell speaks this over the socket it gives its own server
 * (apps/shell/src-tauri/src/computer_use/channel.rs); the server service, RPC and MCP reuse it.
 * See docs/internals/computer-use.md.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ComputerUseRect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});
export type ComputerUseRect = typeof ComputerUseRect.Type;

export const ComputerUseDisplay = Schema.Struct({
  id: NonNegativeInt,
  name: Schema.String,
  main: Schema.Boolean,
  /** Global display points: origin at the main display's top left, y down, negative allowed. */
  bounds: ComputerUseRect,
  /** Pixels per point, 2 on Retina. */
  scale: Schema.Finite,
});
export type ComputerUseDisplay = typeof ComputerUseDisplay.Type;

export const ComputerUsePermissions = Schema.Struct({
  screenRecording: Schema.Boolean,
  accessibility: Schema.Boolean,
});
export type ComputerUsePermissions = typeof ComputerUsePermissions.Type;

export const ComputerUsePermission = Schema.Literals(["screen-recording", "accessibility"]);
export type ComputerUsePermission = typeof ComputerUsePermission.Type;

export const ComputerUseOwner = Schema.Struct({
  environmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  threadId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** Shown in the Mac's menu-bar indicator, such as the thread title. The shell cuts it to 80. */
  label: Schema.String,
});
export type ComputerUseOwner = typeof ComputerUseOwner.Type;

export const ComputerUseAvailability = Schema.Literals([
  /** Not macOS, or an environment without the shell's executor. */
  "unsupported",
  "disabled",
  "permissions-required",
  "ready",
  "active",
]);
export type ComputerUseAvailability = typeof ComputerUseAvailability.Type;

export const ComputerUseEndReason = Schema.Literals([
  "stopped-by-user",
  "emergency-shortcut",
  "stopped-by-owner",
  "connection-lost",
  "permission-revoked",
  "disabled",
  "app-quit",
]);
export type ComputerUseEndReason = typeof ComputerUseEndReason.Type;

export const ComputerUseStatus = Schema.Struct({
  availability: ComputerUseAvailability,
  /**
   * Present only while the feature is on; the shell does not probe macOS before that. Absent
   * while on means the check itself failed, not that permissions are missing.
   */
  permissions: Schema.optional(ComputerUsePermissions),
  owner: Schema.optional(ComputerUseOwner),
  lastEndReason: Schema.optional(ComputerUseEndReason),
  emergencyShortcut: Schema.String,
});
export type ComputerUseStatus = typeof ComputerUseStatus.Type;

export const ComputerUseScreenState = Schema.Literals([
  "available",
  "locked",
  /** A secure field, such as a password prompt, has the keyboard: typing is refused. */
  "secure-input",
  /** A system dialog macOS does not let synthetic events reach. */
  "system-dialog",
]);
export type ComputerUseScreenState = typeof ComputerUseScreenState.Type;

export const ComputerUseFrontApp = Schema.Struct({
  name: Schema.String,
  bundleId: Schema.String,
  pid: Schema.Int,
});
export type ComputerUseFrontApp = typeof ComputerUseFrontApp.Type;

export const ComputerUseContext = Schema.Struct({
  screen: ComputerUseScreenState,
  app: Schema.optional(ComputerUseFrontApp),
  windowTitle: Schema.optional(Schema.String),
});
export type ComputerUseContext = typeof ComputerUseContext.Type;

/** What a screenshot's pixels are tied to. Actions address pixels of a capture by its id. */
export const ComputerUseCaptureGeometry = Schema.Struct({
  captureId: TrimmedNonEmptyString,
  displayId: NonNegativeInt,
  bounds: ComputerUseRect,
  scale: Schema.Finite,
  width: PositiveInt,
  height: PositiveInt,
});
export type ComputerUseCaptureGeometry = typeof ComputerUseCaptureGeometry.Type;

/** As the shell sends it: the PNG inline, base64. Never log `data`. */
export const ComputerUseExecutorScreenshot = Schema.Struct({
  ...ComputerUseCaptureGeometry.fields,
  mimeType: Schema.Literal("image/png"),
  data: Schema.String,
});
export type ComputerUseExecutorScreenshot = typeof ComputerUseExecutorScreenshot.Type;

export const ComputerUseImagePoint = Schema.Struct({
  captureId: TrimmedNonEmptyString,
  x: Schema.Finite,
  y: Schema.Finite,
});
export type ComputerUseImagePoint = typeof ComputerUseImagePoint.Type;

export const ComputerUseButton = Schema.Literals(["left", "right", "middle"]);
export type ComputerUseButton = typeof ComputerUseButton.Type;

/** The shell checks bounds again; these limits only fail early. */
export const ComputerUseAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("move"), at: ComputerUseImagePoint }),
  Schema.Struct({
    type: Schema.Literal("click"),
    at: ComputerUseImagePoint,
    button: Schema.optional(ComputerUseButton),
    count: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
  }),
  Schema.Struct({
    type: Schema.Literal("drag"),
    from: ComputerUseImagePoint,
    to: ComputerUseImagePoint,
    button: Schema.optional(ComputerUseButton),
  }),
  Schema.Struct({
    type: Schema.Literal("scroll"),
    at: ComputerUseImagePoint,
    deltaX: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 }))),
    deltaY: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 }))),
  }),
  Schema.Struct({
    type: Schema.Literal("type"),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    /** Modifiers plus one key, such as ["command", "s"]. Letters name keys of the ANSI layout. */
    keys: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
    repeat: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  Schema.Struct({
    type: Schema.Literal("activate"),
    /** An app name such as TextEdit, or a bundle id such as com.apple.TextEdit. */
    app: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  }),
]);
export type ComputerUseAction = typeof ComputerUseAction.Type;

export const ComputerUseErrorCode = Schema.Literals([
  "unauthorized",
  "invalid-request",
  "unsupported",
  "disabled",
  "declined",
  "permission-required",
  "busy",
  "no-session",
  "cancelled",
  "screen-locked",
  "secure-input",
  "system-dialog",
  "stale-capture",
  "out-of-bounds",
  "invalid-action",
  "emergency-stop-unavailable",
  "failed",
  /** Server only: the user has not allowed computer use in the calling thread. */
  "not-allowed",
  /** Server only: the calling provider does not show tool images to its model. */
  "provider-unsupported",
]);
export type ComputerUseErrorCode = typeof ComputerUseErrorCode.Type;

export class ComputerUseError extends Schema.TaggedError<ComputerUseError>()("ComputerUseError", {
  code: ComputerUseErrorCode,
  /** English, written for the agent; never carries captured pixels or typed text. */
  message: Schema.String,
}) {}

/** Requests the server sends. Each line also carries `id` and the launch `token`. */
export const ComputerUseExecutorRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("status") }),
  /** Turning on shows a native dialog on the Mac; only a person there can answer it. */
  Schema.Struct({ op: Schema.Literal("set-enabled"), enabled: Schema.Boolean }),
  Schema.Struct({
    op: Schema.Literal("open-permission-settings"),
    permission: ComputerUsePermission,
  }),
  Schema.Struct({ op: Schema.Literal("start"), owner: ComputerUseOwner }),
  /** Without a session token, stops whatever session runs: stopping is always allowed. */
  Schema.Struct({ op: Schema.Literal("stop"), sessionToken: Schema.optional(Schema.String) }),
  Schema.Struct({ op: Schema.Literal("displays"), sessionToken: Schema.String }),
  Schema.Struct({ op: Schema.Literal("context"), sessionToken: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("screenshot"),
    sessionToken: Schema.String,
    displayId: Schema.optional(NonNegativeInt),
    maxWidth: Schema.optional(PositiveInt),
    maxHeight: Schema.optional(PositiveInt),
  }),
  Schema.Struct({
    op: Schema.Literal("act"),
    sessionToken: Schema.String,
    action: ComputerUseAction,
  }),
]);
export type ComputerUseExecutorRequest = typeof ComputerUseExecutorRequest.Type;

export const ComputerUseExecutorReply = Schema.Union([
  Schema.Struct({ id: Schema.Number, ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({
    id: Schema.NullOr(Schema.Number),
    ok: Schema.Literal(false),
    error: Schema.Struct({ code: ComputerUseErrorCode, message: Schema.String }),
  }),
]);
export type ComputerUseExecutorReply = typeof ComputerUseExecutorReply.Type;

/** Sent unprompted, such as after Stop in the menu bar or the emergency shortcut. */
export const ComputerUseExecutorEvent = Schema.Struct({
  event: Schema.Literal("status"),
  status: ComputerUseStatus,
});
export type ComputerUseExecutorEvent = typeof ComputerUseExecutorEvent.Type;

/**
 * Drivers whose runtime hands an MCP tool's image content to the model: Claude Agent SDK and
 * Codex app-server pass it natively, OpenCode attaches it as files, Pi copies it into model
 * content (provider-pi rpc.ts). The others are refused: driving a screen blind is unsafe.
 */
const COMPUTER_USE_IMAGE_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "opencode",
  "pi",
]);
export const computerUseSupportsDriver = (driver: string): boolean =>
  COMPUTER_USE_IMAGE_DRIVERS.has(driver);

/** An environment without the shell's executor, such as one on a VPS. */
export const COMPUTER_USE_UNSUPPORTED_STATUS: ComputerUseStatus = {
  availability: "unsupported",
  emergencyShortcut: "",
};

export const ComputerUseSetEnabledInput = Schema.Struct({ enabled: Schema.Boolean });
export const ComputerUseOpenPermissionSettingsInput = Schema.Struct({
  permission: ComputerUsePermission,
});
export const ComputerUseAllowThreadInput = Schema.Struct({ threadId: ThreadId });
