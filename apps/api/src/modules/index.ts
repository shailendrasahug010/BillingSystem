import { auditLogModule } from "./audit-log.js";
import { businessModule } from "./business/routes.js";
import { catalogMastersModule } from "./catalog/masters.js";
import { productsModule } from "./catalog/products.js";
import { healthModule } from "./health.js";
import { identityModule } from "./identity/routes.js";
import { inventoryModule } from "./inventory/routes.js";
import { invoicesModule } from "./invoices/routes.js";
import { suggestionsModule } from "./invoices/suggestions.js";
import { notesModule } from "./notes/routes.js";
import { partiesModule } from "./parties/routes.js";
import { paymentsModule } from "./payments/routes.js";
import { purchasesModule } from "./purchases/routes.js";
import { dashboardModule } from "./reports/dashboard.js";
import { reportsModule } from "./reports/reports.js";
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
  invoicesModule,
  suggestionsModule,
  purchasesModule,
  inventoryModule,
  paymentsModule,
  notesModule,
  dashboardModule,
  reportsModule,
  searchModule,
];
