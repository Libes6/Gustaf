import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import type * as NodeHttp from "node:http";
import { FailureLimiter, readStartRequest, readTokenRequest } from "./app-sign-in.js";
import { AppSignInService } from "./app-sign-in.service.js";

interface HandoffRequest {
  headers: NodeHttp.IncomingHttpHeaders;
  ip?: string;
}

interface HandoffResponse {
  setHeader(name: string, value: string | string[]): void;
  redirect(status: number, url: string): void;
  status(code: number): HandoffResponse;
  type(contentType: string): HandoffResponse;
  json(body: unknown): void;
  send(body: string): void;
}

// Routes under /v1/auth/app bypass the Better Auth handler (see app.ts). Codes and tokens travel
// only in query strings and bodies, which the request logger never records.
@Controller("v1/auth/app")
export class AppSignInController {
  private readonly failures = new FailureLimiter();

  constructor(private readonly appSignIn: AppSignInService) {}

  @Get("start")
  async start(@Query() query: Record<string, unknown>, @Res() res: HandoffResponse) {
    res.setHeader("cache-control", "no-store");
    const request = readStartRequest(query);
    if (!request.ok) return res.status(400).json({ error: request.error });
    const { redirect, cookies } = await this.appSignIn.start(request.value);
    res.setHeader("set-cookie", cookies);
    res.redirect(302, redirect);
  }

  @Get("done")
  async done(
    @Req() req: HandoffRequest,
    @Query("error") error: unknown,
    @Res() res: HandoffResponse,
  ) {
    res.setHeader("cache-control", "no-store");
    const providerError = error === undefined ? undefined : typeof error === "string" ? error : "";
    const { redirect, cookies } = await this.appSignIn.finish(
      fromNodeHeaders(req.headers),
      providerError,
    );
    res.setHeader("set-cookie", cookies);
    if (redirect) return res.redirect(302, redirect);
    res
      .status(400)
      .type("text/plain")
      .send("Sign-in could not be completed. Return to the Gustaf app and try again.");
  }

  @Post("token")
  @HttpCode(200)
  @Header("cache-control", "no-store")
  async token(@Req() req: HandoffRequest, @Body() body: unknown) {
    const ip = req.ip ?? "unknown";
    if (this.failures.blocked(ip)) throw new HttpException({ error: "rate_limited" }, 429);
    const request = readTokenRequest(body);
    const granted = request && (await this.appSignIn.exchange(request));
    if (!granted) {
      this.failures.fail(ip);
      throw new BadRequestException({ error: request ? "invalid_grant" : "invalid_request" });
    }
    return granted;
  }
}
