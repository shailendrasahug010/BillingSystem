import { auditLogModule } from "./audit-log.js";
import { clientErrorsModule } from "./client-errors.js";
import { businessModule } from "./business/routes.js";
import { catalogMastersModule } from "./catalog/masters.js";
import { productsModule } from "./catalog/products.js";
import { offlineDocumentsModule } from "./devices/documents.js";
import { devicesModule } from "./devices/routes.js";
import { documentsModule } from "./documents/routes.js";
import { messagingModule } from "./messaging/routes.js";
import { messagingStatusModule } from "./messaging/status-webhook.js";
import { backupsModule } from "./backups/routes.js";
import { beatsModule } from "./beats/routes.js";
import { expensesModule } from "./expenses/routes.js";
import { eInvoiceModule } from "./gst/einvoice.js";
import { gstModule } from "./gst/routes.js";
import { healthModule } from "./health.js";
import { identityModule } from "./identity/routes.js";
import { inventoryModule } from "./inventory/routes.js";
import { ocrModule } from "./imports/ocr.js";
import { importsModule } from "./imports/routes.js";
import { bankModule } from "./bank/routes.js";
import { tallyModule } from "./tally/routes.js";
import { logisticsModule } from "./logistics/routes.js";
import { invoicesModule } from "./invoices/routes.js";
import { suggestionsModule } from "./invoices/suggestions.js";
import { notesModule } from "./notes/routes.js";
import { notificationsModule } from "./notifications/routes.js";
import { pushModule } from "./push/routes.js";
import { syncPushModule } from "./sync/push.js";
import { syncModule } from "./sync/routes.js";
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
import { insightsModule } from "./reports/insights.js";
import { dashboardModule } from "./reports/dashboard.js";
import { reportsModule } from "./reports/reports.js";
import { reportViewsModule } from "./reports/views.js";
import { searchModule } from "./reports/search.js";
import { teamModule } from "./team/routes.js";
import type { ApiModule } from "./types.js";

/** Registered in order under /api/v1. Adding a module = one import and one entry. */
export const MODULES: ApiModule[] = [
  healthModule,
  clientErrorsModule,
  identityModule,
  teamModule,
  auditLogModule,
  businessModule,
  catalogMastersModule,
  productsModule,
  partiesModule,
  beatsModule,
  importsModule,
  tallyModule,
  bankModule,
  ocrModule,
  invoicesModule,
  devicesModule,
  offlineDocumentsModule,
  documentsModule,
  messagingModule,
  messagingStatusModule,
  notificationsModule,
  pushModule,
  syncModule,
  syncPushModule,
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
  insightsModule,
  notesModule,
  expensesModule,
  gstModule,
  eInvoiceModule,
  employeesModule,
  leaveModule,
  payrollModule,
  dashboardModule,
  reportsModule,
  reportViewsModule,
  analyticsModule,
  searchModule,
];
