import { Controller, Get, UseGuards } from "@nestjs/common";
import { AdminGuard } from "./admin.guard.js";
import { OpsService } from "./ops.service.js";

@Controller("v1/admin")
@UseGuards(AdminGuard)
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get("relay")
  relay() {
    return this.ops.relayHealth();
  }

  @Get("system")
  system() {
    return this.ops.system();
  }

  @Get("releases")
  releases() {
    return this.ops.releases();
  }
}
