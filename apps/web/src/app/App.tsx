import { lazy, Suspense, useState } from "react";
import { AppShell } from "../components/layout/AppShell";
import { Dialog } from "../components/ui/Dialog";
import { Kbd, Skeleton } from "../components/ui/misc";
import { ToastProvider } from "../components/ui/Toast";
import { AuthLayout, AuthPage } from "../features/auth/AuthPage";
import { BusinessPicker } from "../features/auth/BusinessPicker";
import { LoginPage } from "../features/auth/LoginPage";
import { UnlockPage } from "../features/auth/UnlockPage";
import { CustomerProfilePage } from "../features/customers/CustomerProfilePage";
import { CustomersPage } from "../features/customers/CustomersPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { CreateInvoicePage } from "../features/invoice/CreateInvoicePage";
import { InvoiceViewPage } from "../features/invoice/InvoiceViewPage";
import { PlannedPage } from "../features/planned/PlannedPage";
import { ProductsPage } from "../features/products/ProductsPage";
import { CommandPalette } from "../features/search/CommandPalette";
import { SettingsPage } from "../features/settings/SettingsPage";
import { homeRoute, LIVE_MODULES, routePermission } from "./modules";
import { ShieldX } from "lucide-react";
import { EmptyState } from "../components/ui/misc";
import { allowed } from "../data/db";
import { Button } from "../components/ui/Button";
import { useStoreVersion } from "../data/store";
import { LIVE } from "../data/source";
import { SessionProvider, useSession } from "./session";
import { I18nProvider, useI18n } from "./i18n";
import { RouterProvider, useRouter, type Route } from "./router";
import { GLOBAL_SHORTCUTS, INVOICE_SHORTCUTS, useShortcuts } from "./shortcuts";

