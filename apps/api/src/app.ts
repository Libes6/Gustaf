import "reflect-metadata";
import * as NodeCrypto from "node:crypto";
import { ConsoleLogger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { readConfig } from "./config.js";
import { DatabaseService } from "./database/database.service.js";
import { HealthController } from "./health.controller.js";

@Module({})
// oxlint-disable-next-line typescript/no-extraneous-class -- Nest requires a decorated module class.
class AppModule {}

export async function createApp(config: ReturnType<typeof readConfig>) {
  const logger = new ConsoleLogger("GustafCloud", { json: true });
  const app = await NestFactory.create<NestExpressApplication>(
    {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: DatabaseService, useFactory: () => new DatabaseService(config.databaseUrl) },
      ],
    },
    { logger, abortOnError: false },
  );
  app.getHttpAdapter().getInstance().disable("x-powered-by");
  app.use(
    (
      req: { method: string },
      res: {
        setHeader: (key: string, value: string) => void;
        statusCode: number;
        once: (event: string, callback: () => void) => void;
      },
      next: () => void,
    ) => {
      const requestId = NodeCrypto.randomUUID();
      res.setHeader("x-request-id", requestId);
      res.once("finish", () =>
        logger.log({ requestId, method: req.method, status: res.statusCode }),
      );
      next();
    },
  );
  app.enableShutdownHooks();
  return app;
}
