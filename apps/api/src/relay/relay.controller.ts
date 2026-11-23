import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { DeviceGuard } from "../devices/devices.controller.js";
import { RelayService } from "./relay.service.js";

@Controller("v1/relay")
export class RelayController {
  constructor(private readonly relay: RelayService) {}

  /** This user's computers that hold a relay connection right now. */
  @Get("hosts")
  @UseGuards(DeviceGuard)
  hosts(@Req() request: { device: { userId: string } }) {
    return { online: this.relay.hub.onlineHosts(request.device.userId) };
  }
}
