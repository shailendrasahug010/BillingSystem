import {
  BadgeIndianRupee,
  ChartColumn,
  Bell,
  Boxes,
  Building,
  CalendarDays,
  ClipboardList,
  DatabaseBackup,
  FileText,
  LayoutDashboard,
  type LucideIcon,
  Package,
  PackageCheck,
  Palette,
  Receipt,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Truck,
  Users,
  SquareUser,
  Wallet,
  Landmark,
  ChartPie,
  Factory,
} from "lucide-react";
import type { Permission } from "@vyapaar/core";
import type { TranslationKey } from "@vyapaar/i18n";
import type { PlannedModule, Route } from "./router";

/**
 * Module registry. Navigation (sidebar, bottom bar, command palette) is built
 * from this list: adding a module is one entry here plus its screens. Each
 * entry declares the permission needed to see it, so role changes hide menus
 * without code changes.
 */
export interface ModuleDef {
  key: string;
  label: TranslationKey;
  icon: LucideIcon;
  group: "daily" | "stock" | "money" | "people" | "insights" | "admin";
  route: Route;
  permission: Permission;
  /** Roadmap phase for modules not built in the prototype. */
  phase?: 3 | 4 | 5 | 6;
}

const planned = (module: PlannedModule): Route => ({ name: "planned", module });

export const MODULES: ModuleDef[] = [
  { key: "dashboard", label: "nav.dashboard", icon: LayoutDashboard, group: "daily", route: { name: "dashboard" }, permission: "dashboard.view" },
  { key: "invoices", label: "nav.newInvoice", icon: Receipt, group: "daily", route: { name: "invoice-new" }, permission: "invoice.create" },
  { key: "orders", label: "nav.orders", icon: ClipboardList, group: "daily", route: planned("orders"), permission: "order.view", phase: 3 },
  { key: "customers", label: "nav.customers", icon: Users, group: "daily", route: { name: "customers" }, permission: "customer.view" },
  { key: "payments", label: "nav.payments", icon: Wallet, group: "daily", route: planned("payments"), permission: "payment.view", phase: 3 },

  { key: "products", label: "nav.products", icon: Package, group: "stock", route: { name: "products" }, permission: "product.view" },
  { key: "inventory", label: "nav.inventory", icon: Boxes, group: "stock", route: planned("inventory"), permission: "inventory.view", phase: 3 },
  { key: "purchases", label: "nav.purchases", icon: ShoppingCart, group: "stock", route: planned("purchases"), permission: "purchase.view", phase: 3 },
  { key: "suppliers", label: "nav.suppliers", icon: Factory, group: "stock", route: planned("suppliers"), permission: "supplier.view", phase: 3 },
  { key: "packing", label: "nav.packing", icon: PackageCheck, group: "stock", route: planned("packing"), permission: "packing.view", phase: 4 },
  { key: "dispatch", label: "nav.dispatch", icon: Truck, group: "stock", route: planned("dispatch"), permission: "dispatch.view", phase: 4 },

  { key: "gst", label: "nav.gst", icon: Landmark, group: "money", route: planned("gst"), permission: "gst.view", phase: 4 },
  { key: "expenses", label: "nav.expenses", icon: BadgeIndianRupee, group: "money", route: planned("expenses"), permission: "expense.view", phase: 4 },

  { key: "employees", label: "nav.employees", icon: SquareUser, group: "people", route: planned("employees"), permission: "employee.view", phase: 4 },
  { key: "payroll", label: "nav.payroll", icon: FileText, group: "people", route: planned("payroll"), permission: "payroll.view", phase: 4 },
  { key: "leave", label: "nav.leave", icon: CalendarDays, group: "people", route: planned("leave"), permission: "leave.view", phase: 4 },

  { key: "reports", label: "nav.reports", icon: ChartColumn, group: "insights", route: planned("reports"), permission: "report.view_sales", phase: 4 },
  { key: "productReports", label: "nav.productReports", icon: ChartPie, group: "insights", route: planned("productReports"), permission: "report.view_sales", phase: 4 },
  { key: "companyReports", label: "nav.companyReports", icon: Building, group: "insights", route: planned("companyReports"), permission: "report.view_sales", phase: 4 },
  { key: "notifications", label: "nav.notifications", icon: Bell, group: "insights", route: planned("notifications"), permission: "notification.view", phase: 5 },

  { key: "settings", label: "nav.settings", icon: Settings, group: "admin", route: { name: "settings" }, permission: "settings.view" },
  { key: "users", label: "nav.users", icon: ShieldCheck, group: "admin", route: planned("users"), permission: "user.view", phase: 3 },
  { key: "backup", label: "nav.backup", icon: DatabaseBackup, group: "admin", route: planned("backup"), permission: "backup.create", phase: 6 },
  { key: "design", label: "nav.designSystem", icon: Palette, group: "admin", route: { name: "design-system" }, permission: "settings.view" },
];

export const GROUP_LABELS: Record<ModuleDef["group"], TranslationKey> = {
  daily: "nav.groupDaily",
  stock: "nav.groupStock",
  money: "nav.groupMoney",
  people: "nav.groupPeople",
  insights: "nav.groupInsights",
  admin: "nav.groupAdmin",
};

export function moduleForRoute(route: Route): ModuleDef | undefined {
  if (route.name === "planned") return MODULES.find((m) => m.route.name === "planned" && m.route.module === route.module);
  if (route.name === "customer") return MODULES.find((m) => m.key === "customers");
  if (route.name === "invoice-view") return MODULES.find((m) => m.key === "invoices");
  return MODULES.find((m) => m.route.name === route.name);
}
