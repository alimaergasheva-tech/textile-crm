import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import pg from "pg";
import { config } from "../config.ts";
import { withTenant } from "./tenant.ts";

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool = new pg.Pool({ connectionString: config.appDatabaseUrl() });
  /** Транзакция с RLS одной фабрики. */
  tx<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTenant(this.pool, tenantId, fn);
  }
  onModuleDestroy() { return this.pool.end(); }
}
