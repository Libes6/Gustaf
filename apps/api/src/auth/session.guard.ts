import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import type * as NodeHttp from "node:http";
import { AUTH, type Auth } from "./auth.js";

export type UserSession = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

interface SessionRequest {
  headers: NodeHttp.IncomingHttpHeaders;
  userSession?: UserSession;
}

// Resolves a cookie or bearer session through Better Auth; device tokens are never user sessions.
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const userSession = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    // Banning deletes the sessions; this covers a ban written while a request was in flight.
    if (!userSession || userSession.user.banned) throw new UnauthorizedException();
    request.userSession = userSession;
    return true;
  }
}

export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<SessionRequest>().userSession!,
);
