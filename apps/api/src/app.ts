import "reflect-metadata";
import * as NodeCrypto from "node:crypto";
import type * as NodeHttp from "node:http";
import { ConsoleLogger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { toNodeHandler } from "better-auth/node";
import { AccountController } from "./account.controller.js";
import { APP_SIGN_IN_PATH } from "./auth/app-sign-in.js";
import { AppSignInController } from "./auth/app-sign-in.controller.js";
import { AppSignInService } from "./auth/app-sign-in.service.js";
import { AUTH, AUTH_BASE_PATH, type Auth, createAuth } from "./auth/auth.js";
import { SessionGuard } from "./auth/session.guard.js";
import type { AppConfig } from "./config.js";
import { DatabaseService } from "./database/database.service.js";
import { DeviceGuard, DevicesController } from "./devices/devices.controller.js";
import { DevicesService } from "./devices/devices.service.js";
import { HealthController } from "./health.controller.js";
import { OwnershipService } from "./ownership.js";

@Module({})
// oxlint-disable-next-line typescript/no-extraneous-class -- Nest requires a decorated module class.
class AppModule {}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(incoming: string | string[] | undefined) {
  return typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming)
    ? incoming
    : NodeCrypto.randomUUID();
}

export async function createApp(config: Pick<AppConfig, "databaseUrl" | "trustProxy" | "auth">) {
  const logger = new ConsoleLogger("GustafCloud", { json: true });
  const database = {
    provide: DatabaseService,
    useFactory: () => new DatabaseService(config.databaseUrl),
  };
  const accounts = config.auth
    ? {
        controllers: [AccountController, DevicesController, AppSignInController],
        providers: [
          {
            provide: AUTH,
            useFactory: (db: DatabaseService) => createAuth(config.auth!, db),
            inject: [DatabaseService],
          },
          SessionGuard,
          AppSignInService,
          DeviceGuard,
          DevicesService,
          OwnershipService,
        ],
      }
    : { controllers: [], providers: [] };
  const app = await NestFactory.create<NestExpressApplication>(
    {
      module: AppModule,
      controllers: [HealthController, ...accounts.controllers],
      providers: [database, ...accounts.providers],
    },
    { logger, abortOnError: false },
  );
  app.disable("x-powered-by");
  // Coolify's Traefik terminates TLS; this makes req.ip and req.secure reflect the client.
  app.set("trust proxy", config.trustProxy);
  app.use(
    (
      req: {
        method: string;
        secure: boolean;
        headers: Record<string, string | string[] | undefined>;
      },
      res: {
        setHeader: (key: string, value: string) => void;
        statusCode: number;
        once: (event: string, callback: () => void) => void;
      },
      next: () => void,
    ) => {
      const requestId = resolveRequestId(req.headers["x-request-id"]);
      res.setHeader("x-request-id", requestId);
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("x-frame-options", "DENY");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("cross-origin-resource-policy", "same-origin");
      if (req.secure) res.setHeader("strict-transport-security", "max-age=31536000");
      res.once("finish", () =>
        logger.log({ requestId, method: req.method, status: res.statusCode }),
      );
      next();
    },
  );
  if (config.auth) {
    // Better Auth reads the raw body itself, so it is mounted before Nest's JSON parser.
    // The app sign-in handoff is ours and falls through to Nest.
    const authHandler = toNodeHandler(app.get<Auth>(AUTH));
    app
      .getHttpAdapter()
      .getInstance()
      .all(
        `${AUTH_BASE_PATH}/*splat`,
        (
          req: NodeHttp.IncomingMessage & { path: string },
          res: NodeHttp.ServerResponse,
          next: () => void,
        ) => (req.path.startsWith(`${APP_SIGN_IN_PATH}/`) ? next() : authHandler(req, res)),
      );
  }
  app.enableShutdownHooks();
  return app;
}
