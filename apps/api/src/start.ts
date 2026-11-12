import { readConfig } from "./config.js";
import { runMigrations } from "./database/migrations.js";

// Container entrypoint: a failed migration exits non-zero before the server listens.
const config = readConfig();
if (config.runMigrations) await runMigrations(config.databaseUrl);
await import("./main.js");
