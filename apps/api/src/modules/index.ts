import { auditLogModule } from "./audit-log.js";
import { businessModule } from "./business/routes.js";
import { catalogMastersModule } from "./catalog/masters.js";
import { productsModule } from "./catalog/products.js";
import { offlineDocumentsModule } from "./devices/documents.js";
import { devicesModule } from "./devices/routes.js";
import { documentsModule } from "./documents/routes.js";
import { messagingModule } from "./messaging/routes.js";
import { messagingStatusModule } from "./messaging/status-webhook.js";
import { backupsModule } from "./backups/routes.js";
import { expensesModule } from "./expenses/routes.js";
import { gstModule } from "./gst/routes.js";
import { healthModule } from "./health.js";
import { identityModule } from "./identity/routes.js";
import { inventoryModule } from "./inventory/routes.js";
import { ocrModule } from "./imports/ocr.js";
import { importsModule } from "./imports/routes.js";
import { logisticsModule } from "./logistics/routes.js";
import { invoicesModule } from "./invoices/routes.js";
import { suggestionsModule } from "./invoices/suggestions.js";
import { notesModule } from "./notes/routes.js";
import { ordersModule } from "./orders/routes.js";
import { partiesModule } from "./parties/routes.js";
import { employeesModule } from "./people/employees.js";
import { leaveModule } from "./people/leave.js";
import { payrollModule } from "./people/payroll.js";
import { paymentsModule } from "./payments/routes.js";
import { purchaseImportModule } from "./purchases/bill-import.js";
import { purchasesModule } from "./purchases/routes.js";
import { analyticsModule } from "./reports/analytics.js";
import { collectionsModule } from "./reports/collections.js";
import { homeModule } from "./reports/home.js";
import { dashboardModule } from "./reports/dashboard.js";
import { reportsModule } from "./reports/reports.js";
import { reportViewsModule } from "./reports/views.js";
import { searchModule } from "./reports/search.js";
import { teamModule } from "./team/routes.js";
import type { ApiModule } from "./types.js";

/** Registered in order under /api/v1. Adding a module = one import and one entry. */
export const MODULES: ApiModule[] = [
  healthModule,
  identityModule,
  teamModule,
  auditLogModule,
  businessModule,
  catalogMastersModule,
  productsModule,
  partiesModule,
  importsModule,
  ocrModule,
  invoicesModule,
  devicesModule,
  offlineDocumentsModule,
  documentsModule,
  messagingModule,
  messagingStatusModule,
  backupsModule,
  ordersModule,
  logisticsModule,
  suggestionsModule,
  purchasesModule,
  purchaseImportModule,
  inventoryModule,
  paymentsModule,
  collectionsModule,
  homeModule,
  notesModule,
  expensesModule,
  gstModule,
  employeesModule,
  leaveModule,
  payrollModule,
  dashboardModule,
  reportsModule,
  reportViewsModule,
  analyticsModule,
  searchModule,
];
