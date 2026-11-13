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
