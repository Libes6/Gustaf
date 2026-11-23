import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import type * as NodeHttp from "node:http";
import { FailureLimiter } from "../auth/app-sign-in.js";
import { AUTH, type Auth } from "../auth/auth.js";
import type { UserSession } from "../auth/session.guard.js";
import { mutationRejection } from "./admin-rules.js";

export const ADMIN_ORIGINS = Symbol("AdminOrigins");

// Per process and IP, counted before authentication so it also slows down probing.
export const ADMIN_RATE_LIMIT = { requests: 300, windowMs: 60 * 1000 };

interface AdminRequest {
  method: string;
  ip?: string;
  headers: NodeHttp.IncomingHttpHeaders;
  userSession?: UserSession;
}

// Every /v1/admin route: 429 over the rate limit, 401 signed out, 403 not an admin (or a
// mutation failing the CSRF checks). Read with `CurrentSession`.
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly requests = new FailureLimiter(
    ADMIN_RATE_LIMIT.requests,
    ADMIN_RATE_LIMIT.windowMs,
  );

  constructor(
    @Inject(AUTH) private readonly auth: Pick<Auth, "api">,
    @Inject(ADMIN_ORIGINS) private readonly origins: readonly string[],
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const ip = request.ip ?? "unknown";
    if (this.requests.blocked(ip)) throw new HttpException({ error: "rate_limited" }, 429);
    this.requests.fail(ip);
    const userSession = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!userSession) throw new UnauthorizedException();
    if (userSession.user.role !== "admin" || userSession.user.banned) {
      throw new ForbiddenException();
    }
    const rejection = mutationRejection(request, this.origins);
    if (rejection) throw new ForbiddenException(rejection);
    request.userSession = userSession;
    return true;
  }
}
