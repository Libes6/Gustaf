import { Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "./database/database.service.js";
import { device, session } from "./database/tables.schema.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Missing and foreign rows look the same, so ids of other users' resources do not leak.
export function ownedOrNotFound<T extends { userId: string }>(userId: string, row: T | undefined) {
  if (!row || row.userId !== userId) throw new NotFoundException();
  return row;
}

// The single place that loads a user-owned resource by id.
@Injectable()
export class OwnershipService {
  constructor(private readonly database: DatabaseService) {}

  async device(userId: string, deviceId: string) {
    if (!UUID.test(deviceId)) throw new NotFoundException();
    const [row] = await this.database.db.select().from(device).where(eq(device.id, deviceId));
    return ownedOrNotFound(userId, row);
  }

  async session(userId: string, sessionId: string) {
    const [row] = await this.database.db.select().from(session).where(eq(session.id, sessionId));
    return ownedOrNotFound(userId, row);
  }
}
