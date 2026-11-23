import { BadRequestException } from "@nestjs/common";

export const CLIENT_KINDS = ["desktop", "mobile"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];
const TARGETS = ["all", "desktop", "mobile"] as const;
type Target = (typeof TARGETS)[number];
const LEVELS = ["info", "warning", "critical"] as const;
type Level = (typeof LEVELS)[number];
const FLAG_MODES = ["off", "everyone", "listed"] as const;
type FlagMode = (typeof FLAG_MODES)[number];

const VERSION =
  /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;
const FLAG_KEY = /^[a-z][a-z0-9_.-]{0,63}$/;
const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;

interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

export function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION.exec(value.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

// Semver precedence: a prerelease sorts before its release, numeric identifiers numerically.
export function compareVersions(a: string, b: string) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error("compareVersions needs two valid versions");
  for (let i = 0; i < 3; i += 1) {
    const diff = left.core[i]! - right.core[i]!;
    if (diff !== 0) return Math.sign(diff);
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i += 1) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Math.sign(Number(l) - Number(r));
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export interface AnnouncementRow {
  readonly id: string;
  readonly textEn: string;
  readonly textRu: string;
  readonly level: Level;
  readonly link: string | null;
  readonly target: Target;
  readonly minVersion: string | null;
  readonly maxVersion: string | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly active: boolean;
  readonly createdAt: Date;
}

export interface FlagRow {
  readonly key: string;
  readonly mode: FlagMode;
  readonly logins: readonly string[];
}

export interface MinimumVersionRow {
  readonly kind: ClientKind;
  readonly version: string;
  readonly message: string | null;
}

export interface ClientQuery {
  readonly kind: ClientKind;
  /** Null when the client sent none or an unparseable one. */
  readonly version: string | null;
}

export function announcementVisible(row: AnnouncementRow, client: ClientQuery, now: Date) {
  if (!row.active) return false;
  if (row.target !== "all" && row.target !== client.kind) return false;
  if (row.startsAt && row.startsAt > now) return false;
  if (row.endsAt && row.endsAt <= now) return false;
  if (row.minVersion || row.maxVersion) {
    if (!client.version) return false;
    if (row.minVersion && compareVersions(client.version, row.minVersion) < 0) return false;
    if (row.maxVersion && compareVersions(client.version, row.maxVersion) > 0) return false;
  }
  return true;
}

export function flagEnabled(flag: FlagRow, login: string | null) {
  if (flag.mode === "everyone") return true;
  if (flag.mode === "listed") return login !== null && flag.logins.includes(login.toLowerCase());
  return false;
}

const LEVEL_ORDER: Record<Level, number> = { critical: 0, warning: 1, info: 2 };

export function resolveClientConfig(
  rows: {
    readonly announcements: readonly AnnouncementRow[];
    readonly minimumVersions: readonly MinimumVersionRow[];
    readonly flags: readonly FlagRow[];
  },
  client: ClientQuery,
  login: string | null,
  now: Date,
) {
  const minimum = rows.minimumVersions.find((row) => row.kind === client.kind);
  return {
    announcements: rows.announcements
      .filter((row) => announcementVisible(row, client, now))
      .toSorted(
        (a, b) =>
          LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      )
      .map((row) => ({
        id: row.id,
        level: row.level,
        text: { en: row.textEn, ru: row.textRu },
        link: row.link,
      })),
    update: {
      required:
        minimum !== undefined &&
        client.version !== null &&
        compareVersions(client.version, minimum.version) < 0,
      minimumVersion: minimum?.version ?? null,
      message: minimum?.message ?? null,
    },
    flags: Object.fromEntries(rows.flags.map((flag) => [flag.key, flagEnabled(flag, login)])),
  };
}

export function readClientQuery(query: { kind?: unknown; version?: unknown }): ClientQuery {
  if (!CLIENT_KINDS.includes(query.kind as ClientKind)) {
    throw new BadRequestException("kind must be desktop or mobile");
  }
  // A dev build with an odd version still gets its config, just not version-gated content.
  const version =
    typeof query.version === "string" && parseVersion(query.version) ? query.version.trim() : null;
  return { kind: query.kind as ClientKind, version };
}

// Admin input. Every write sends the whole record, so create and edit share one reader.

type Body = Record<string, unknown>;
const asBody = (body: unknown): Body =>
  body && typeof body === "object" && !Array.isArray(body) ? (body as Body) : {};

function readText(body: Body, field: string, max: number) {
  const value = body[field];
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length < 1 || trimmed.length > max) {
    throw new BadRequestException(`${field} must be 1-${max} characters`);
  }
  return trimmed;
}

