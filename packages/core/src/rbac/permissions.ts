/**
 * Permission catalogue. Permissions are code-defined (the code checks them);
 * roles are data (the business decides who gets what). The catalogue is synced
 * to the `permissions` table on deploy; default roles are seeded once per
 * business and can then be edited freely.
 *
 * Naming: <module>.<action>. Wildcards: "<module>.*" and "*".
 */
export const PERMISSION_CATALOG = {
  dashboard: ["view", "view_financials"],
  customer: ["view", "create", "update", "delete", "export", "view_ledger"],
  supplier: ["view", "create", "update", "delete", "export", "view_ledger"],
  product: ["view", "create", "update", "delete", "import", "export", "view_cost", "update_price"],
  order: ["view", "create", "update", "confirm", "cancel"],
  invoice: [
    "view",
    "create",
    "update",
    "cancel",
    "print",
    "share",
    "override_price",
    "override_credit_limit",
    "backdate",
  ],
  purchase: ["view", "create", "update", "cancel"],
  packing: ["view", "pack"],
  dispatch: ["view", "dispatch", "deliver"],
  inventory: ["view", "adjust", "transfer", "view_value"],
  payment: ["view", "collect", "pay", "cancel", "allocate"],
  note: ["view", "create", "cancel"],
  expense: ["view", "create", "update", "delete", "approve"],
  employee: ["view", "create", "update", "delete", "view_sensitive"],
  payroll: ["view", "run", "finalize", "pay"],
  leave: ["view", "apply", "approve", "configure"],
  gst: ["view", "export", "lock_period", "file"],
  report: ["view_sales", "view_purchase", "view_collection", "view_outstanding", "view_profit", "view_bi", "export"],
  notification: ["view", "configure"],
  settings: ["view", "update"],
  user: ["view", "invite", "update", "deactivate", "manage_roles"],
  audit: ["view"],
  backup: ["create", "download", "restore", "configure"],
} as const;

export type PermissionModule = keyof typeof PERMISSION_CATALOG;
export type Permission = {
  [M in PermissionModule]: `${M}.${(typeof PERMISSION_CATALOG)[M][number]}`;
}[PermissionModule];

export const ALL_PERMISSIONS: readonly Permission[] = (Object.keys(PERMISSION_CATALOG) as PermissionModule[]).flatMap(
  (module) => PERMISSION_CATALOG[module].map((action) => `${module}.${action}` as Permission),
);

export type Grant = Permission | `${PermissionModule}.*` | "*";

export function hasPermission(grants: Iterable<string>, required: Permission): boolean {
  const module = required.split(".")[0];
  for (const g of grants) {
    if (g === "*" || g === required || g === `${module}.*`) return true;
  }
  return false;
}

export function expandGrants(grants: readonly Grant[]): Permission[] {
  return ALL_PERMISSIONS.filter((p) => hasPermission(grants, p));
}

export interface RoleTemplate {
  key: string;
  name: string;
  nameHi: string;
  description: string;
  grants: readonly Grant[];
}

/** Starting roles seeded for every new business. All are editable afterwards. */
export const DEFAULT_ROLES: readonly RoleTemplate[] = [
  {
    key: "admin",
    name: "Admin",
    nameHi: "एडमिन",
    description: "Full access including users, settings and backups",
    grants: ["*"],
  },
  {
    key: "manager",
    name: "Manager",
    nameHi: "मैनेजर",
    description: "Sales, purchase, inventory, customers and reports",
    grants: [
      "dashboard.*",
      "customer.*",
      "supplier.*",
      "product.*",
      "order.*",
      "invoice.*",
      "purchase.*",
      "packing.*",
      "dispatch.*",
      "inventory.*",
      "payment.*",
      "note.*",
      "expense.*",
      "report.*",
      "notification.view",
      "gst.view",
    ],
  },
  {
    key: "sales",
    name: "Sales Employee",
    nameHi: "सेल्स कर्मचारी",
    description: "Customers, orders and invoices; cannot see purchase cost",
    grants: [
      "dashboard.view",
      "customer.view",
      "customer.create",
      "customer.update",
      "customer.view_ledger",
      "product.view",
      "order.view",
      "order.create",
      "order.update",
      "invoice.view",
      "invoice.create",
      "invoice.print",
      "invoice.share",
      "payment.view",
      "payment.collect",
      "notification.view",
    ],
  },
  {
    key: "accountant",
    name: "Accountant",
    nameHi: "अकाउंटेंट",
    description: "Payments, GST, expenses and reports",
    grants: [
      "dashboard.*",
      "customer.view",
      "customer.view_ledger",
      "supplier.view",
      "supplier.view_ledger",
      "product.view",
      "product.view_cost",
      "invoice.view",
      "invoice.print",
      "purchase.*",
      "payment.*",
      "note.*",
      "expense.*",
      "gst.*",
      "report.*",
      "notification.view",
      "audit.view",
    ],
  },
  {
    key: "warehouse",
    name: "Warehouse Employee",
    nameHi: "गोदाम कर्मचारी",
    description: "Packing, dispatch and stock",
    grants: [
      "product.view",
      "order.view",
      "packing.*",
      "dispatch.*",
      "inventory.view",
      "inventory.adjust",
      "inventory.transfer",
      "purchase.view",
      "notification.view",
    ],
  },
  {
    key: "hr",
    name: "HR",
    nameHi: "एचआर",
    description: "Employees, salary and leave",
    grants: ["employee.*", "payroll.*", "leave.*", "expense.view", "notification.view"],
  },
];
