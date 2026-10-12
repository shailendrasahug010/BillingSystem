import { translateError } from "@digitalbahi/i18n";
import { lazy, Suspense, useEffect, useState } from "react";
import { ScreenErrorBoundary } from "../components/ErrorBoundary";
import { AppShell } from "../components/layout/AppShell";
import { PinLockScreen } from "../components/layout/PinLock";
import { Dialog } from "../components/ui/Dialog";
import { Kbd, Skeleton } from "../components/ui/misc";
import { Checkbox } from "../components/ui/Field";
import { ToastProvider } from "../components/ui/Toast";
import { ConfirmProvider } from "../components/ui/Confirm";
import { AuthLayout, AuthPage } from "../features/auth/AuthPage";
import { ServerSetup, useNeedsServer } from "../features/auth/ServerSetup";
import { NativePush } from "../components/NativePush";
import { BusinessPicker } from "../features/auth/BusinessPicker";
import { LoginPage } from "../features/auth/LoginPage";
import { TwoStepRequiredPage } from "../features/auth/TwoStep";
import { UnlockPage } from "../features/auth/UnlockPage";
import { CommandPalette } from "../features/search/CommandPalette";
import { ShopApp, shopKeyFromHash } from "../features/shop/ShopPage";
import { homeRoute, LIVE_MODULES, routePermission } from "./modules";
import { ShieldX } from "lucide-react";
import { EmptyState } from "../components/ui/misc";
import { allowed } from "../data/db";
import { Button } from "../components/ui/Button";
import { useStoreVersion } from "../data/store";
import { LIVE } from "../data/source";
import { setErrorScreen } from "../lib/errorReport";
import { useDeviceStorage } from "../lib/storage";
import { SessionProvider, useSession } from "./session";
import { I18nProvider, useI18n } from "./i18n";
import { RouterProvider, useRouter, type Route } from "./router";
import { GLOBAL_SHORTCUTS, INVOICE_SHORTCUTS, setTallyKeys, TALLY_SHORTCUTS, tallyKeysOn, useShortcuts } from "./shortcuts";