function readOptionalText(body: Body, field: string, max: number) {
  const value = body[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > max) {
    throw new BadRequestException(`${field} must be a string of at most ${max} characters`);
  }
  return value.trim() || null;
}

function readChoice<T extends string>(body: Body, field: string, choices: readonly T[]) {
  const value = body[field];
  if (!choices.includes(value as T)) {
    throw new BadRequestException(`${field} must be one of ${choices.join(", ")}`);
  }
  return value as T;
}

function readOptionalVersion(body: Body, field: string) {
  const value = readOptionalText(body, field, 100);
  if (value !== null && !parseVersion(value)) {
    throw new BadRequestException(`${field} must be a version like 1.2.3`);
  }
  return value;
}

function readOptionalDate(body: Body, field: string) {
  const value = body[field];
  if (value === undefined || value === null || value === "") return null;
  const date = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${field} must be a date`);
  return date;
}

export function readAnnouncementInput(raw: unknown) {
  const body = asBody(raw);
  const link = readOptionalText(body, "link", 500);
  if (link !== null && !/^https:\/\/[^\s]+$/i.test(link)) {
    throw new BadRequestException("link must be an https:// URL");
  }
  const minVersion = readOptionalVersion(body, "minVersion");
  const maxVersion = readOptionalVersion(body, "maxVersion");
  if (minVersion && maxVersion && compareVersions(minVersion, maxVersion) > 0) {
    throw new BadRequestException("minVersion must not be above maxVersion");
  }
  const startsAt = readOptionalDate(body, "startsAt");
  const endsAt = readOptionalDate(body, "endsAt");
  if (startsAt && endsAt && startsAt >= endsAt) {
    throw new BadRequestException("startsAt must be before endsAt");
  }
  if (typeof body.active !== "boolean") throw new BadRequestException("active must be a boolean");
  return {
    textEn: readText(body, "textEn", 1000),
    textRu: readText(body, "textRu", 1000),
    level: readChoice(body, "level", LEVELS),
    link,
    target: readChoice(body, "target", TARGETS),
    minVersion,
    maxVersion,
    startsAt,
    endsAt,
    active: body.active,
  };
}

export function readClientKind(kind: string): ClientKind {
  if (!CLIENT_KINDS.includes(kind as ClientKind)) {
    throw new BadRequestException("kind must be desktop or mobile");
  }
  return kind as ClientKind;
}

export function readMinimumVersionInput(raw: unknown) {
  const body = asBody(raw);
  const version = readText(body, "version", 100);
  if (!parseVersion(version)) throw new BadRequestException("version must be like 1.2.3");
  return { version, message: readOptionalText(body, "message", 500) };
}

export function readFlagKey(key: unknown) {
  if (typeof key !== "string" || !FLAG_KEY.test(key)) {
    throw new BadRequestException(
      "key must start with a letter and use only a-z, 0-9, _, . and - (at most 64)",
    );
  }
  return key;
}

export function readFlagInput(raw: unknown) {
  const body = asBody(raw);
  const logins = body.logins ?? [];
  if (!Array.isArray(logins) || logins.length > 500) {
    throw new BadRequestException("logins must be a list of at most 500 GitHub logins");
  }
  const normalized = new Set<string>();
  for (const entry of logins) {
    const login = typeof entry === "string" ? entry.trim().replace(/^@/, "").toLowerCase() : "";
    if (!login) continue;
    if (!GITHUB_LOGIN.test(login)) {
      throw new BadRequestException(`"${String(entry)}" is not a GitHub login`);
    }
    normalized.add(login);
  }
  return {
    description: readOptionalText(body, "description", 500) ?? "",
    mode: readChoice(body, "mode", FLAG_MODES),
    logins: [...normalized].toSorted(),
  };
}
