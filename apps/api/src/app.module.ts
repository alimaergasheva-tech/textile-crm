import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { DbService } from "./db/db.service.ts";
import { AuditService } from "./audit/audit.service.ts";
import { AuthGuard } from "./auth/auth.guard.ts";
import { AuthService } from "./auth/auth.service.ts";
import { AuthController } from "./auth/auth.controller.ts";
import { UsersController } from "./users/users.controller.ts";
import { SettingsController } from "./users/settings.controller.ts";
import { ClientsController } from "./crm/clients.controller.ts";
import { LeadsController } from "./crm/leads.controller.ts";
import { DealsController } from "./crm/deals.controller.ts";
import { TasksController } from "./crm/tasks.controller.ts";
import { CatalogController } from "./catalog/catalog.controller.ts";
import { PricingController } from "./catalog/pricing.controller.ts";
import { QuotesController } from "./catalog/quotes.controller.ts";
import { WarehouseController } from "./warehouse/warehouse.controller.ts";
import { OrdersController } from "./production/orders.controller.ts";
import { ProductionController } from "./production/production.controller.ts";
import { ShipmentsController } from "./production/shipments.controller.ts";
import { ContractorsController } from "./production/contractors.controller.ts";
import { MiniController } from "./miniapp/mini.controller.ts";
import { NotificationsService } from "./miniapp/notifications.service.ts";
import { FeedbackController } from "./feedback/feedback.controller.ts";
import { FeedbackService } from "./feedback/feedback.service.ts";
import { WarehouseJobsService } from "./warehouse/warehouse-jobs.service.ts";
import { PlatformController } from "./platform/platform.controller.ts";
import { ClientPortalController } from "./portal/portal.controller.ts";
import { HealthController } from "./platform/health.controller.ts";
import { ExportController } from "./export/export.controller.ts";
import { ImportController } from "./export/import.controller.ts";
import { FilesController } from "./files/files.controller.ts";

@Module({
  controllers: [AuthController, UsersController, SettingsController, FilesController,
    ClientsController, LeadsController, DealsController, TasksController,
    CatalogController, PricingController, QuotesController, WarehouseController, OrdersController, ProductionController, ShipmentsController, MiniController, FeedbackController, PlatformController, ExportController, ImportController, HealthController, ClientPortalController, ContractorsController],
  providers: [DbService, AuditService, AuthService, NotificationsService, FeedbackService, WarehouseJobsService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
