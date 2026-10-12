import {
  BadgeIndianRupee,
  BadgePercent,
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
  ReceiptText,
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
  HandCoins,
  MapPinned,
  History,
  MessagesSquare,
} from "lucide-react";
import type { Permission } from "@digitalbahi/core";
import type { TranslationKey } from "@digitalbahi/i18n";
import { allowed } from "../data/db";
import { LIVE } from "../data/source";
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

/** Modules whose screens exist in live mode (the demo preview keeps showing their plan). */
export const LIVE_MODULES: ReadonlySet<PlannedModule> = new Set<PlannedModule>(
  LIVE ? ["schemes", "orders", "payments", "purchases", "suppliers", "inventory", "packing", "dispatch", "reports", "gst", "expenses", "employees", "payroll", "leave", "productReports", "companyReports", "users", "audit", "messages", "notifications", "backup"] : [],
);

/** Roadmap badge for the menu: hidden once the screen exists. */
export function phaseBadge(mod: ModuleDef): number | undefined {
  if (mod.route.name === "planned" && LIVE_MODULES.has(mod.route.module)) return undefined;
  return mod.phase;
}

export const MODULES: ModuleDef[] = [
  { key: "dashboard", label: "nav.dashboard", icon: LayoutDashboard, group: "daily", route: { name: "dashboard" }, permission: "dashboard.view" },
  { key: "invoices", label: "nav.newInvoice", icon: Receipt, group: "daily", route: { name: "invoice-new" }, permission: "invoice.create" },
  { key: "bills", label: "nav.invoices", icon: ReceiptText, group: "daily", route: { name: "invoices" }, permission: "invoice.view" },
  { key: "orders", label: "nav.orders", icon: ClipboardList, group: "daily", route: planned("orders"), permission: "order.view", phase: 3 },
  { key: "customers", label: "nav.customers", icon: Users, group: "daily", route: { name: "customers" }, permission: "customer.view" },
  { key: "payments", label: "nav.payments", icon: Wallet, group: "daily", route: planned("payments"), permission: "payment.view", phase: 3 },
  { key: "outstanding", label: "nav.outstanding", icon: HandCoins, group: "daily", route: { name: "outstanding" }, permission: "customer.view_ledger" },
  { key: "beat", label: "nav.beat", icon: MapPinned, group: "daily", route: { name: "beat" }, permission: "customer.view" },
  { key: "messages", label: "nav.messages", icon: MessagesSquare, group: "daily", route: planned("messages"), permission: "message.send", phase: 5 },

  { key: "products", label: "nav.products", icon: Package, group: "stock", route: { name: "products" }, permission: "product.view" },
  { key: "schemes", label: "nav.schemes", icon: BadgePercent, group: "stock", route: planned("schemes"), permission: "product.view", phase: 3 },
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
  { key: "audit", label: "nav.auditLog", icon: History, group: "admin", route: planned("audit"), permission: "audit.view", phase: 3 },
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

/**
 * Menu entries this person's role opens. The dashboard is everyone's home
 * (it shows each role its own work). In the live app, screens not built yet
 * and the developers' design page stay out of the menu.
 */
export function visibleModules(): ModuleDef[] {
  return MODULES.filter((m) => {
    if (LIVE && m.route.name === "planned" && !LIVE_MODULES.has(m.route.module)) return false;
    if (LIVE && m.route.name === "design-system") return false;
    // The beat comes from the server (routes, calls, what is due): not in the demo.
    if (!LIVE && m.route.name === "beat") return false;
    return m.key === "dashboard" || allowed(m.permission);
  });
}

/** The everyday screens the simple menu keeps (Settings → "Aa" → Simple menu). */
export const SIMPLE_MENU_KEYS: ReadonlySet<string> = new Set(["dashboard", "invoices", "bills", "customers", "payments", "outstanding", "products", "inventory"]);

/** The menu as shown: everything this role opens, or with the simple menu on, only the everyday screens. */
export function menuModules(simple: boolean): ModuleDef[] {
  const all = visibleModules();
  return simple ? all.filter((m) => SIMPLE_MENU_KEYS.has(m.key)) : all;
}

/** The permission a screen needs: what it shows, or for a create screen, what it saves. */
export function routePermission(route: Route): Permission | null {
  switch (route.name) {
    case "login":
    case "dashboard":
      return null;
    case "invoice-view":
      return "invoice.view";
    case "customer":
      return "customer.view";
    case "purchase-new":
      return "purchase.create";
    case "purchase-view":
    case "purchase-list":
    case "purchase-order-view":
    case "goods-receipt-view":
    case "purchase-reorder":
      return "purchase.view";
    case "purchase-order-new":
      return "purchase.order";
    case "goods-receipt-new":
      return "purchase.receive";
    case "supplier":
      return "supplier.view";
    case "order-view":
      return "order.view";
    case "planned":
      if (route.module === "payments" && route.action === "collect") return "payment.collect";
      if (route.module === "payments" && route.action === "pay") return "payment.pay";
      if (route.module === "orders" && route.action === "new") return "order.create";
      return moduleForRoute(route)?.permission ?? null;
    default:
      return moduleForRoute(route)?.permission ?? null;
  }
}

/** Everyone lands on the dashboard: each role sees its own parts there. */
export function homeRoute(): Route {
  return { name: "dashboard" };
}

export function moduleForRoute(route: Route): ModuleDef | undefined {
  if (route.name === "planned") return MODULES.find((m) => m.route.name === "planned" && m.route.module === route.module);
  if (route.name === "customer") return MODULES.find((m) => m.key === "customers");
  if (route.name === "invoice-view") return MODULES.find((m) => m.key === "bills");
  if (["purchase-new", "purchase-view", "purchase-list", "purchase-order-new", "purchase-order-view", "goods-receipt-new", "goods-receipt-view", "purchase-reorder"].includes(route.name)) return MODULES.find((m) => m.key === "purchases");
  if (route.name === "supplier") return MODULES.find((m) => m.key === "suppliers");
  if (route.name === "order-view") return MODULES.find((m) => m.key === "orders");
  return MODULES.find((m) => m.route.name === route.name);
}
