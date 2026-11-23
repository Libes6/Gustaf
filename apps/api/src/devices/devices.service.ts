import { BadRequestException, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import { device, user } from "../database/tables.schema.js";
import { OwnershipService } from "../ownership.js";
import { createDeviceToken, hashDeviceToken } from "./device-token.js";

type Device = typeof device.$inferSelect;
const KINDS = new Set<string>(device.kind.enumValues);
const LAST_SEEN_RESOLUTION = sql`interval '1 minute'`;

// Credentials of devices revoked by an admin or owned by a banned user do not authenticate.
const usable = (tokenHash: string) =>
  and(
    eq(device.tokenHash, tokenHash),
    isNull(device.revokedAt),
    notExists(sql`(select 1 from ${user} where ${user.id} = ${device.userId} and ${user.banned})`),
  );

export function presentDevice(row: Device) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    createdAt: row.createdAt,
    tokenRotatedAt: row.tokenRotatedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

const DESKTOP_PLATFORM = /^(macos|windows|linux)-(arm64|x64)$/;
const PHONE_PLATFORMS = new Set(["android", "ios"]);
const APP_VERSION = /^[0-9][0-9A-Za-z.+-]{0,31}$/;
const OS_VERSION = /^[\x20-\x7e]{1,64}$/;

// The app reports only its build and platform: never names, paths or anything the user typed.
export function readHeartbeat(kind: Device["kind"], body: unknown) {
  const { appVersion, platform, osVersion } = (body ?? {}) as Record<string, unknown>;
  if (typeof appVersion !== "string" || !APP_VERSION.test(appVersion)) {
    throw new BadRequestException("appVersion must be a version of at most 32 characters");
  }
  const validPlatform =
    typeof platform === "string" &&
    (kind === "computer" ? DESKTOP_PLATFORM.test(platform) : PHONE_PLATFORMS.has(platform));
  if (!validPlatform) {
    throw new BadRequestException(
      kind === "computer"
        ? "platform must be macos, windows or linux with arm64 or x64, like macos-arm64"
        : "platform must be android or ios",
    );
  }
  const trimmedOs = typeof osVersion === "string" ? osVersion.trim() : "";
  if (osVersion !== undefined && osVersion !== null && !OS_VERSION.test(trimmedOs)) {
    throw new BadRequestException("osVersion must be at most 64 printable characters");
  }
  return { appVersion, platform: platform as string, osVersion: trimmedOs || null };
}

export function readDeviceInput(body: unknown) {
  const { name, kind } = (body ?? {}) as Record<string, unknown>;
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new BadRequestException("name must be 1-100 characters");
  }
  if (typeof kind !== "string" || !KINDS.has(kind)) {
    throw new BadRequestException("kind must be computer or phone");
  }
  return { name: trimmed, kind: kind as Device["kind"] };
}

@Injectable()
export class DevicesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly ownership: OwnershipService,
  ) {}

  async list(userId: string) {
    const rows = await this.database.db
      .select()
      .from(device)
      .where(and(eq(device.userId, userId), isNull(device.revokedAt)))
      .orderBy(asc(device.createdAt));
    return rows.map(presentDevice);
  }

  async register(userId: string, input: ReturnType<typeof readDeviceInput>) {
    const { token, hash } = createDeviceToken();
    const [row] = await this.database.db
      .insert(device)
      .values({ userId, ...input, tokenHash: hash })
      .returning();
    return { device: presentDevice(row!), token };
  }

  async rotateToken(userId: string, deviceId: string) {
    await this.ownership.device(userId, deviceId);
    const { token, hash } = createDeviceToken();
    const [row] = await this.database.db
      .update(device)
      .set({ tokenHash: hash, tokenRotatedAt: new Date() })
      .where(and(eq(device.id, deviceId), eq(device.userId, userId)))
      .returning();
    return { device: presentDevice(row!), token };
  }

  async revoke(userId: string, deviceId: string) {
    await this.ownership.device(userId, deviceId);
    await this.database.db
      .delete(device)
      .where(and(eq(device.id, deviceId), eq(device.userId, userId)));
  }

  async heartbeat(deviceId: string, input: ReturnType<typeof readHeartbeat>) {
    await this.database.db.update(device).set(input).where(eq(device.id, deviceId));
  }

  async stillUsable(deviceIds: ReadonlyArray<string>) {
    if (deviceIds.length === 0) return new Set<string>();
    const rows = await this.database.db
      .select({ id: device.id })
      .from(device)
      .where(
        and(
          inArray(device.id, [...deviceIds]),
          isNull(device.revokedAt),
          notExists(
            sql`(select 1 from ${user} where ${user.id} = ${device.userId} and ${user.banned})`,
          ),
        ),
      );
    return new Set(rows.map((row) => row.id));
  }

  // Resolves a device credential; last_seen_at is written at most once a minute per device.
  async authenticate(token: string) {
    const tokenHash = hashDeviceToken(token);
    const [touched] = await this.database.db
      .update(device)
      .set({ lastSeenAt: sql`now()` })
      .where(
        and(
          usable(tokenHash),
          or(
            isNull(device.lastSeenAt),
            lt(device.lastSeenAt, sql`now() - ${LAST_SEEN_RESOLUTION}`),
          ),
        ),
      )
      .returning();
    if (touched) return touched;
    const [row] = await this.database.db.select().from(device).where(usable(tokenHash));
    return row;
  }
}
