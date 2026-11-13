import {
  Body,
  type CanActivate,
  Controller,
  createParamDecorator,
  Delete,
  type ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { CurrentSession, SessionGuard, type UserSession } from "../auth/session.guard.js";
import { readDeviceToken } from "./device-token.js";
import { DevicesService, presentDevice, readDeviceInput } from "./devices.service.js";

type AuthenticatedDevice = NonNullable<Awaited<ReturnType<DevicesService["authenticate"]>>>;

interface DeviceRequest {
  headers: { authorization?: string };
  device?: AuthenticatedDevice;
}

// Authenticates a computer or phone by its own device token (`Authorization: Bearer gdt_…`).
@Injectable()
export class DeviceGuard implements CanActivate {
  constructor(private readonly devices: DevicesService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<DeviceRequest>();
    const token = readDeviceToken(request.headers.authorization);
    const device = token ? await this.devices.authenticate(token) : undefined;
    if (!device) throw new UnauthorizedException();
    request.device = device;
    return true;
  }
}

export const CurrentDevice = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<DeviceRequest>().device!,
);

@Controller("v1/devices")
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get("self")
  @UseGuards(DeviceGuard)
  self(@CurrentDevice() device: AuthenticatedDevice) {
    return { device: presentDevice(device) };
  }

  @Get()
  @UseGuards(SessionGuard)
  async list(@CurrentSession() { user }: UserSession) {
    return { devices: await this.devices.list(user.id) };
  }

  @Post()
  @UseGuards(SessionGuard)
  register(@CurrentSession() { user }: UserSession, @Body() body: unknown) {
    return this.devices.register(user.id, readDeviceInput(body));
  }

  @Post(":id/token")
  @HttpCode(200)
  @UseGuards(SessionGuard)
  rotateToken(@CurrentSession() { user }: UserSession, @Param("id") id: string) {
    return this.devices.rotateToken(user.id, id);
  }

  @Delete(":id")
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async revoke(@CurrentSession() { user }: UserSession, @Param("id") id: string) {
    await this.devices.revoke(user.id, id);
  }
}
