import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { DeviceGuard } from "../devices/devices.controller.js";
import { DevicesService } from "../devices/devices.service.js";
import { RelayService } from "./relay.service.js";

@Controller("v1/relay")
export class RelayController {
  constructor(
    private readonly relay: RelayService,
    private readonly devices: DevicesService,
  ) {}

  /**
   * This user's computers: `online` holds the ids that have a relay connection right now (what
   * older clients read), and `computers` names every computer on the account, so a computer can
   * offer the others as machines to link without the account's sign-in. Phones are not listed:
   * only a computer can be a host.
   */
  @Get("hosts")
  @UseGuards(DeviceGuard)
  async hosts(@Req() request: { device: { userId: string } }) {
    const online = this.relay.hub.onlineHosts(request.device.userId);
    const computers = (await this.devices.list(request.device.userId))
      .filter((device) => device.kind === "computer")
      .map((device) => ({
        id: device.id,
        name: device.name,
        online: online.includes(device.id),
      }));
    return { online, computers };
  }
}
