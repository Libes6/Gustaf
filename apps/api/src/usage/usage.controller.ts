import { Body, Controller, ForbiddenException, HttpCode, Post, UseGuards } from "@nestjs/common";
import { CurrentDevice, DeviceGuard } from "../devices/devices.controller.js";
import { readUsageReport } from "./usage-rules.js";
import { UsageService } from "./usage.service.js";

@Controller("v1/usage")
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  // A computer reports the AI usage it counted; phones only drive a computer.
  @Post("reports")
  @HttpCode(200)
  @UseGuards(DeviceGuard)
  report(
    @CurrentDevice() device: { id: string; userId: string; kind: string },
    @Body() body: unknown,
  ) {
    if (device.kind !== "computer") throw new ForbiddenException("Only computers report usage");
    return this.usage.record({ deviceId: device.id, userId: device.userId }, readUsageReport(body));
  }
}
