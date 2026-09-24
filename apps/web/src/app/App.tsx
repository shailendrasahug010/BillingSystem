import { useEffect, useState } from "react";
import { AppShell } from "../components/layout/AppShell";
import { Dialog } from "../components/ui/Dialog";
import { Kbd } from "../components/ui/misc";
import { ToastProvider } from "../components/ui/Toast";
import { LoginPage } from "../features/auth/LoginPage";
import { CustomerProfilePage } from "../features/customers/CustomerProfilePage";
import { CustomersPage } from "../features/customers/CustomersPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { DesignSystemPage } from "../features/design-system/DesignSystemPage";
import { CreateInvoicePage } from "../features/invoice/CreateInvoicePage";
import { InvoiceViewPage } from "../features/invoice/InvoiceViewPage";
import { PlannedPage } from "../features/planned/PlannedPage";
import { ProductsPage } from "../features/products/ProductsPage";
import { CommandPalette } from "../features/search/CommandPalette";
import { SettingsPage } from "../features/settings/SettingsPage";
import { I18nProvider, useI18n } from "./i18n";
import { RouterProvider, useRouter, type Route } from "./router";
import { GLOBAL_SHORTCUTS, INVOICE_SHORTCUTS, useShortcuts } from "./shortcuts";
import { applyTheme, readTheme } from "./theme";

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
    case "products":
      return <ProductsPage />;
    case "settings":
      return <SettingsPage />;
    case "design-system":
      return <DesignSystemPage />;
    case "planned":
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

function Root() {
  const { route, navigate } = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useShortcuts([
    { id: "search", keys: GLOBAL_SHORTCUTS.search, allowInInputs: true, handler: () => setSearchOpen(true) },
    { id: "invoice", keys: GLOBAL_SHORTCUTS.newInvoice, allowInInputs: true, handler: () => navigate({ name: "invoice-new" }) },
    { id: "order", keys: GLOBAL_SHORTCUTS.newOrder, handler: () => navigate({ name: "planned", module: "orders" }) },
    { id: "purchase", keys: GLOBAL_SHORTCUTS.purchase, handler: () => navigate({ name: "planned", module: "purchases" }) },
    { id: "collection", keys: GLOBAL_SHORTCUTS.collection, handler: () => navigate({ name: "planned", module: "payments" }) },
    { id: "help", keys: "shift+?", handler: () => setHelpOpen(true) },
  ]);

  if (route.name === "login") return <LoginPage />;

  return (
    <AppShell onOpenSearch={() => setSearchOpen(true)} onOpenShortcuts={() => setHelpOpen(true)}>
      <Screen route={route} />
      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </AppShell>
  );
}

export function App() {
  useEffect(() => applyTheme(readTheme()), []);
  return (
    <I18nProvider>
      <RouterProvider>
        <ToastProvider>
          <Root />
        </ToastProvider>
      </RouterProvider>
    </I18nProvider>
  );
}
