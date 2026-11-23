import { readConfig } from "../config.js";
import { runMigrations } from "./migrations.js";

await runMigrations(readConfig().databaseUrl);
