import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";
import { type BeforeApplicationShutdown, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { DatabaseService } from "../database/database.service.js";
import { relayDaily } from "../database/tables.schema.js";
import type { DevicesService } from "../devices/devices.service.js";
import { DEFAULT_RELAY_LIMITS, RelayHub } from "./relay.hub.js";
import { RelayDaily } from "./relay.daily.js";
import { RelayUsage } from "./relay.usage.js";

@Injectable()
export class RelayService implements BeforeApplicationShutdown {
  private readonly logger = new Logger("Relay");
  private readonly usage: RelayUsage;
  private readonly daily: RelayDaily;
  readonly hub: RelayHub;

  constructor(
    database: DatabaseService,
    devices: DevicesService,
    readonly monthlyBytes: number,
    trustProxy: number | boolean | string,
  ) {
    this.usage = new RelayUsage(database, monthlyBytes);
    this.daily = new RelayDaily(async (rows) => {
      await database.db
        .insert(relayDaily)
        .values(rows)
        .onConflictDoUpdate({
          target: [relayDaily.day, relayDaily.metric],
          set: { value: sql`${relayDaily.value} + excluded.value` },
        });
    });
    this.hub = new RelayHub(
      {
        authenticate: async (token) => {
          const device = await devices.authenticate(token);
          if (!device) return undefined;
          await this.usage.load(device.userId);
          return { id: device.id, userId: device.userId, kind: device.kind };
        },
        stillUsable: (ids) => devices.stillUsable(ids),
        mayOpen: (userId) => this.usage.mayOpen(userId),
        countBytes: (userId, bytes) => {
          this.usage.count(userId, bytes);
          this.daily.add("bytes", bytes);
        },
        record: (event) => this.daily.add(event),
        log: (event) => this.logger.log(event),
      },
      DEFAULT_RELAY_LIMITS,
      // Coolify's Traefik is one hop; a non-numeric setting falls back to the socket address.
      typeof trustProxy === "number" ? trustProxy : trustProxy === true ? 1 : 0,
    );
  }

  readonly upgrade = (
    request: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    head: Buffer,
  ) => {
    if (!this.hub.handleUpgrade(request, socket, head)) socket.destroy();
  };

  /** Writes pending counts so a read of `relay_usage` and `relay_daily` is current. */
  async flush() {
    await Promise.all([this.usage.flush(), this.daily.flush()]);
  }

  async beforeApplicationShutdown() {
    this.hub.close();
    await Promise.all([this.usage.close(), this.daily.close()]);
  }
}
