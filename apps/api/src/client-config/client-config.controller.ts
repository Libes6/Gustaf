import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import type * as NodeHttp from "node:http";
import { AdminGuard } from "../admin/admin.guard.js";
import { AUTH, type Auth } from "../auth/auth.js";
import { CurrentSession, type UserSession } from "../auth/session.guard.js";
import { readDeviceToken } from "../devices/device-token.js";
import { DevicesService } from "../devices/devices.service.js";
import {
  readAnnouncementInput,
  readClientKind,
  readClientQuery,
  readFlagInput,
  readFlagKey,
  readMinimumVersionInput,
} from "./client-config-rules.js";
import { ClientConfigService } from "./client-config.service.js";

// Public: answers signed-out clients too. A session or device credential only adds per-user
// flags; a missing, expired or revoked one is ignored rather than rejected.
@Controller("v1/client-config")
export class ClientConfigController {
  constructor(
    private readonly config: ClientConfigService,
    @Optional() @Inject(AUTH) private readonly auth?: Pick<Auth, "api">,
    @Optional() private readonly devices?: DevicesService,
  ) {}

  @Get()
  async get(
    @Query() query: { kind?: unknown; version?: unknown },
    @Headers() headers: NodeHttp.IncomingHttpHeaders,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): void },
  ) {
    const client = readClientQuery(query);
    const credentialed = Boolean(headers.authorization || headers.cookie);
    const login =
      credentialed && (await this.config.hasListedFlags()) ? await this.callerLogin(headers) : null;
    response.setHeader("cache-control", `${credentialed ? "private" : "public"}, max-age=300`);
    response.setHeader("vary", "Authorization, Cookie");
    return this.config.resolve(client, login);
  }

  private async callerLogin(headers: NodeHttp.IncomingHttpHeaders) {
    const deviceToken = readDeviceToken(headers.authorization);
    const userId = deviceToken
      ? (await this.devices?.authenticate(deviceToken))?.userId
      : (await this.auth?.api.getSession({ headers: fromNodeHeaders(headers) }))?.user.id;
    return userId ? this.config.githubLogin(userId) : null;
  }
}

@Controller("v1/admin")
@UseGuards(AdminGuard)
export class AdminClientConfigController {
  constructor(private readonly config: ClientConfigService) {}

  @Get("announcements")
  announcements() {
    return this.config.listAnnouncements();
  }

  @Post("announcements")
  createAnnouncement(@CurrentSession() { user }: UserSession, @Body() body: unknown) {
    return this.config.createAnnouncement(user.id, readAnnouncementInput(body));
  }

  @Patch("announcements/:id")
  updateAnnouncement(
    @CurrentSession() { user }: UserSession,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.config.updateAnnouncement(user.id, id, readAnnouncementInput(body));
  }

  @Delete("announcements/:id")
  @HttpCode(204)
  async deleteAnnouncement(@CurrentSession() { user }: UserSession, @Param("id") id: string) {
    await this.config.deleteAnnouncement(user.id, id);
  }

  @Get("minimum-versions")
  minimumVersions() {
    return this.config.listMinimumVersions();
  }

  @Patch("minimum-versions/:kind")
  setMinimumVersion(
    @CurrentSession() { user }: UserSession,
    @Param("kind") kind: string,
    @Body() body: unknown,
  ) {
    return this.config.setMinimumVersion(
      user.id,
      readClientKind(kind),
      readMinimumVersionInput(body),
    );
  }

  @Delete("minimum-versions/:kind")
  @HttpCode(204)
  async clearMinimumVersion(@CurrentSession() { user }: UserSession, @Param("kind") kind: string) {
    await this.config.clearMinimumVersion(user.id, readClientKind(kind));
  }

  @Get("feature-flags")
  flags() {
    return this.config.listFlags();
  }

  @Post("feature-flags")
  createFlag(@CurrentSession() { user }: UserSession, @Body() body: unknown) {
    const key = readFlagKey((body as { key?: unknown } | null)?.key);
    return this.config.createFlag(user.id, key, readFlagInput(body));
  }

  @Patch("feature-flags/:key")
  updateFlag(
    @CurrentSession() { user }: UserSession,
    @Param("key") key: string,
    @Body() body: unknown,
  ) {
    return this.config.updateFlag(user.id, readFlagKey(key), readFlagInput(body));
  }

  @Delete("feature-flags/:key")
  @HttpCode(204)
  async deleteFlag(@CurrentSession() { user }: UserSession, @Param("key") key: string) {
    await this.config.deleteFlag(user.id, readFlagKey(key));
  }
}