/** Module screens load on first use, so the billing screens start fast on slow connections. */
const GstPage = lazy(() => import("../features/gst/GstPage").then((m) => ({ default: m.GstPage })));
const InventoryPage = lazy(() => import("../features/inventory/InventoryPage").then((m) => ({ default: m.InventoryPage })));
const PaymentsPage = lazy(() => import("../features/payments/PaymentsPage").then((m) => ({ default: m.PaymentsPage })));
const PurchaseEntryPage = lazy(() => import("../features/purchases/PurchaseEntryPage").then((m) => ({ default: m.PurchaseEntryPage })));
const PurchasesPage = lazy(() => import("../features/purchases/PurchasesPage").then((m) => ({ default: m.PurchasesPage })));
const PurchaseViewPage = lazy(() => import("../features/purchases/PurchaseViewPage").then((m) => ({ default: m.PurchaseViewPage })));
const ReportsPage = lazy(() => import("../features/reports/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const SupplierProfilePage = lazy(() => import("../features/suppliers/SupplierProfilePage").then((m) => ({ default: m.SupplierProfilePage })));
const SuppliersPage = lazy(() => import("../features/suppliers/SuppliersPage").then((m) => ({ default: m.SuppliersPage })));
const OrdersPage = lazy(() => import("../features/orders/OrdersPage").then((m) => ({ default: m.OrdersPage })));
const OrderViewPage = lazy(() => import("../features/orders/OrderViewPage").then((m) => ({ default: m.OrderViewPage })));
const ExpensesPage = lazy(() => import("../features/expenses/ExpensesPage").then((m) => ({ default: m.ExpensesPage })));
const EmployeesPage = lazy(() => import("../features/people/EmployeesPage").then((m) => ({ default: m.EmployeesPage })));
const LeavePage = lazy(() => import("../features/people/LeavePage").then((m) => ({ default: m.LeavePage })));
const PayrollPage = lazy(() => import("../features/people/PayrollPage").then((m) => ({ default: m.PayrollPage })));
const PackingPage = lazy(() => import("../features/logistics/PackingPage").then((m) => ({ default: m.PackingPage })));
const DispatchPage = lazy(() => import("../features/logistics/DispatchPage").then((m) => ({ default: m.DispatchPage })));
const BackupPage = lazy(() => import("../features/backup/BackupPage").then((m) => ({ default: m.BackupPage })));
const MessagesPage = lazy(() => import("../features/messages/MessagesPage").then((m) => ({ default: m.MessagesPage })));
const AuditLogPage = lazy(() => import("../features/audit/AuditLogPage").then((m) => ({ default: m.AuditLogPage })));
const UsersPage = lazy(() => import("../features/users/UsersPage").then((m) => ({ default: m.UsersPage })));
const OutstandingPage = lazy(() => import("../features/outstanding/OutstandingPage").then((m) => ({ default: m.OutstandingPage })));
const DesignSystemPage = lazy(() => import("../features/design-system/DesignSystemPage").then((m) => ({ default: m.DesignSystemPage })));

function ScreenLoading() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case "dashboard":
      return <DashboardPage />;
    case "invoice-new":
      // key: a fresh draft whenever the entry customer changes
      return <CreateInvoicePage key={route.customerId ?? "new"} {...(route.customerId ? { customerId: route.customerId } : {})} />;
    case "invoice-view":
      return <InvoiceViewPage invoiceId={route.invoiceId} />;
    case "customers":
      return <CustomersPage />;
    case "customer":
      return <CustomerProfilePage customerId={route.customerId} />;
    case "outstanding":
      return <OutstandingPage />;
    case "products":
      return <ProductsPage />;
    case "settings":
      return <SettingsPage />;
    case "design-system":
      return <DesignSystemPage />;
    case "purchase-new":
      return <PurchaseEntryPage key={route.draft?.id ?? route.supplierId ?? "new"} {...(route.supplierId ? { supplierId: route.supplierId } : {})} {...(route.draft ? { draft: route.draft } : {})} />;
    case "purchase-view":
      return <PurchaseViewPage purchaseId={route.purchaseId} />;
    case "supplier":
      return <SupplierProfilePage supplierId={route.supplierId} />;
    case "order-view":
      return <OrderViewPage key={route.orderId} orderId={route.orderId} />;
    case "planned":
      if (LIVE_MODULES.has(route.module)) {
        switch (route.module) {
          case "orders":
            return <OrdersPage newOrder={route.action === "new"} {...(route.partyId ? { customerId: route.partyId } : {})} />;
          case "payments":
            return <PaymentsPage {...(route.action === "collect" || route.action === "pay" ? { action: route.action } : {})} {...(route.partyId ? { partyId: route.partyId } : {})} />;
          case "purchases":
            return <PurchasesPage />;
          case "suppliers":
            return <SuppliersPage />;
          case "inventory":
            return <InventoryPage />;
          case "packing":
            return <PackingPage />;
          case "dispatch":
            return <DispatchPage />;
          case "reports":
            return <ReportsPage />;
          case "productReports":
            return <ReportsPage initialTab="products" />;
          case "companyReports":
            return <ReportsPage initialTab="profit" initialGroup="brand" />;
          case "gst":
            return <GstPage />;
          case "expenses":
            return <ExpensesPage />;
          case "employees":
            return <EmployeesPage />;
          case "leave":
            return <LeavePage />;
          case "payroll":
            return <PayrollPage />;
          case "users":
            return <UsersPage />;
          case "audit":
            return <AuditLogPage />;
          case "messages":
            return <MessagesPage />;
          case "backup":
            return <BackupPage />;
        }
      }
      return <PlannedPage module={route.module} />;
    case "login":
      return null;
  }
}

