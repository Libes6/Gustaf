import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: pg.Pool;
  readonly db;
  private readonly logger = new Logger(DatabaseService.name);

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
      idleTimeoutMillis: 30000,
    });
    this.pool.on("error", () => this.logger.error("Idle database connection failed"));
    this.db = drizzle(this.pool);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