/** Module screens load on first use, so the billing screens start fast on slow connections. */
const CustomerProfilePage = lazy(() => import("../features/customers/CustomerProfilePage").then((m) => ({ default: m.CustomerProfilePage })));
const CustomersPage = lazy(() => import("../features/customers/CustomersPage").then((m) => ({ default: m.CustomersPage })));
const DashboardPage = lazy(() => import("../features/dashboard/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const loadCreateInvoice = () => import("../features/invoice/CreateInvoicePage");
const CreateInvoicePage = lazy(() => loadCreateInvoice().then((m) => ({ default: m.CreateInvoicePage })));
const InvoiceViewPage = lazy(() => import("../features/invoice/InvoiceViewPage").then((m) => ({ default: m.InvoiceViewPage })));
const PlannedPage = lazy(() => import("../features/planned/PlannedPage").then((m) => ({ default: m.PlannedPage })));
const ProductsPage = lazy(() => import("../features/products/ProductsPage").then((m) => ({ default: m.ProductsPage })));
const ProfilePage = lazy(() => import("../features/auth/ProfilePage").then((m) => ({ default: m.ProfilePage })));
const SettingsPage = lazy(() => import("../features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const GstPage = lazy(() => import("../features/gst/GstPage").then((m) => ({ default: m.GstPage })));
const InventoryPage = lazy(() => import("../features/inventory/InventoryPage").then((m) => ({ default: m.InventoryPage })));
const PaymentsPage = lazy(() => import("../features/payments/PaymentsPage").then((m) => ({ default: m.PaymentsPage })));
const PurchaseEntryPage = lazy(() => import("../features/purchases/PurchaseEntryPage").then((m) => ({ default: m.PurchaseEntryPage })));
const InvoicesPage = lazy(() => import("../features/invoice/InvoicesPage").then((m) => ({ default: m.InvoicesPage })));
const PurchasesPage = lazy(() => import("../features/purchases/PurchasesPage").then((m) => ({ default: m.PurchasesPage })));
const PurchaseViewPage = lazy(() => import("../features/purchases/PurchaseViewPage").then((m) => ({ default: m.PurchaseViewPage })));
const PurchaseOrderEntryPage = lazy(() => import("../features/purchases/BuyEntryPage").then((m) => ({ default: m.PurchaseOrderEntryPage })));
const GoodsReceiptEntryPage = lazy(() => import("../features/purchases/BuyEntryPage").then((m) => ({ default: m.GoodsReceiptEntryPage })));
const PurchaseOrderViewPage = lazy(() => import("../features/purchases/BuyViewPages").then((m) => ({ default: m.PurchaseOrderViewPage })));
const GoodsReceiptViewPage = lazy(() => import("../features/purchases/BuyViewPages").then((m) => ({ default: m.GoodsReceiptViewPage })));
const ReorderPage = lazy(() => import("../features/purchases/ReorderPage").then((m) => ({ default: m.ReorderPage })));
const ReportsPage = lazy(() => import("../features/reports/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const SchemesPage = lazy(() => import("../features/schemes/SchemesPage").then((m) => ({ default: m.SchemesPage })));
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
const NotificationsPage = lazy(() => import("../features/notifications/NotificationsPage").then((m) => ({ default: m.NotificationsPage })));
const AuditLogPage = lazy(() => import("../features/audit/AuditLogPage").then((m) => ({ default: m.AuditLogPage })));
const UsersPage = lazy(() => import("../features/users/UsersPage").then((m) => ({ default: m.UsersPage })));
const OutstandingPage = lazy(() => import("../features/outstanding/OutstandingPage").then((m) => ({ default: m.OutstandingPage })));
const BeatPage = lazy(() => import("../features/beats/BeatPage").then((m) => ({ default: m.BeatPage })));
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
    case "invoices":
      return <InvoicesPage />;
    case "invoice-view":
      return <InvoiceViewPage invoiceId={route.invoiceId} print={route.print ?? false} />;
    case "customers":
      return <CustomersPage />;
    case "customer":
      return <CustomerProfilePage customerId={route.customerId} />;
    case "outstanding":
      return <OutstandingPage />;
    case "beat":
      return <BeatPage />;
    case "products":
      return <ProductsPage />;
    case "settings":
      return <SettingsPage />;
    case "profile":
      return <ProfilePage />;
    case "design-system":
      return <DesignSystemPage />;
    case "purchase-new":
      return (
        <PurchaseEntryPage
          key={route.draft?.id ?? route.correctsId ?? route.receiptId ?? route.orderId ?? route.supplierId ?? "new"}
          {...(route.supplierId ? { supplierId: route.supplierId } : {})}
          {...(route.correctsId ? { correctsId: route.correctsId } : {})}
          {...(route.draft ? { draft: route.draft } : {})}
          {...(route.receiptId ? { receiptId: route.receiptId } : {})}
          {...(route.orderId ? { orderId: route.orderId } : {})}
        />
      );
    case "purchase-view":
      return <PurchaseViewPage purchaseId={route.purchaseId} />;
    case "purchase-list":
      return <PurchasesPage key={route.tab} initialTab={route.tab} />;
    case "purchase-order-new":
      return <PurchaseOrderEntryPage key={route.supplierId ?? "new"} {...(route.supplierId ? { supplierId: route.supplierId } : {})} {...(route.lines ? { lines: route.lines } : {})} />;
    case "purchase-order-view":
      return <PurchaseOrderViewPage key={route.purchaseOrderId} purchaseOrderId={route.purchaseOrderId} />;
    case "goods-receipt-new":
      return <GoodsReceiptEntryPage key={route.orderId ?? route.supplierId ?? "new"} {...(route.supplierId ? { supplierId: route.supplierId } : {})} {...(route.orderId ? { orderId: route.orderId } : {})} />;
    case "goods-receipt-view":
      return <GoodsReceiptViewPage key={route.goodsReceiptId} goodsReceiptId={route.goodsReceiptId} />;
    case "purchase-reorder":
      return <ReorderPage key={route.supplierId ?? "all"} {...(route.supplierId ? { supplierId: route.supplierId } : {})} />;
    case "supplier":
      return <SupplierProfilePage supplierId={route.supplierId} />;
    case "order-view":
      return <OrderViewPage key={route.orderId} orderId={route.orderId} />;
    case "planned":
      if (LIVE_MODULES.has(route.module)) {
        switch (route.module) {
          case "schemes":
            return <SchemesPage />;
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
            return <ExpensesPage startNew={route.action === "new"} />;
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
          case "notifications":
            return <NotificationsPage />;
          case "backup":
            return <BackupPage />;
        }
      }
      return <PlannedPage module={route.module} />;
    case "login":
      return null;
  }
}

function ShortcutsDialog({ open, onOpenChange, tally, onTally }: { open: boolean; onOpenChange(v: boolean): void; tally: boolean; onTally(on: boolean): void }) {
  const { t } = useI18n();
  const tallyRows: Array<[string, string]> = [
    [TALLY_SHORTCUTS.payment, t("shortcuts.tally.payment")],
    [TALLY_SHORTCUTS.receipt, t("shortcuts.tally.receipt")],
    [TALLY_SHORTCUTS.expense, t("shortcuts.tally.expense")],
    [TALLY_SHORTCUTS.sales, t("shortcuts.tally.sales")],
    [TALLY_SHORTCUTS.purchase, t("shortcuts.tally.purchase")],
  ];
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
    [INVOICE_SHORTCUTS.saveAndPrint, t("shortcuts.saveAndPrint")],
    ["/", t("shortcuts.focusFilter")],
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
      <div className="mt-4 rounded-2xl border border-line bg-surface-2/50 p-3">
        <Checkbox label={t("shortcuts.tally.toggle")} checked={tally} onChange={onTally} />
        <p className="mt-1 text-[12.5px] text-ink-3">{t("shortcuts.tally.help")}</p>
        {tally && (
          <dl className="mt-2 flex flex-col">
            {tallyRows.map(([k, label]) => (
              <div key={k} className="flex items-center justify-between gap-4 border-b border-line py-1.5 text-[14px] last:border-b-0">
                <dt className="text-ink-2">{label}</dt>
                <dd>
                  <Kbd keys={k} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Dialog>
  );
}

/** Live mode: nothing renders until the session and the business workspace are ready. */
function SessionGate() {
  const session = useSession();
  const i18n = useI18n();
  const { t } = i18n;
  useStoreVersion();
  if (!LIVE || session.status === "ready") return <Root />;
  if (session.status === "signed-out") return <AuthPage />;
  if (session.status === "no-business") return <BusinessPicker />;
  if (session.status === "locked") return <UnlockPage />;
  if (session.status === "two-step") return <TwoStepRequiredPage />;
  const offline = session.status === "error" && session.error?.code === "network";
  return (
    <AuthLayout>
      <div className="flex flex-col gap-4" role="status" aria-live="polite">
        <p className="text-[16px] text-ink-2">
          {offline
            ? t("auth.offlineStart")
            : session.error?.code === "OFFLINE_COPY_EXPIRED"
              ? translateError(i18n, session.error)
              : session.status === "error"
                ? t("auth.loadFailed")
                : t("auth.loadingWorkspace")}
        </p>
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
  const { route, navigate, direction } = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tally, setTally] = useState(tallyKeysOn);
  useDeviceStorage();

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
    // Tally's voucher keys; F-keys type nothing, so they work from any field.
    ...(tally
      ? [
          { id: "tally-payment", keys: TALLY_SHORTCUTS.payment, allowInInputs: true, handler: () => go(LIVE ? { name: "planned", module: "payments", action: "pay" } : { name: "planned", module: "payments" }) },
          { id: "tally-receipt", keys: TALLY_SHORTCUTS.receipt, allowInInputs: true, handler: () => go(LIVE ? { name: "planned", module: "payments", action: "collect" } : { name: "planned", module: "payments" }) },
          { id: "tally-expense", keys: TALLY_SHORTCUTS.expense, allowInInputs: true, handler: () => go({ name: "planned", module: "expenses", action: "new" }) },
          { id: "tally-sales", keys: TALLY_SHORTCUTS.sales, allowInInputs: true, handler: () => go({ name: "invoice-new" }) },
          { id: "tally-purchase", keys: TALLY_SHORTCUTS.purchase, allowInInputs: true, handler: () => go(LIVE ? { name: "purchase-new" } : { name: "planned", module: "purchases" }) },
        ]
      : []),
  ]);

  // The billing screen is the one most used: fetch it once the first screen is up, so F2 opens it at once.
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 2000));
    idle(() => void loadCreateInvoice().catch(() => undefined));
  }, []);

  const needed = routePermission(route);
  const home = homeRoute();
  // Errors sent to the error log say which screen they happened on.
  setErrorScreen(route.name === "planned" ? `${route.module}${"action" in route && route.action ? ` (${route.action})` : ""}` : route.name);
  const blocked = LIVE && needed !== null && !allowed(needed);

  if (route.name === "login") return LIVE ? null : <LoginPage />;

  return (
    <>
      <AppShell onOpenSearch={() => setSearchOpen(true)} onOpenShortcuts={() => setHelpOpen(true)}>
        {/* Each screen rises in as it opens (on a phone, slides in from the side it came from). */}
        <div key={route.name === "planned" ? `planned:${route.module}` : route.name} className={`animate-page screen-${direction}`}>
          <ScreenErrorBoundary>
            <Suspense fallback={<ScreenLoading />}>{blocked ? <NoAccess onHome={() => navigate(home)} /> : <Screen route={route} />}</Suspense>
          </ScreenErrorBoundary>
        </div>
        <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
        <ShortcutsDialog
          open={helpOpen}
          onOpenChange={setHelpOpen}
          tally={tally}
          onTally={(on) => {
            setTallyKeys(on);
            setTally(on);
          }}
        />
        {LIVE && <NativePush />}
      </AppShell>
      <PinLockScreen />
    </>
  );
}

export function App() {
  // The Android app first needs its server's address; nothing reaches the API before.
  const needsServer = useNeedsServer();
  // A shop's order link: its own page, with no sign-in.
  const [shopKey] = useState(() => shopKeyFromHash(window.location.hash));
  if (shopKey)
    return (
      <I18nProvider>
        <ShopApp shopKey={shopKey} />
      </I18nProvider>
    );
  return (
    <I18nProvider>
      {needsServer ? (
        <ServerSetup />
      ) : (
        <SessionProvider>
          <RouterProvider>
            <ToastProvider>
              <ConfirmProvider>
                <SessionGate />
              </ConfirmProvider>
            </ToastProvider>
          </RouterProvider>
        </SessionProvider>
      )}
    </I18nProvider>
  );
}
