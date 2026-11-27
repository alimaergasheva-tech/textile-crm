import { Controller, Get, Inject } from "@nestjs/common";
import { DbService } from "../db/db.service.ts";
import { Public } from "../rbac/rbac.ts";

/** Проверка для мониторинга: отвечает 200, только если база доступна. */
@Controller()
export class HealthController {
  constructor(@Inject(DbService) private db: DbService) {}
  @Public() @Get("health")
  async health() { await this.db.pool.query("SELECT 1"); return { ok: true }; }
}
