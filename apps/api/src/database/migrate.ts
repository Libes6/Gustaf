import * as NodeURL from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readConfig } from "../config.js";
import { DatabaseService } from "./database.service.js";

const database = new DatabaseService(readConfig().databaseUrl);
try {
  await migrate(database.db, {
    migrationsFolder: NodeURL.fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
} finally {
  await database.onModuleDestroy();
}