function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const { t } = useI18n();
  const rows: Array<[string, string]> = [
    [GLOBAL_SHORTCUTS.search, t("shortcuts.search")],
    [GLOBAL_SHORTCUTS.newInvoice, t("shortcuts.newInvoice")],
    [GLOBAL_SHORTCUTS.newOrder, t("shortcuts.newOrder")],
    [GLOBAL_SHORTCUTS.purchase, t("shortcuts.purchase")],
    [GLOBAL_SHORTCUTS.collection, t("shortcuts.collection")],
    [INVOICE_SHORTCUTS.focusCustomer, t("shortcuts.focusCustomer")],
    [INVOICE_SHORTCUTS.focusProduct, t("shortcuts.focusProduct")],
    ["alt+1", t("shortcuts.addSuggestion")],
    [INVOICE_SHORTCUTS.save, t("shortcuts.saveInvoice")],
    ["escape", t("shortcuts.closeDialog")],
    ["?", t("shortcuts.help")],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("shortcuts.title")} closeLabel={t("common.close")}>
      <dl className="flex flex-col">
        {rows.map(([k, label]) => (
          <div key={k} className="flex items-center justify-between gap-4 border-b border-line py-2 text-[14px] last:border-b-0">
            <dt className="text-ink-2">{label}</dt>
            <dd>
              <Kbd keys={k} />
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

/** Live mode: nothing renders until the session and the business workspace are ready. */
function SessionGate() {
  const session = useSession();
  const { t } = useI18n();
  useStoreVersion();
  if (!LIVE || session.status === "ready") return <Root />;
  if (session.status === "signed-out") return <AuthPage />;
  if (session.status === "no-business") return <BusinessPicker />;
  if (session.status === "locked") return <UnlockPage />;
  const offline = session.status === "error" && session.error?.code === "network";
  return (
    <AuthLayout>
      <div className="flex flex-col gap-4" role="status" aria-live="polite">
        <p className="text-[16px] text-ink-2">{offline ? t("auth.offlineStart") : session.status === "error" ? t("auth.loadFailed") : t("auth.loadingWorkspace")}</p>
        {session.status === "error" && (
          <div className="flex gap-2">
            <Button variant="primary" onClick={session.retry}>
              {t("common.retry")}
            </Button>
            {!offline && (
              <Button variant="ghost" onClick={() => void session.logout()}>
                {t("auth.signOut")}
              </Button>
            )}
          </div>
        )}
      </div>
    </AuthLayout>
  );
}

/** A screen the role does not include (opened from a link, a bookmark or the address bar). */
function NoAccess({ onHome }: { onHome(): void }) {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={<ShieldX size={22} />}
      title={t("common.noAccess")}
      hint={t("common.noAccessHint")}
      action={<Button onClick={onHome}>{t("common.goHome")}</Button>}
      className="py-20"
    />
  );
}

function Root() {
  const { route, navigate } = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // A shortcut only for what the role may do (the screen would refuse it anyway).
  const go = (to: Route) => {
    const need = routePermission(to);
    if (!need || allowed(need)) navigate(to);
  };
  useShortcuts([
    { id: "search", keys: GLOBAL_SHORTCUTS.search, allowInInputs: true, handler: () => setSearchOpen(true) },
    { id: "invoice", keys: GLOBAL_SHORTCUTS.newInvoice, allowInInputs: true, handler: () => go({ name: "invoice-new" }) },
    { id: "order", keys: GLOBAL_SHORTCUTS.newOrder, handler: () => go(LIVE ? { name: "planned", module: "orders", action: "new" } : { name: "planned", module: "orders" }) },
    { id: "purchase", keys: GLOBAL_SHORTCUTS.purchase, handler: () => go(LIVE ? { name: "purchase-new" } : { name: "planned", module: "purchases" }) },
    { id: "collection", keys: GLOBAL_SHORTCUTS.collection, handler: () => go(LIVE ? { name: "planned", module: "payments", action: "collect" } : { name: "planned", module: "payments" }) },
    { id: "help", keys: "shift+?", handler: () => setHelpOpen(true) },
  ]);

  const needed = routePermission(route);
  const home = homeRoute();
  const blocked = LIVE && needed !== null && !allowed(needed);

  if (route.name === "login") return LIVE ? null : <LoginPage />;

  return (
    <AppShell onOpenSearch={() => setSearchOpen(true)} onOpenShortcuts={() => setHelpOpen(true)}>
      {/* Each screen rises in as it opens. */}
      <div key={route.name === "planned" ? `planned:${route.module}` : route.name} className="animate-page">
        <Suspense fallback={<ScreenLoading />}>{blocked ? <NoAccess onHome={() => navigate(home)} /> : <Screen route={route} />}</Suspense>
      </div>
      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </AppShell>
  );
}

export function App() {
  return (
    <I18nProvider>
      <SessionProvider>
        <RouterProvider>
          <ToastProvider>
            <SessionGate />
          </ToastProvider>
        </RouterProvider>
      </SessionProvider>
    </I18nProvider>
  );
}
