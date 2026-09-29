import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { PurchaseDraft } from "../features/purchases/billImport";

/**
 * Minimal screen router for the prototype. The production app uses TanStack
 * Router (typed routes, loaders, code-splitting per module); screens only call
 * `navigate(...)`, so swapping the implementation does not touch them.
 */
export type Route =
  | { name: "login" }
  | { name: "dashboard" }
  | { name: "invoice-new"; customerId?: string }
  | { name: "invoice-view"; invoiceId: string }
  | { name: "customers" }
  | { name: "customer"; customerId: string }
  /** Money to collect, by city and route (collectors). */
  | { name: "outstanding" }
  | { name: "products" }
  | { name: "settings" }
  | { name: "design-system" }
  | { name: "purchase-new"; supplierId?: string; draft?: PurchaseDraft }
  | { name: "purchase-view"; purchaseId: string }
  | { name: "supplier"; supplierId: string }
  | { name: "order-view"; orderId: string }
  /** Module screens; live mode renders the real screen, demo mode the plan. */
  | { name: "planned"; module: PlannedModule; action?: "collect" | "pay" | "new"; partyId?: string };

export type PlannedModule =
  | "suppliers"
  | "orders"
  | "purchases"
  | "packing"
  | "dispatch"
  | "inventory"
  | "payments"
  | "employees"
  | "payroll"
  | "leave"
  | "gst"
  | "reports"
  | "productReports"
  | "companyReports"
  | "expenses"
  | "notifications"
  | "users"
  | "audit"
  | "messages"
  | "backup";

interface RouterValue {
  route: Route;
  navigate(route: Route): void;
}

const RouterContext = createContext<RouterValue | null>(null);

/** Top-level screens are reachable by a plain #token so a shared link can open them. */
const HASH_ROUTES: Record<string, Route> = {
  dashboard: { name: "dashboard" },
  invoice: { name: "invoice-new" },
  customers: { name: "customers" },
  outstanding: { name: "outstanding" },
  products: { name: "products" },
  settings: { name: "settings" },
  design: { name: "design-system" },
  login: { name: "login" },
};

function routeFromHash(): Route | null {
  const token = window.location.hash.replace(/^#/, "");
  return HASH_ROUTES[token] ?? null;
}

function hashFor(route: Route): string | null {
  const entry = Object.entries(HASH_ROUTES).find(([, r]) => r.name === route.name);
  return entry ? entry[0] : null;
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() => routeFromHash() ?? { name: "dashboard" });

  const navigate = useCallback((next: Route) => {
    setRoute(next);
    const token = hashFor(next);
    try {
      history.replaceState(null, "", token ? `#${token}` : window.location.pathname);
    } catch {
      /* sandboxed frames may refuse history access */
    }
    window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const onHash = () => {
      const r = routeFromHash();
      if (r) setRoute(r);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return <RouterContext.Provider value={{ route, navigate }}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter must be used inside RouterProvider");
  return ctx;
}
