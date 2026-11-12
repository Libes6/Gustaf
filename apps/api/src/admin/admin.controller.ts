import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CurrentSession, type UserSession } from "../auth/session.guard.js";
import { readBanReason, readPage, readRole, readSearch } from "./admin-rules.js";
import { AdminGuard } from "./admin.guard.js";
import { AdminService } from "./admin.service.js";

type ListQuery = { limit?: unknown; cursor?: unknown; query?: unknown; kind?: unknown };

function readKind(kind: unknown) {
  if (kind === undefined || kind === "") return undefined;
  if (kind === "computer" || kind === "phone") return kind;
  throw new BadRequestException("kind must be computer or phone");
}

@Controller("v1/admin")
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get("overview")
  overview() {
    return this.admin.overview();
  }

  @Get("users")
  users(@Query() query: ListQuery) {
    return this.admin.listUsers(readSearch(query.query), readPage(query));
  }

  @Get("users/:id")
  user(@Param("id") id: string) {
    return this.admin.getUser(id);
  }

  @Post("users/:id/ban")
  @HttpCode(204)
  async ban(
    @CurrentSession() { user }: UserSession,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    await this.admin.ban(user.id, id, readBanReason(body));
  }

  @Post("users/:id/unban")
  @HttpCode(204)
  async unban(@CurrentSession() { user }: UserSession, @Param("id") id: string) {
    await this.admin.unban(user.id, id);
  }

  @Post("users/:id/revoke-sessions")
  @HttpCode(204)
  async revokeSessions(@CurrentSession() { user }: UserSession, @Param("id") id: string) {
    await this.admin.revokeSessions(user.id, id);
  }

  @Patch("users/:id/role")
  @HttpCode(204)
  async setRole(
    @CurrentSession() { user }: UserSession,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    await this.admin.setRole(user.id, id, readRole(body));
  }

  @Delete("users/:id")
  @HttpCode(204)
  async deleteUser(@CurrentSession() { user }: UserSession, @Param("id") id: string) {
    await this.admin.deleteUser(user.id, id);
  }

  @Get("devices")
  devices(@Query() query: ListQuery) {
    return this.admin.listDevices(readSearch(query.query), readKind(query.kind), readPage(query));
  }

  @Post("devices/:id/revoke")
  @HttpCode(204)
  async revokeDevice(@CurrentSession() { user }: UserSession, @Param("id") id: string) {
    await this.admin.revokeDevice(user.id, id);
  }

  @Get("audit")
  audit(@Query() query: ListQuery) {
    return this.admin.listAudit(readPage(query));
  }
}
