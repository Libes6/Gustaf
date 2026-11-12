import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";
import { type BeforeApplicationShutdown, Injectable, Logger } from "@nestjs/common";
import type { DatabaseService } from "../database/database.service.js";
import type { DevicesService } from "../devices/devices.service.js";
import { RelayHub } from "./relay.hub.js";
import { RelayUsage } from "./relay.usage.js";

@Injectable()
export class RelayService implements BeforeApplicationShutdown {
  private readonly logger = new Logger("Relay");
  private readonly usage: RelayUsage;
  readonly hub: RelayHub;

  constructor(database: DatabaseService, devices: DevicesService, monthlyBytes: number) {
    this.usage = new RelayUsage(database, monthlyBytes);
    this.hub = new RelayHub({
      authenticate: async (token) => {
        const device = await devices.authenticate(token);
        if (!device) return undefined;
        await this.usage.load(device.userId);
        return { id: device.id, userId: device.userId, kind: device.kind };
      },
      stillUsable: (ids) => devices.stillUsable(ids),
      mayOpen: (userId) => this.usage.mayOpen(userId),
      countBytes: (userId, bytes) => this.usage.count(userId, bytes),
      log: (event) => this.logger.log(event),
    });
  }

  readonly upgrade = (
    request: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    head: Buffer,
  ) => {
    if (!this.hub.handleUpgrade(request, socket, head)) socket.destroy();
  };

  async beforeApplicationShutdown() {
    this.hub.close();
    await this.usage.close();
  }
}
