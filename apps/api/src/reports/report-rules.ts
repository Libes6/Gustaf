import { BadRequestException } from "@nestjs/common";

export const REPORT_CLIENTS = ["desktop", "mobile"] as const;
export const REPORT_STATUSES = ["new", "seen", "closed"] as const;
export type ReportClient = (typeof REPORT_CLIENTS)[number];
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_LIMITS = {
  message: 5000,
  // Clients send at most ~200 KB of log tail; the JSON body limit leaves room for it.
  logs: 200_000,
  appVersion: 64,
  platform: 100,
  note: 2000,
};

// Per user, counted from stored rows so it holds across API instances.
export const REPORT_RATE_LIMIT = { reports: 10, windowMs: 60 * 60 * 1000 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(
  body: Record<string, unknown>,
  field: string,
  max: number,
  { required }: { required: boolean },
) {
  const value = body[field];
  if (value === undefined || value === null) {
    if (required) throw new BadRequestException(`${field} is required`);
    return null;
  }
  if (typeof value !== "string" || value.length > max) {
    throw new BadRequestException(`${field} must be a string of at most ${max} characters`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new BadRequestException(`${field} is required`);
  return trimmed || null;
}

export function readReportInput(body: unknown) {
  const input = (body ?? {}) as Record<string, unknown>;
  const client = input.client;
  if (!REPORT_CLIENTS.includes(client as ReportClient)) {
    throw new BadRequestException("client must be desktop or mobile");
  }
  const deviceId = input.deviceId;
  if (
    deviceId !== undefined &&
    deviceId !== null &&
    (typeof deviceId !== "string" || !UUID.test(deviceId))
  ) {
    throw new BadRequestException("deviceId must be a device id");
  }
  return {
    client: client as ReportClient,
    message: text(input, "message", REPORT_LIMITS.message, { required: true })!,
    appVersion: text(input, "appVersion", REPORT_LIMITS.appVersion, { required: true })!,
    platform: text(input, "platform", REPORT_LIMITS.platform, { required: true })!,
    logs: text(input, "logs", REPORT_LIMITS.logs, { required: false }),
    deviceId: typeof deviceId === "string" ? deviceId.toLowerCase() : null,
  };
}

export function readReportStatus(value: unknown) {
  if (value === undefined || value === "") return undefined;
  if (!REPORT_STATUSES.includes(value as ReportStatus)) {
    throw new BadRequestException("status must be new, seen or closed");
  }
  return value as ReportStatus;
}

export function readReportUpdate(body: unknown) {
  const input = (body ?? {}) as Record<string, unknown>;
  const status = input.status === undefined ? undefined : readReportStatus(input.status);
  if (input.status !== undefined && status === undefined) {
    throw new BadRequestException("status must be new, seen or closed");
  }
  const note =
    input.note === undefined
      ? undefined
      : text(input, "note", REPORT_LIMITS.note, { required: false });
  if (status === undefined && note === undefined) {
    throw new BadRequestException("status or note is required");
  }
  return { status, note };
}

export function isReportId(id: string) {
  return UUID.test(id);
}
