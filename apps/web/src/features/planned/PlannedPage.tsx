import { Database, FileCode2, Route as RouteIcon } from "lucide-react";
import { moduleForRoute } from "../../app/modules";
import { useI18n } from "../../app/i18n";
import type { PlannedModule } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";

/** What already exists for each planned module: its tables (migrated) and its API surface (specified). */
const PLAN: Record<PlannedModule, { tables: string[]; endpoints: string[] }> = {
  suppliers: { tables: ["suppliers", "party_ledger_entries", "purchases"], endpoints: ["GET/POST /suppliers", "GET /suppliers/:id/ledger", "GET /suppliers/:id/outstanding"] },
  orders: { tables: ["sales_orders", "sales_order_items", "status_history"], endpoints: ["GET/POST /sales-orders", "POST /sales-orders/:id/transitions", "POST /sales-orders/:id/invoice"] },
  purchases: { tables: ["purchases", "purchase_items", "batches", "stock_ledger", "gst_transactions"], endpoints: ["POST /purchases", "POST /purchases/:id/post", "POST /purchases/:id/cancel", "POST /notes (purchase return)"] },
  packing: { tables: ["packings", "packing_items", "sales_order_items.packed_qty"], endpoints: ["GET /packing/queue", "POST /sales-orders/:id/packings", "GET /packings/:id/slip.pdf"] },
  dispatch: { tables: ["dispatches", "dispatch_orders"], endpoints: ["POST /dispatches", "POST /dispatches/:id/orders/:orderId/deliver", "GET /dispatches/:id/note.pdf"] },
  inventory: { tables: ["stock_ledger", "stock_balances", "stock_adjustments", "stock_transfers", "batches"], endpoints: ["GET /stock", "GET /stock/ledger", "POST /stock/adjustments", "POST /stock/transfers"] },
  payments: { tables: ["payments", "payment_allocations", "payment_accounts", "party_ledger_entries"], endpoints: ["POST /payments (in/out)", "POST /payments/:id/allocations", "POST /payments/:id/cancel", "GET /payments/:id/receipt.pdf"] },
  employees: { tables: ["employees", "departments", "attendance"], endpoints: ["GET/POST /employees", "PATCH /employees/:id", "POST /attendance/bulk"] },
  payroll: { tables: ["payroll_runs", "salary_slips", "salary_slip_lines", "salary_components", "employee_salary_structures", "employee_advances"], endpoints: ["POST /payroll-runs", "POST /payroll-runs/:id/finalize", "GET /salary-slips/:id.pdf"] },
  leave: { tables: ["leave_types", "leave_balances", "leave_requests"], endpoints: ["POST /leave-requests", "POST /leave-requests/:id/decision", "GET /employees/:id/leave-balance"] },
  gst: { tables: ["gst_transactions", "gst_return_periods", "gst_exports", "gst_config", "tax_categories", "tax_rates"], endpoints: ["GET /gst/summary?period=", "GET /gst/hsn-summary", "POST /gst/exports {returnType, period, format}", "POST /gst/periods/:period/lock"] },
  reports: { tables: ["sales_daily_customer", "sales_daily_product", "invoices", "payments"], endpoints: ["GET /reports/sales?groupBy=", "GET /reports/collections", "GET /reports/outstanding/aging", "POST /reports/:id/export"] },
  productReports: { tables: ["sales_daily_product", "stock_ledger", "purchase_items"], endpoints: ["GET /reports/products/:id?from=&to=", "GET /reports/products/movers"] },
  companyReports: { tables: ["sales_daily_product (brand_id)", "brands"], endpoints: ["GET /reports/brands/:id?from=&to="] },
  expenses: { tables: ["expenses", "expense_categories", "files"], endpoints: ["GET/POST /expenses", "POST /files (receipt upload)", "GET /reports/expenses"] },
  notifications: { tables: ["notifications", "reminder_rules", "outbox_events"], endpoints: ["GET /notifications", "POST /notifications/:id/read", "GET /events (SSE)"] },
  users: { tables: ["users", "business_members", "roles", "role_permissions", "permissions", "audit_logs"], endpoints: ["POST /members/invite", "PATCH /roles/:id/permissions", "GET /audit-logs"] },
  audit: { tables: ["audit_logs"], endpoints: ["GET /audit-logs?entityType=&userId=&from=&to="] },
  backup: { tables: ["backups", "files"], endpoints: ["POST /backups", "GET /backups/:id/download", "POST /backups/:id/restore (typed confirmation)"] },
};

export function PlannedPage({ module }: { module: PlannedModule }) {
  const { t } = useI18n();
  const def = moduleForRoute({ name: "planned", module });
  const plan = PLAN[module];
  const name = def ? t(def.label) : module;
  const Icon = def?.icon;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 pt-4">
      <div className="flex items-center gap-3">
        {Icon && (
          <span className="flex size-12 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Icon size={24} />
          </span>
        )}
        <div>
          <h1 className="text-[24px] font-semibold text-ink">{name}</h1>
          <Badge tone="accent">{t("common.comingSoon")} · Phase {def?.phase}</Badge>
        </div>
      </div>
      <Card className="p-5">
        <p className="text-[15px] font-medium text-ink">{t("planned.title", { module: name, phase: `Phase ${def?.phase}` })}</p>
        <p className="mt-2 max-w-prose text-[14px] text-ink-2">{t("planned.body")}</p>
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <p className="eyebrow mb-2 flex items-center gap-1.5">
              <Database size={13} /> PostgreSQL
            </p>
            <ul className="flex flex-col gap-1">
              {plan.tables.map((tb) => (
                <li key={tb} className="font-mono text-[12.5px] text-ink-2">
                  {tb}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="eyebrow mb-2 flex items-center gap-1.5">
              <RouteIcon size={13} /> REST /api/v1
            </p>
            <ul className="flex flex-col gap-1">
              {plan.endpoints.map((e) => (
                <li key={e} className="font-mono text-[12.5px] text-ink-2">
                  {e}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-5 flex items-center gap-1.5 text-[12.5px] text-ink-3">
          <FileCode2 size={14} /> docs/06-screens.md · docs/03-database-design.md · docs/04-api-design.md
        </p>
      </Card>
    </div>
  );
}
